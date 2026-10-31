"use server";

import { revalidatePath } from "next/cache";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { envoyerCourriel, transportConfigure } from "@/lib/courriel";
import {
  CANAL_RELANCE,
  destinatairesARelancer,
  sujetRelance,
  texteRelance,
  tracerRelances,
} from "@/lib/relance";
import { joignablesPour } from "@/lib/avis";
import { circuitReglementsPret, listerPenalites } from "@/lib/queries";
import { cotisationsARegler } from "@/lib/penalites";
import { nomFichierReleve, relevePdf } from "@/lib/releve-pdf";
import { listeDesMois } from "@/lib/sortie";
import { debutMois, lienDuSite } from "@/lib/settings";
import { KIND_PENALITE, STATUT_PENALITE } from "@/lib/valeurs";
import type { EtatFormulaire } from "./auth";

const NATURE: Record<string, string> = {
  [KIND_PENALITE.retard]: "Retard de versement",
  [KIND_PENALITE.absence]: "Absence en réunion",
  [KIND_PENALITE.autre]: "Autre",
};

/**
 * Relancer un seul membre, depuis sa ligne du registre.
 *
 * La relance du bureau ecrivait a tous les retardataires d'un coup. Celui qui
 * veut rappeler un membre precis -- apres un appel, une promesse, un versement
 * annonce et jamais arrive -- devait attendre le passage du 10 ou ecrire de sa
 * propre messagerie, sans trace au registre. Le courrier est celui du passage
 * automatique, mot pour mot : le bureau l'a lu avant de l'envoyer. Le bureau
 * est en copie, le releve du membre peut etre joint, et le registre des
 * relances le garde.
 */
export async function relancerMembre(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("relancer");
  const membreId = String(donnees.get("membreId") ?? "");
  const joindre = donnees.get("releve") === "on";

  if (transportConfigure() === "aucun") {
    return { ok: false, erreur: "Aucun transport configuré : aucun courrier ne peut partir." };
  }

  const maintenant = new Date();
  const d = (await destinatairesARelancer(maintenant)).get(membreId);
  if (!d) return { ok: false, erreur: "Rien à réclamer à ce membre aujourd'hui : il est à jour." };
  const email = d.situation.email;
  if (!email) return { ok: false, erreur: `${d.situation.nom} n'a pas d'adresse enregistrée.` };

  /* Le bureau en copie, sauf le membre lui-meme s'il en fait partie. */
  const copie = (await joignablesPour("relancer"))
    .map((b) => b.email)
    .filter((e) => e && e !== email);

  let pieces: { nom: string; contenu: Buffer; type: string }[] | undefined;
  if (joindre) {
    const lignes = await listerPenalites({ membreId, statut: STATUT_PENALITE.due }).catch(() => []);
    /* Ce qui court sans etre encore inscrit figure aussi : le total du releve est celui du courrier. */
    const courues =
      d.nonInscrites.montant > 0
        ? [{
            date: maintenant.toISOString().slice(0, 10),
            nature: "Pénalités courues, pas encore inscrites",
            motif: d.nonInscrites.mois.length > 0 ? listeDesMois(d.nonInscrites.mois) : null,
            montant: d.nonInscrites.montant,
          }]
        : [];
    const contenu = relevePdf({
      nom: d.situation.nom,
      date: maintenant.toISOString().slice(0, 10),
      cellules: d.situation.cellules,
      penalites: [
        ...lignes.map((p) => ({
          date: p.date_constat,
          nature: NATURE[p.nature] ?? p.nature,
          motif: p.motif,
          montant: p.montant,
        })),
        ...courues,
      ],
      cotisationsARegler: cotisationsARegler(d.situation.cellules).total,
      penalitesDues: d.dette.montant + d.nonInscrites.montant,
      verse: d.situation.verse,
    });
    pieces = [{
      nom: nomFichierReleve(d.situation.nom, maintenant.toISOString()),
      contenu,
      type: "application/pdf",
    }];
  }

  const { ok, detail } = await envoyerCourriel({
    destinataire: email,
    copie,
    sujet: sujetRelance(d, debutMois(maintenant), maintenant),
    texte: texteRelance(d, lienDuSite(), maintenant, await circuitReglementsPret()),
    pieces,
  });
  try {
    await tracerRelances([d], ok ? [email] : [], maintenant, CANAL_RELANCE.individuelle);
  } catch {
    // Le registre est un temoin, pas une condition : son echec n'annule pas l'envoi.
  }
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "relance_individuelle",
    { entite: "reminder_log", id: membreId },
    { ok, releve: joindre, detail },
  );
  revalidatePath("/versements");

  if (!ok) return { ok: false, erreur: `Le courriel n'est pas parti : ${detail}` };
  return {
    ok: true,
    message:
      `Relance envoyée à ${d.situation.nom}` +
      (copie.length > 0 ? ", copie au bureau" : "") +
      (joindre ? ", relevé joint." : "."),
  };
}
