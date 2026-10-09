"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerMembre, exigerRole } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { journaliser } from "@/lib/journal";
import {
  derogationsParMembre,
  listerPenalites,
  reglagesEffectifs,
  reglementsPenalite,
  situationsClub,
} from "@/lib/queries";
import {
  imputer,
  imputerPenalites,
  type ImputationPenalite,
  type ReglesMembre,
} from "@/lib/penalites";
import { accorde, fcfa, moisLong } from "@/lib/settings";
import {
  KIND_VERSEMENT,
  METHODE,
  STATUT_PENALITE,
  STATUT_REGLEMENT,
  STATUT_VERSEMENT,
} from "@/lib/valeurs";
import { enregistrerJustificatif } from "@/lib/justificatifs";
import { avertirDeclaration, avertirReglementPenalite } from "@/lib/avis";
import type { EtatFormulaire } from "./auth";

const METHODES = Object.values(METHODE) as string[];

/**
 * Enregistre un versement en caisse.
 *
 * Un membre declare : sa ligne est visible de tous aussitot, et attend la
 * validation du tresorier qui tient la caisse. Le tresorier et le president,
 * eux, saisissent des encaissements deja constates : leur saisie vaut
 * validation. Le journal conserve dans les deux cas qui a saisi et qui a valide.
 *
 * Une avance de plusieurs mois cree une ligne par mois couvert, toutes reliees
 * par un meme batch_id : le suivi reste mensuel sans perdre le fait qu'il s'agit
 * d'un seul versement.
 */
export async function declarerVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const membreCible = String(donnees.get("membreId") ?? auteur.id);
  const reglages = await reglagesEffectifs();
  /*
   * UN SEUL CHAMP : LE MONTANT VERSE.
   *
   * Il y en avait trois -- mois de depart, nombre de mois, montant par mois --
   * pour une information qui n'en est plus une. Les mois se reglent dans
   * l'ordre : le premier mois impute est donc determine, et le montant verse
   * dit le reste. Demander le mois, c'etait demander un choix que la
   * declaration refuse.
   */
  const montant = Math.round(Number(donnees.get("montant") ?? 0));
  /*
   * COTISATION OU PENALITE : C'EST LE MEMBRE QUI LE DIT.
   *
   * Les deux se declaraient a deux endroits, et qui versait les deux en un
   * seul transfert voyait sa penalite rester due sans comprendre pourquoi.
   * Les fusionner supposait de decider ce que l'argent eteint d'abord -- ce
   * que les statuts ne tranchent qu'au 10/01/2027
   * (`penalitesIndissociables`). Le demander lui ote la question : il sait ce
   * qu'il a paye.
   *
   * Dans les deux cas, meme regle et meme circuit : du plus ancien au plus
   * recent, et la validation du tresorier apres declaration.
   */
  const nature = String(donnees.get("nature") ?? "cotisation");
  const dateVersement = String(donnees.get("dateVersement") ?? "").slice(0, 10);
  const mode = String(donnees.get("mode") ?? METHODE.mobileMoney);
  const reference = String(donnees.get("reference") ?? "").trim() || null;
  const note = String(donnees.get("note") ?? "").trim() || null;

  const saisieDirecte = peut(auteur, "saisirVersementValide");
  if (membreCible !== auteur.id && !saisieDirecte) {
    return {
      ok: false,
      erreur: "Seuls le tresorier et le president peuvent enregistrer un versement pour autrui.",
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVersement)) return { ok: false, erreur: "Date de versement invalide." };
  if (!Number.isFinite(montant) || montant <= 0) {
    return { ok: false, erreur: "Indiquez le montant verse." };
  }
  if (!METHODES.includes(mode)) return { ok: false, erreur: "Mode de paiement inconnu." };
  if (nature !== "cotisation" && nature !== "penalite") {
    return { ok: false, erreur: "Precisez s'il s'agit d'une cotisation ou d'une penalite." };
  }

  if (nature === "penalite") {
    return reglerPenalitesDeclarees({
      auteur,
      membreCible,
      montant,
      datePaiement: dateVersement,
      mode,
      reference,
      note,
      donnees,
    });
  }

  const sql = db();

  /*
   * L'IMPUTATION, ET NON UN CHOIX DE MOIS.
   *
   * Les mois se reglent dans l'ordre, du plus ancien au plus recent : la
   * penalite de l'art. 9 court sur le mois impaye, et un mois saute serait une
   * penalite qui court sans fin sur un mois que le membre croit avoir
   * compense en payant le suivant. L'argent recu eteint donc la dette la plus
   * ancienne d'abord, et s'arrete ou il s'epuise -- le dernier mois peut
   * n'etre couvert qu'en partie, puisqu'un mois n'est ferme que lorsqu'il est
   * complet.
   *
   * La repartition est calculee par `imputer`, sur la situation qui sert deja
   * la grille, le releve et la relance : un seul endroit decide de ce qu'un
   * versement couvre.
   *
   * Cela vaut aussi pour le tresorier et le president. Ils constatent un
   * encaissement, mais l'imputation suit la regle du club. Une imputation
   * exceptionnelle passe par la correction, qui exige un motif et laisse une
   * trace.
   */
  const situation = (await situationsClub()).find((s) => s.membreId === membreCible);
  if (!situation) return { ok: false, erreur: "Membre introuvable." };

  const derogations = await derogationsParMembre().catch(() => new Map<string, ReglesMembre>());
  const requis =
    derogations.get(membreCible)?.cotisationMensuelle ?? reglages.cotisationMensuelle;

  /*
   * Ce que chaque mois porte deja, le mois courant compris et les avances
   * aussi : la grille s'arrete au mois courant, l'imputation non.
   */
  const deja = (await sql`
    select to_char(period, 'YYYY-MM-DD') as mois, coalesce(sum(amount), 0)::bigint as total
    from contributions
    where member_id = ${membreCible}::uuid
      and status <> ${STATUT_VERSEMENT.rejete}
    group by period
  `) as { mois: string; total: string | number }[];
  const porte = new Map(deja.map((r) => [r.mois, Number(r.total)]));

  const imputations = imputer(montant, situation.cellules, porte, requis);
  if (imputations.length === 0) {
    return { ok: false, erreur: "Il n'y a aucun mois a regler : tout est deja solde." };
  }
  /*
   * Un montant que 24 mois n'absorbent pas ne doit pas etre tronque en
   * silence : la difference serait encaissee sans etre portee nulle part.
   */
  const impute = imputations.reduce((t, i) => t + i.montant, 0);
  if (impute < montant) {
    return {
      ok: false,
      erreur:
        `Ce montant couvre plus de 24 mois. Declarez ${fcfa(impute)} maintenant, ` +
        "puis le reste en une seconde fois.",
    };
  }
  const mois = imputations.map((i) => i.mois);

  const lot = randomUUID();
  const statut = saisieDirecte ? STATUT_VERSEMENT.valide : STATUT_VERSEMENT.enAttente;
  for (const { mois: m, montant: part } of imputations) {
    await sql`
      insert into contributions
        (member_id, period, kind, amount, paid_on, method, reference, note,
         batch_id, status, declared_by, reviewed_by, reviewed_at)
      values
        (${membreCible}::uuid, ${m}::date, ${KIND_VERSEMENT.cotisation},
         ${part}, ${dateVersement}::date, ${mode}, ${reference}, ${note},
         ${lot}::uuid, ${statut}, ${auteur.id}::uuid,
         ${saisieDirecte ? auteur.id : null}::uuid,
         ${saisieDirecte ? new Date().toISOString() : null}::timestamptz)
    `;
  }

  const pieces = await enregistrerJustificatif(donnees, lot, membreCible, auteur.id);

  /*
   * Une declaration en attente peut dormir des jours si personne n'ouvre le site.
   * L'avis porte l'information a qui doit valider -- inutile quand la saisie vaut
   * deja validation, puisqu'il n'y a alors rien a attendre.
   */
  if (!saisieDirecte) {
    const nomCible =
      membreCible === auteur.id
        ? auteur.nom
        : ((await sql`select full_name from members where id = ${membreCible}::uuid`)[0]
            ?.full_name as string) ?? "Un membre";
    await avertirDeclaration({
      auteurId: auteur.id,
      membreNom: nomCible,
      mois,
      montant,
      avecJustificatif: pieces.joint,
    }).catch(() => 0);
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "declaration_versement",
    { entite: "contributions", id: lot },
    { membreCible, imputations, montantTotal: montant },
  );
  revalidatePath("/", "layout");
  /*
   * LE MEMBRE DOIT LIRE OU SON ARGENT EST ALLE.
   *
   * Il ne choisit plus le mois : il a donc d'autant plus besoin de voir ce que
   * son versement a couvert, et de le voir avant que le tresorier ne valide.
   * Le detail par mois est ecrit en entier -- 5 000 sur juillet, 2 000 sur
   * aout -- et non resume en un nombre de mois, qui cacherait justement le
   * mois partiellement couvert.
   */
  const detail = imputations
    .map((i) => `${fcfa(i.montant)} sur ${moisLong(i.mois)}`)
    .join(", ");
  const objet = `Versement de ${fcfa(montant)} — ${detail}`;
  return {
    ok: true,
    message: saisieDirecte
      ? `${objet}. Enregistre et valide.`
      : `${objet}. En attente de validation par le tresorier.`,
  };
}

/*
 * Le reglement de penalites declare depuis le formulaire des versements.
 *
 * CE N'EST PAS UNE ACTION EXPORTEE, ET CELA COMPTE. Dans un fichier
 * « use server », tout export devient un point d'entree appelable depuis le
 * navigateur. Ce chemin n'a pas de controle de droit propre -- il herite de
 * celui de `declarerVersement` -- et doit donc rester hors d'atteinte.
 *
 * Il ecrit dans `penalty_settlements`, exactement comme la declaration faite
 * depuis la page Penalites : meme table, meme statut d'attente, meme
 * validation du tresorier. Seul le chemin d'acces change.
 */
async function reglerPenalitesDeclarees(p: {
  auteur: { id: string; nom: string };
  membreCible: string;
  montant: number;
  datePaiement: string;
  mode: string;
  reference: string | null;
  note: string | null;
  donnees: FormData;
}): Promise<EtatFormulaire> {
  /*
   * CHACUN NE DECLARE QUE POUR LUI, MEME ICI.
   *
   * La regle vient de la page Penalites et ne doit pas s'affaiblir en passant
   * par un autre formulaire : declarer pour un autre, puis valider sa propre
   * declaration, viderait le controle de son sens. Le tresorier qui constate
   * un encaissement de penalite le solde directement depuis la page
   * Penalites, ou son geste vaut validation -- et ou il est trace comme tel.
   */
  if (p.membreCible !== p.auteur.id) {
    return {
      ok: false,
      erreur:
        "Une penalite ne se declare que pour soi. Pour un autre membre, soldez-la " +
        "depuis la page Penalites : votre saisie y vaut validation.",
    };
  }
  if (p.datePaiement > new Date().toISOString().slice(0, 10)) {
    return { ok: false, erreur: "La date de paiement est dans le futur." };
  }

  const [dues, enAttente] = await Promise.all([
    listerPenalites({ membreId: p.auteur.id, statut: STATUT_PENALITE.due }),
    reglementsPenalite({ membreId: p.auteur.id, statut: STATUT_REGLEMENT.enAttente }),
  ]);
  if (dues.length === 0) {
    return { ok: false, erreur: "Vous n'avez aucune penalite due." };
  }

  const imputations = imputerPenalites(
    p.montant,
    dues.map((d) => ({
      id: d.id,
      quantite: d.quantite,
      montantUnitaire: d.montant_unitaire,
      dateConstat: d.date_constat,
    })),
    new Set(enAttente.map((r) => r.penalite_id)),
  );
  const impute = imputations.reduce((t, i) => t + i.montant, 0);

  if (imputations.length === 0) {
    /*
     * Deux causes, et le membre doit savoir laquelle : un montant trop petit
     * pour une seule penalite, ou des lignes qui attendent toutes le
     * tresorier. Un meme message pour les deux le laisserait reessayer en
     * vain.
     */
    const libres = dues.filter((d) => !enAttente.some((r) => r.penalite_id === d.id));
    if (libres.length === 0) {
      return {
        ok: false,
        erreur:
          "Toutes vos penalites portent deja une declaration en attente : le tresorier " +
          "doit d'abord se prononcer.",
      };
    }
    const plusPetite = Math.min(...libres.map((d) => d.montant_unitaire));
    return {
      ok: false,
      erreur: `Ce montant ne couvre aucune penalite entiere : la plus petite est de ${fcfa(plusPetite)}.`,
    };
  }
  if (impute < p.montant) {
    return {
      ok: false,
      erreur:
        `Une penalite se regle entiere : ce versement en couvre ${fcfa(impute)}. ` +
        `Declarez ${fcfa(impute)}, et gardez la difference pour une cotisation.`,
    };
  }

  const sql = db();
  const lot = randomUUID();
  const posees: ImputationPenalite[] = [];
  for (const i of imputations) {
    try {
      await sql`
        insert into penalty_settlements
          (penalty_id, member_id, quantity, paid_on, method, reference, note, batch_id,
           status, declared_by)
        values (${i.penaliteId}::uuid, ${p.auteur.id}::uuid, ${i.quantite},
                ${p.datePaiement}::date, ${p.mode}, ${p.reference}, ${p.note}, ${lot}::uuid,
                ${STATUT_REGLEMENT.enAttente}, ${p.auteur.id}::uuid)
      `;
      posees.push(i);
    } catch (e) {
      /*
       * Une declaration posee entre-temps sur cette ligne : on passe, sans
       * perdre celles qui ont abouti. Le membre lit ce qui est parti, et peut
       * declarer le reste une fois le tresorier passe.
       */
      if (/penalty_settlements_une_attente_idx/.test(String(e))) continue;
      throw e;
    }
  }
  if (posees.length === 0) {
    return {
      ok: false,
      erreur:
        "Une declaration vient d'etre posee sur ces penalites : rouvrez la page pour voir " +
        "ou vous en etes.",
    };
  }

  const quantite = posees.reduce((t, i) => t + i.quantite, 0);
  const total = posees.reduce((t, i) => t + i.montant, 0);
  const pieces = await enregistrerJustificatif(p.donnees, lot, p.auteur.id, p.auteur.id);
  await avertirReglementPenalite({
    auteurId: p.auteur.id,
    membreNom: p.auteur.nom,
    quantite,
    montant: total,
    avecJustificatif: pieces.joint,
  }).catch(() => 0);

  await journaliser(
    { id: p.auteur.id, nom: p.auteur.nom },
    "declaration_reglement_penalite",
    { entite: "penalty_settlements", id: lot },
    { imputations: posees, montantTotal: total, depuis: "versements" },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      `Reglement de ${fcfa(total)} declare sur ${quantite} ${accorde(quantite, "penalite")}, ` +
      `de la plus ancienne a la plus recente. En attente de validation par le tresorier : ` +
      "les penalites restent dues jusque-la.",
  };
}

/**
 * Validation d'un encaissement : competence du tresorier, qui tient la caisse.
 * Exception necessaire : le tresorier ne valide pas ses propres versements,
 * le president s'en charge pour eviter l'auto-validation.
 */
export async function validerVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("tresorier", "president");
  const id = String(donnees.get("id") ?? "");
  if (!id) return { ok: false, erreur: "Versement introuvable." };

  const sql = db();
  const rows = await sql`select status from contributions where id = ${id}::uuid`;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (v.status !== STATUT_VERSEMENT.enAttente) {
    return { ok: false, erreur: "Ce versement est deja traite." };
  }

  await sql`
    update contributions
    set status = ${STATUT_VERSEMENT.valide}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = null
    where id = ${id}::uuid
  `;
  await journaliser({ id: auteur.id, nom: auteur.nom }, "validation_versement", {
    entite: "contributions",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Versement valide." };
}

export async function rejeterVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("tresorier", "president");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif du rejet." };

  const sql = db();
  const rows = await sql`select id from contributions where id = ${id}::uuid`;
  if (!rows[0]) return { ok: false, erreur: "Versement introuvable." };

  await sql`
    update contributions
    set status = ${STATUT_VERSEMENT.rejete}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = ${motif}
    where id = ${id}::uuid and status = ${STATUT_VERSEMENT.enAttente}
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "rejet_versement",
    { entite: "contributions", id },
    { motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Versement rejete. Le mois redevient disponible." };
}

/**
 * Joint un justificatif a un versement deja declare : on oublie souvent la piece
 * sur le moment, et il ne faut pas avoir a ressaisir le versement pour la fournir.
 */
export async function joindreJustificatif(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const lot = String(donnees.get("lot") ?? "");
  if (!lot) return { ok: false, erreur: "Versement introuvable." };

  const sql = db();
  const rows = await sql`
    select distinct member_id from contributions where batch_id = ${lot}::uuid
  `;
  if (rows.length === 0) return { ok: false, erreur: "Versement introuvable." };

  const membreCible = String(rows[0].member_id);
  if (membreCible !== auteur.id && !peut(auteur, "saisirVersementValide")) {
    return { ok: false, erreur: "Vous ne pouvez joindre une piece qu'a vos propres versements." };
  }

  const resultat = await enregistrerJustificatif(donnees, lot, membreCible, auteur.id);
  if (!resultat.joint) {
    return { ok: false, erreur: `Justificatif non enregistre : ${resultat.motif ?? "aucun fichier"}.` };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "justificatif_joint",
    { entite: "payment_proofs", id: lot },
    { membreCible },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Justificatif joint." };
}

/** R3 : le membre declare son retard au groupe ; la trace est conservee ici. */
export async function declarerRetard(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const membreCible = String(donnees.get("membreId") ?? auteur.id);
  const mois = String(donnees.get("mois") ?? "").slice(0, 10);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (membreCible !== auteur.id && auteur.role !== "president") {
    return { ok: false, erreur: "Seul le president peut enregistrer la declaration d'un autre membre." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mois)) return { ok: false, erreur: "Mois invalide." };

  try {
    const sql = db();
    await sql`
      insert into late_declarations (member_id, period, note, created_by)
      values (${membreCible}::uuid, ${mois}::date, ${note}, ${auteur.id}::uuid)
      on conflict (member_id, period) do update set note = excluded.note
    `;
  } catch {
    return {
      ok: false,
      erreur:
        "La table des declarations n'existe pas encore. Executez scripts/migration-r3.sql dans la console Neon.",
    };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "declaration_retard",
    { entite: "late_declarations" },
    { membreCible, mois },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Retard declare. Le benefice du plan de redressement (R5) est preserve." };
}

/* ------------------------------------------------- reprise d'une ligne close */

/** Ce qu'une reprise peut toucher, et comment le dire en clair dans la trace. */
const CHAMPS_REPRISE = [
  { nom: "montant", libelle: "montant" },
  { nom: "dateVersement", libelle: "date de versement" },
  { nom: "mois", libelle: "mois couvert" },
  { nom: "mode", libelle: "mode de paiement" },
  { nom: "reference", libelle: "reference" },
] as const;

/**
 * Corrige une ligne de versement, y compris deja validee.
 *
 * Une erreur de saisie etait jusqu'ici definitive : un montant faux, un mois
 * errone, et la caisse restait fausse pour toujours. Rien dans les statuts ne
 * l'exige -- c'etait une lacune de l'outil, non une regle du club.
 *
 * La correction n'efface pas : elle laisse la trace de l'etat anterieur dans la
 * note de revue et au journal, et exige un motif. Une ecriture close se reprend
 * a visage decouvert.
 */
export async function corrigerVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  if (!peut(auteur, "corrigerVersement")) {
    return { ok: false, erreur: "La correction d'un versement revient au tresorier et au president." };
  }

  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!id) return { ok: false, erreur: "Versement introuvable." };
  if (!motif) return { ok: false, erreur: "Indiquez le motif de la correction." };

  const sql = db();
  const rows = await sql`
    select id, member_id, amount, status,
           to_char(paid_on, 'YYYY-MM-DD') as paid_on,
           to_char(period, 'YYYY-MM-DD') as period,
           method, reference, review_note
    from contributions where id = ${id}::uuid
  `;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (v.status === STATUT_VERSEMENT.rejete) {
    return { ok: false, erreur: "Cette ligne est rejetee : le mois est libre, saisissez-la a nouveau." };
  }

  const montant = Math.round(Number(donnees.get("montant") ?? 0));
  const dateVersement = String(donnees.get("dateVersement") ?? "").slice(0, 10);
  const mois = String(donnees.get("mois") ?? "").slice(0, 10);
  const mode = String(donnees.get("mode") ?? "");
  const reference = String(donnees.get("reference") ?? "").trim();

  if (!Number.isFinite(montant) || montant <= 0) {
    return { ok: false, erreur: "Le montant doit etre positif." };
  }
  if (!dateVersement || !mois) return { ok: false, erreur: "Date et mois sont requis." };
  if (!METHODES.includes(mode)) return { ok: false, erreur: "Mode de paiement inconnu." };

  /*
   * Deplacer une ligne sur un mois deja couvert creerait un double comptage
   * silencieux : le mois paraitrait paye deux fois, et la caisse enflerait.
   */
  if (mois !== v.period) {
    const occupe = await sql`
      select id from contributions
      where member_id = ${v.member_id}::uuid
        and period = ${mois}::date
        and status <> ${STATUT_VERSEMENT.rejete}
        and id <> ${id}::uuid
      limit 1
    `;
    if (occupe.length > 0) {
      return { ok: false, erreur: `${moisLong(mois)} est deja couvert pour ce membre.` };
    }
  }

  const avant = {
    montant: Number(v.amount),
    dateVersement: String(v.paid_on),
    mois: String(v.period),
    mode: String(v.method),
    reference: (v.reference as string | null) ?? "",
  };
  const apres = { montant, dateVersement, mois, mode, reference };

  const changements = CHAMPS_REPRISE.filter((c) => String(avant[c.nom]) !== String(apres[c.nom])).map(
    (c) => `${c.libelle} ${avant[c.nom] || "(vide)"} → ${apres[c.nom] || "(vide)"}`,
  );
  if (changements.length === 0) {
    return { ok: false, erreur: "Aucun changement : les valeurs proposees sont celles enregistrees." };
  }

  const trace = `Corrige le ${new Date().toISOString().slice(0, 10)} par ${auteur.nom} : ${changements.join(", ")}. Motif : ${motif}`;
  const note = v.review_note ? `${v.review_note}\n${trace}` : trace;

  await sql`
    update contributions
    set amount = ${montant}, paid_on = ${dateVersement}::date, period = ${mois}::date,
        method = ${mode}, reference = ${reference === "" ? null : reference},
        reviewed_by = ${auteur.id}::uuid, reviewed_at = now(), review_note = ${note}
    where id = ${id}::uuid
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "correction_versement",
    { entite: "contributions", id },
    { avant, apres, motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: `Versement corrige : ${changements.join(", ")}.` };
}

/**
 * Annule une ligne deja validee : le mois redevient libre.
 *
 * Pour l'encaissement qui n'a jamais eu lieu, ou porte deux fois. Le rejet
 * ordinaire ne vise que les lignes en attente ; celle-ci est close, et son
 * annulation demande le meme motif ecrit.
 */
export async function annulerVersementValide(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  if (!peut(auteur, "corrigerVersement")) {
    return { ok: false, erreur: "L'annulation d'un versement revient au tresorier et au president." };
  }

  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif de l'annulation." };

  const sql = db();
  const rows = await sql`
    select amount, to_char(period, 'YYYY-MM-DD') as period, status, review_note
    from contributions where id = ${id}::uuid
  `;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (v.status === STATUT_VERSEMENT.rejete) {
    return { ok: false, erreur: "Cette ligne est deja annulee." };
  }

  const trace = `Annule le ${new Date().toISOString().slice(0, 10)} par ${auteur.nom}. Motif : ${motif}`;
  await sql`
    update contributions
    set status = ${STATUT_VERSEMENT.rejete}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = ${v.review_note ? `${v.review_note}\n${trace}` : trace}
    where id = ${id}::uuid
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "annulation_versement",
    { entite: "contributions", id },
    { montant: Number(v.amount), mois: String(v.period), motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: `Versement annule : ${moisLong(String(v.period))} redevient disponible.` };
}
