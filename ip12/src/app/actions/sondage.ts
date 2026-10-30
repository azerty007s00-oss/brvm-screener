"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit, exigerMembre } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { envoyerAlertes } from "@/lib/alertes";
import {
  courrielConvocation,
  enregistrerReponse,
  participants,
  reponsesDu,
  sondageParId,
} from "@/lib/sondage";
import {
  STATUT_SONDAGE,
  alerteCalee,
  decompte,
  jourCourt,
  jourEnClair,
  jourRetenu,
  joursSaisis,
  momentEnClair,
  nomDuMois,
} from "@/lib/calendrier-reunions";
import type { EtatFormulaire } from "./auth";

/** Un membre coche ses jours, ou dit qu'aucun ne lui va. */
export async function repondreSondage(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const sondage = await sondageParId(String(donnees.get("sondageId") ?? ""));
  if (!sondage) return { ok: false, erreur: "Sondage introuvable." };
  if (sondage.statut !== STATUT_SONDAGE.ouvert || new Date() >= sondage.cloture) {
    return { ok: false, erreur: "Le sondage est clos : le président fixe maintenant la date." };
  }
  if (!(await participants()).some((m) => m.id === membre.id)) {
    return { ok: false, erreur: "Seuls les membres en activité répondent au sondage." };
  }

  const aucun = donnees.get("aucun") === "1";
  const jours = aucun ? [] : joursSaisis(donnees.getAll("jour").map(String));
  if (!aucun && jours.length === 0) return { ok: false, erreur: "Cochez au moins un jour, ou touchez « Aucun jour ne me va »." };

  await enregistrerReponse(sondage.id, membre.id, jours);
  revalidatePath("/reunions");
  revalidatePath("/");
  const mois = sondage.mois.slice(0, 8);
  return {
    ok: true,
    message:
      (jours.length === 0
        ? "Noté : aucun jour ne vous va."
        : `${jours.length > 1 ? "Vos jours sont enregistrés" : "Votre jour est enregistré"} : ${jours
            .map((j) => jourCourt(`${mois}${String(j).padStart(2, "0")}`))
            .join(", ")}.`) + ` Vous pouvez changer d'avis jusqu'au ${momentEnClair(sondage.cloture)}.`,
  };
}

/**
 * Le president fixe le jour, l'heure et le lieu : la seance s'inscrit dans
 * Reunions, et tout le monde est prevenu.
 *
 * Valide aussi un sondage encore ouvert (le president n'a pas a attendre la
 * cloture si tout le monde a repondu), et corrige une date deja fixee : la
 * seance est deplacee, et chacun recoit la nouvelle date.
 */
export async function validerDateReunion(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("fixerDateReunion");
  const sondage = await sondageParId(String(donnees.get("sondageId") ?? ""));
  if (!sondage) return { ok: false, erreur: "Sondage introuvable." };

  const jour = String(donnees.get("jour") ?? "");
  if (!sondage.jours.includes(jour)) return { ok: false, erreur: "Choisissez un jour entre le 10 et le 17." };
  const heure = String(donnees.get("heure") ?? "").trim().slice(0, 20);
  if (heure === "") return { ok: false, erreur: "Indiquez l'heure de la réunion." };
  const lieu = String(donnees.get("lieu") ?? "").trim().slice(0, 160) || null;

  const sql = db();
  const titre = `Réunion de ${nomDuMois(sondage.mois)}`;
  const note = `À ${heure}${lieu ? `, ${lieu}` : ""}.`;

  /*
   * La seance : celle que ce sondage a deja creee, sinon celle que le
   * secretaire aurait saisie a la main ce jour-la, sinon une nouvelle.
   */
  let reunionId = sondage.reunionId;
  if (reunionId) {
    await sql`update meetings set meeting_date = ${jour}::date, title = ${titre}, note = ${note} where id = ${reunionId}::uuid`;
  } else {
    const existante = await sql`select id::text as id from meetings where meeting_date = ${jour}::date limit 1`;
    if (existante.length > 0) {
      reunionId = String(existante[0].id);
      await sql`update meetings set title = coalesce(title, ${titre}), note = ${note} where id = ${reunionId}::uuid`;
    } else {
      const cree = await sql`
        insert into meetings (meeting_date, title, note, created_by)
        values (${jour}::date, ${titre}, ${note}, ${auteur.id}::uuid) returning id::text as id
      `;
      reunionId = String(cree[0].id);
    }
  }

  const deplacee = sondage.statut === STATUT_SONDAGE.valide && sondage.jourChoisi !== jour;
  const memeChose =
    sondage.statut === STATUT_SONDAGE.valide && !deplacee && sondage.heure === heure && sondage.lieu === lieu;
  await sql`
    update meeting_polls
    set status = ${STATUT_SONDAGE.valide}, chosen_day = ${jour}::date, meeting_id = ${reunionId}::uuid,
        meeting_time = ${heure}, place = ${lieu}, validated_by = ${auteur.id}::uuid, validated_at = now(),
        eve_sent_at = case when chosen_day = ${jour}::date then eve_sent_at else null end
    where id = ${sondage.id}::uuid
  `;

  const reponses = await reponsesDu(sondage.id);
  const comptes = decompte(sondage.jours, reponses);
  const retenu = jourRetenu(comptes);
  const disponibles = comptes.find((c) => c.jour === jour)?.n ?? 0;

  await journaliser({ id: auteur.id, nom: auteur.nom }, "date_reunion", { entite: "meeting_polls", id: sondage.id }, {
    jour,
    heure,
    lieu,
    disponibles,
    majorite: retenu?.jour ?? null,
    deplacee,
  });

  if (!memeChose) {
    after(async () => {
      try {
        const gens = await participants();
        await envoyerAlertes(
          gens.map((m) => m.id),
          {
            ...alerteCalee(jour, heure, retenu !== null && retenu.n === disponibles),
            url: "/reunions",
            etiquette: `sondage-${sondage.mois}`,
          },
        );
        await courrielConvocation(gens, sondage.mois, jour, heure, lieu, disponibles);
      } catch {
        // La seance est inscrite ; un avis perdu se rattrape par la page Reunions.
      }
    });
  }

  revalidatePath("/", "layout");
  return {
    ok: true,
    message: memeChose
      ? "Rien n'a changé."
      : `${deplacee ? "Réunion déplacée" : "Date fixée"} : ${jourEnClair(jour)} à ${heure}. Les membres sont prévenus par alerte et par courriel.`,
  };
}
