"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit, exigerMembre } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { avertirReglementPenalite } from "@/lib/avis";
import { enregistrerJustificatif } from "@/lib/justificatifs";
import { porterRetardsAuRegistre, resumeConstat } from "@/lib/constat";
import { absencesParMembre, reglagesEffectifs } from "@/lib/queries";
import { dateCourte } from "@/lib/settings";
import { tranchesAbsence } from "@/lib/penalites";
import {
  KIND_PENALITE, METHODE, STATUT_PENALITE, STATUT_REGLEMENT, libelleMode,
} from "@/lib/valeurs";
import type { EtatFormulaire } from "./auth";

const NATURES = Object.values(KIND_PENALITE) as string[];
const METHODES = Object.values(METHODE) as string[];

/** Identifiant stable d'une penalite de retard : rend le constat idempotent. */

/** Constat declenche a la main, hors relance : la logique vit dans `lib/constat`. */
export async function constaterPenalitesRetard(
  _precedent: EtatFormulaire,
  _donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const issue = await porterRetardsAuRegistre(auteur.id);

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "constat_penalites",
    { entite: "penalties" },
    { ...issue },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: resumeConstat(issue) };
}

/** Identifiant stable d'une tranche d'absences : rend le constat idempotent. */
const cleAbsence = (membreId: string, rang: number) => `absence:${membreId}:${rang}`;

/**
 * Constate les penalites d'absence : une tranche d'absences injustifiees, une penalite.
 *
 * Le decompte part de la feuille de presence et d'elle seule. Justifier une absence
 * consiste a la passer en « excuse » sur la seance concernee -- c'est l'office du
 * secretaire -- ce qui la retire du compte penalisable.
 *
 * Rejouable : chaque tranche porte son rang en cle, un nouveau constat n'ajoute que
 * celles qui manquent. Une tranche devenue infondee parce qu'une absence a ete
 * excusee apres coup n'est pas supprimee d'office : une penalite portee au registre
 * se leve par une annulation motivee, non par un effacement silencieux. Le compte
 * rendu la signale pour qu'elle soit reprise a la main.
 */
export async function constaterPenalitesAbsence(
  _precedent: EtatFormulaire,
  _donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const sql = db();
  const [absences, reglages] = await Promise.all([absencesParMembre(), reglagesEffectifs()]);

  let creees = 0;
  let intactes = 0;
  let infondees = 0;

  for (const a of absences) {
    const tranches = tranchesAbsence(a.injustifiees, reglages);

    for (const t of tranches) {
      const cle = cleAbsence(a.membreId, t.rang);
      const existante = await sql`select id from penalties where source_key = ${cle} limit 1`;
      if (existante.length > 0) {
        intactes++;
        continue;
      }

      /*
       * La penalite nait le jour de l'absence qui a ferme la tranche, non le jour
       * du constat : c'est cette date que le registre doit porter, sans quoi toutes
       * les tranches d'un rattrapage sembleraient nees le meme jour.
       */
      const naissance = a.datesInjustifiees[t.absenceDeclenchante - 1] ?? null;
      const motif = `Absence en reunion — ${t.absenceDeclenchante} absences injustifiees (tranche ${t.rang})`;

      if (naissance) {
        await sql`
          insert into penalties (member_id, kind, quantity, unit_amount, reason,
                                 incurred_on, status, created_by, source_key, auto)
          values (${a.membreId}::uuid, ${KIND_PENALITE.absence}, 1, ${t.montant}, ${motif},
                  ${naissance}::date, ${STATUT_PENALITE.due}, ${auteur.id}::uuid, ${cle}, true)
        `;
      } else {
        await sql`
          insert into penalties (member_id, kind, quantity, unit_amount, reason,
                                 status, created_by, source_key, auto)
          values (${a.membreId}::uuid, ${KIND_PENALITE.absence}, 1, ${t.montant}, ${motif},
                  ${STATUT_PENALITE.due}, ${auteur.id}::uuid, ${cle}, true)
        `;
      }
      creees++;
    }

    // Tranches portees au registre que la feuille de presence ne justifie plus.
    const auDela = await sql`
      select count(*)::int as nb from penalties
      where member_id = ${a.membreId}::uuid
        and kind = ${KIND_PENALITE.absence}
        and status = ${STATUT_PENALITE.due}
        and source_key like ${`absence:${a.membreId}:%`}
    `;
    infondees += Math.max(0, Number(auDela[0]?.nb ?? 0) - tranches.length);
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "constat_absences",
    { entite: "penalties" },
    { creees, intactes, infondees },
  );
  revalidatePath("/", "layout");

  const reste =
    infondees > 0
      ? ` ${infondees} tranche${infondees > 1 ? "s" : ""} au registre n'${infondees > 1 ? "ont" : "a"} plus de fondement depuis qu'une absence a ete excusee : a annuler a la main.`
      : "";

  if (creees === 0) {
    return { ok: true, message: `Aucune nouvelle tranche d'absences a constater.${reste}` };
  }
  return {
    ok: true,
    message: `${creees} penalite${creees > 1 ? "s" : ""} d'absence constatee${creees > 1 ? "s" : ""}.${reste}`,
  };
}

/** Penalite saisie a la main : absence en reunion, ou tout autre motif. */
export async function ajouterPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const membreId = String(donnees.get("membreId") ?? "");
  const nature = String(donnees.get("nature") ?? KIND_PENALITE.autre);
  const quantite = Math.max(1, Number(donnees.get("quantite") ?? 1));
  const montantUnitaire = Number(donnees.get("montantUnitaire") ?? 0);
  const motif = String(donnees.get("motif") ?? "").trim() || null;
  const dateConstat = String(donnees.get("dateConstat") ?? "").slice(0, 10);

  if (!membreId) return { ok: false, erreur: "Membre introuvable." };
  if (!NATURES.includes(nature)) return { ok: false, erreur: "Nature de penalite inconnue." };
  if (!Number.isFinite(montantUnitaire) || montantUnitaire <= 0) {
    return { ok: false, erreur: "Montant invalide." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateConstat)) return { ok: false, erreur: "Date invalide." };

  const sql = db();
  await sql`
    insert into penalties (member_id, kind, quantity, unit_amount, reason,
                           incurred_on, status, created_by, auto)
    values (${membreId}::uuid, ${nature}, ${Math.round(quantite)}, ${Math.round(montantUnitaire)},
            ${motif}, ${dateConstat}::date, ${STATUT_PENALITE.due}, ${auteur.id}::uuid, false)
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "penalite_manuelle",
    { entite: "penalties" },
    { membreId, nature, montant: Math.round(quantite) * Math.round(montantUnitaire) },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Penalite enregistree." };
}

/**
 * Solde tout ou partie d'une ligne de penalite.
 *
 * DEUX CHEMINS Y MENENT, ET UN SEUL CODE LES SERT : le tresorier qui constate un
 * encaissement de lui-meme, et la validation de ce qu'un membre a declare. Deux
 * ecritures separees auraient fini par diverger -- l'une scindant la ligne, l'autre
 * l'amputant -- et le club n'aurait plus su ce qu'il restait dû.
 *
 * Rend le nombre reellement soldé, ou un message d'erreur : l'appelant decide de
 * ce qu'il en dit.
 */
async function soldeLigne(
  id: string,
  quantiteDemandee: number | null,
  auteurId: string,
  note: string | null,
): Promise<{ ok: true; quantite: number; reste: number; montant: number } | { ok: false; erreur: string }> {
  const sql = db();
  const lignes = (await sql`
    select member_id, kind, quantity, unit_amount, reason, created_by,
           to_char(incurred_on, 'YYYY-MM-DD') as incurred_on
    from penalties
    where id = ${id}::uuid and status = ${STATUT_PENALITE.due}
  `) as {
    member_id: string;
    kind: string;
    quantity: number;
    unit_amount: number | string;
    reason: string | null;
    created_by: string;
    incurred_on: string;
  }[];
  if (lignes.length === 0) return { ok: false, erreur: "Penalite introuvable ou deja soldee." };

  const ligne = lignes[0];
  const restant = Number(ligne.quantity);
  const unitaire = Number(ligne.unit_amount);

  /*
   * Une quantite illisible arrete tout.
   *
   * Sans ce controle, un `restant` a NaN traversait la garde qui suit -- toute
   * comparaison avec NaN est fausse, y compris « quantite > restant » -- et la
   * ligne partait en reglement partiel avec une quantite impossible. Mieux vaut
   * refuser d'agir que d'ecrire un nombre qui n'en est pas un.
   */
  if (!Number.isInteger(restant) || restant < 1) {
    return { ok: false, erreur: "Quantite de la penalite illisible : rien n'a ete modifie." };
  }

  /*
   * Un membre en retard de onze mois ne solde pas ses onze penalites d'un coup :
   * il en regle quatre, puis progressivement le reste. Sans quantite, la ligne
   * entiere passait reglee, et le club croyait encaisse ce qu'il attendait
   * encore.
   */
  const quantite = quantiteDemandee ?? restant;
  if (!Number.isInteger(quantite) || quantite < 1 || quantite > restant) {
    return {
      ok: false,
      erreur: `Indiquez un nombre entier entre 1 et ${restant} : c'est ce qui reste dû sur cette ligne.`,
    };
  }

  if (quantite === restant) {
    const faites = await sql`
      update penalties
      set status = ${STATUT_PENALITE.payee}, settled_on = current_date,
          settlement_note = ${note}, resolved_by = ${auteurId}::uuid, resolved_at = now()
      where id = ${id}::uuid and status = ${STATUT_PENALITE.due} and quantity = ${restant}
      returning id
    `;
    if (faites.length === 0) {
      return { ok: false, erreur: "La ligne a change entre-temps : rouvrez la page et reprenez." };
    }
    return { ok: true, quantite, reste: 0, montant: quantite * unitaire };
  }

  /*
   * Reglement partiel : la ligne est scindee plutot qu'amputee. Ce qui est paye
   * devient une ligne soldee, ce qui reste demeure dû sur l'originale. Les
   * totaux, qui multiplient la quantite par le montant unitaire, tombent juste
   * sans qu'aucune colonne ait a etre ajoutee -- et l'historique garde la trace
   * de chaque encaissement, avec sa date.
   */
  const reste = restant - quantite;
  const ajuste = await sql`
    update penalties set quantity = ${reste}
    where id = ${id}::uuid and status = ${STATUT_PENALITE.due} and quantity = ${restant}
    returning id
  `;
  if (ajuste.length === 0) {
    return { ok: false, erreur: "La ligne a change entre-temps : rouvrez la page et reprenez." };
  }
  await sql`
    insert into penalties
      (member_id, kind, quantity, unit_amount, reason, incurred_on, status,
       settled_on, settlement_note, created_by, resolved_by, resolved_at)
    values (${ligne.member_id}::uuid, ${ligne.kind}, ${quantite}, ${unitaire},
            ${ligne.reason}, ${ligne.incurred_on}::date, ${STATUT_PENALITE.payee},
            current_date, ${note}, ${ligne.created_by}::uuid, ${auteurId}::uuid, now())
  `;
  return { ok: true, quantite, reste, montant: quantite * unitaire };
}

export async function reglerPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  const note = String(donnees.get("note") ?? "").trim() || null;
  const saisie = String(donnees.get("quantite") ?? "").trim();

  const issue = await soldeLigne(id, saisie === "" ? null : Number(saisie), auteur.id, note);
  if (!issue.ok) return { ok: false, erreur: issue.erreur };

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    issue.reste === 0 ? "reglement_penalite" : "reglement_partiel_penalite",
    { entite: "penalties", id },
    { quantite: issue.quantite, restant: issue.reste, montant: issue.montant },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      issue.reste === 0
        ? `Penalite soldee : ${issue.quantite} mois regle(s).`
        : `${issue.quantite} mois regle(s). Il reste ${issue.reste} mois dû(s) sur cette ligne.`,
  };
}

export async function annulerPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif de l'annulation." };

  const sql = db();
  const rows = await sql`
    update penalties
    set status = ${STATUT_PENALITE.annulee}, settlement_note = ${motif},
        resolved_by = ${auteur.id}::uuid, resolved_at = now()
    where id = ${id}::uuid and status = ${STATUT_PENALITE.due}
    returning id
  `;
  if (rows.length === 0) return { ok: false, erreur: "Penalite introuvable ou deja soldee." };

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "annulation_penalite",
    { entite: "penalties", id },
    { motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Penalite annulee." };
}

/**
 * Remet une penalite en dû.
 *
 * Une ligne marquee reglee, ou annulee, etait definitive : ni le reglement ni
 * l'annulation ne se reprenaient. Une erreur de manipulation du tresorier --
 * la mauvaise ligne cochee, le mauvais membre -- restait donc inscrite pour
 * toujours, et la seule issue etait d'inventer une penalite compensatoire qui
 * n'avait jamais ete constatee.
 *
 * Le retour en dû efface la trace du reglement sur la ligne, jamais la ligne
 * elle-meme : l'etat d'ou l'on revient part au journal avec le motif et le nom.
 */
export async function rouvrirPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez pourquoi cette penalite redevient due." };

  const sql = db();
  const rows = (await sql`
    update penalties
    set status = ${STATUT_PENALITE.due}, settled_on = null, settlement_note = null,
        resolved_by = null, resolved_at = null
    where id = ${id}::uuid and status <> ${STATUT_PENALITE.due}
    returning id, quantity, unit_amount
  `) as { id: string; quantity: number; unit_amount: number | string }[];
  if (rows.length === 0) {
    return { ok: false, erreur: "Penalite introuvable, ou deja due : il n'y a rien a reprendre." };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "reouverture_penalite",
    { entite: "penalties", id },
    { motif, quantite: rows[0].quantity, montant: Number(rows[0].unit_amount) * rows[0].quantity },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Penalite remise en dû." };
}

/* ------------------------------------ reglement declare par le membre */

/**
 * Le membre declare avoir regle une penalite.
 *
 * POURQUOI CE CHEMIN EXISTE. La relance reclamait des penalites, et le mode
 * d'emploi qui la suit n'expliquait que la declaration d'une cotisation : « le
 * mois couvert », qu'une penalite n'a pas. Un membre qui payait ses penalites par
 * mobile money n'avait donc rien a toucher -- il ecrivait au groupe, et le
 * tresorier saisissait a sa place, precisement ce que l'outil devait supprimer.
 *
 * LA PENALITE NE BOUGE PAS. La declaration s'inscrit a cote ; la ligne reste
 * `due`. Rien n'entre en caisse sur parole, la dette annoncee par la relance ne
 * baisse pas, et le seuil de R5 tient. C'est la validation du tresorier, et elle
 * seule, qui solde -- par le meme code que son constat direct.
 */
export async function declarerReglementPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const penaliteId = String(donnees.get("penaliteId") ?? "");
  const saisie = String(donnees.get("quantite") ?? "").trim();
  const datePaiement = String(donnees.get("datePaiement") ?? "").slice(0, 10);
  const mode = String(donnees.get("mode") ?? METHODE.mobileMoney);
  const reference = String(donnees.get("reference") ?? "").trim() || null;
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!penaliteId) return { ok: false, erreur: "Penalite introuvable." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePaiement)) return { ok: false, erreur: "Date de paiement invalide." };
  if (!METHODES.includes(mode)) return { ok: false, erreur: "Mode de paiement inconnu." };
  if (datePaiement > new Date().toISOString().slice(0, 10)) {
    return { ok: false, erreur: "La date de paiement est dans le futur." };
  }

  const sql = db();
  const lignes = (await sql`
    select member_id, quantity, unit_amount
    from penalties where id = ${penaliteId}::uuid and status = ${STATUT_PENALITE.due}
  `) as { member_id: string; quantity: number; unit_amount: number | string }[];
  if (lignes.length === 0) {
    return { ok: false, erreur: "Cette penalite n'est plus due : rouvrez la page." };
  }
  const ligne = lignes[0];

  /*
   * Chacun ne declare que pour lui. Le tresorier et le president n'ont pas
   * besoin de ce chemin : ils constatent directement, leur saisie valant
   * validation -- et declarer pour un autre leur permettrait de valider ensuite
   * leur propre declaration.
   */
  if (String(ligne.member_id) !== auteur.id) {
    return { ok: false, erreur: "Vous ne pouvez declarer que le reglement de vos propres penalites." };
  }

  const restant = Number(ligne.quantity);
  if (!Number.isInteger(restant) || restant < 1) {
    return { ok: false, erreur: "Quantite de la penalite illisible : signalez-le au tresorier." };
  }
  const quantite = saisie === "" ? restant : Number(saisie);
  if (!Number.isInteger(quantite) || quantite < 1 || quantite > restant) {
    return {
      ok: false,
      erreur: `Indiquez un nombre entier entre 1 et ${restant} : c'est ce qui reste dû sur cette ligne.`,
    };
  }

  const lot = randomUUID();
  try {
    await sql`
      insert into penalty_settlements
        (penalty_id, member_id, quantity, paid_on, method, reference, note, batch_id,
         status, declared_by)
      values (${penaliteId}::uuid, ${auteur.id}::uuid, ${quantite}, ${datePaiement}::date,
              ${mode}, ${reference}, ${note}, ${lot}::uuid,
              ${STATUT_REGLEMENT.enAttente}, ${auteur.id}::uuid)
    `;
  } catch (e) {
    /*
     * L'index unique n'accepte qu'une declaration en attente par ligne : deux
     * declarations concurrentes feraient solder deux fois la meme quantite. Le
     * refus se dit en clair plutot qu'en erreur de base.
     */
    if (/penalty_settlements_une_attente_idx/.test(String(e))) {
      return {
        ok: false,
        erreur: "Une declaration est deja en attente sur cette penalite : le tresorier doit d'abord se prononcer.",
      };
    }
    throw e;
  }

  const pieces = await enregistrerJustificatif(donnees, lot, auteur.id, auteur.id);
  await avertirReglementPenalite({
    auteurId: auteur.id,
    membreNom: auteur.nom,
    quantite,
    montant: quantite * Number(ligne.unit_amount),
    avecJustificatif: pieces.joint,
  }).catch(() => 0);

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "declaration_reglement_penalite",
    { entite: "penalty_settlements", id: penaliteId },
    { quantite, montant: quantite * Number(ligne.unit_amount) },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      `Reglement de ${quantite} penalite(s) declare — en attente de validation par le tresorier. ` +
      "La penalite reste due jusque-la.",
  };
}

/** Le tresorier valide la declaration : c'est ce geste, et lui seul, qui solde. */
export async function validerReglementPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  if (!id) return { ok: false, erreur: "Declaration introuvable." };

  const sql = db();
  const lignes = (await sql`
    select r.penalty_id, r.member_id, r.quantity, r.declared_by,
           to_char(r.paid_on, 'YYYY-MM-DD') as paid_on, r.method
    from penalty_settlements r
    where r.id = ${id}::uuid and r.status = ${STATUT_REGLEMENT.enAttente}
  `) as {
    penalty_id: string; member_id: string; quantity: number;
    declared_by: string; paid_on: string; method: string;
  }[];
  if (lignes.length === 0) return { ok: false, erreur: "Declaration introuvable ou deja examinee." };
  const declaration = lignes[0];

  /*
   * Personne ne valide sa propre declaration, meme titulaire du droit : le
   * tresorier qui declare depuis son compte de membre voit sa ligne examinee par
   * le president. La regle vaut deja pour les versements ; elle vaut ici pour la
   * meme raison -- un encaissement se constate a deux.
   */
  if (String(declaration.declared_by) === auteur.id) {
    return {
      ok: false,
      erreur: "Vous ne pouvez pas valider votre propre declaration : le president s'en charge.",
    };
  }

  const note = `Regle le ${dateCourte(declaration.paid_on)} par ${libelleMode(declaration.method)}, declare par le membre`;
  const issue = await soldeLigne(
    String(declaration.penalty_id),
    Number(declaration.quantity),
    auteur.id,
    note,
  );
  if (!issue.ok) return { ok: false, erreur: issue.erreur };

  await sql`
    update penalty_settlements
    set status = ${STATUT_REGLEMENT.validee}, reviewed_by = ${auteur.id}::uuid, reviewed_at = now()
    where id = ${id}::uuid
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "validation_reglement_penalite",
    { entite: "penalty_settlements", id },
    { quantite: issue.quantite, restant: issue.reste, montant: issue.montant },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      issue.reste === 0
        ? `Reglement valide : penalite soldee (${issue.quantite}).`
        : `Reglement valide : ${issue.quantite} regle(s), il reste ${issue.reste} dû(s).`,
  };
}

/** Refus : la penalite reste due, et le membre sait pourquoi. */
export async function rejeterReglementPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim() || null;
  if (!id) return { ok: false, erreur: "Declaration introuvable." };

  const sql = db();
  const faites = await sql`
    update penalty_settlements
    set status = ${STATUT_REGLEMENT.rejetee}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = ${motif}
    where id = ${id}::uuid and status = ${STATUT_REGLEMENT.enAttente}
    returning penalty_id
  `;
  if (faites.length === 0) return { ok: false, erreur: "Declaration introuvable ou deja examinee." };

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "refus_reglement_penalite",
    { entite: "penalty_settlements", id },
    { motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Declaration refusee : la penalite reste due." };
}
