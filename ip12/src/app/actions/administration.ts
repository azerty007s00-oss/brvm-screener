"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { descriptionTransport, envoyerCourriel, transportConfigure } from "@/lib/courriel";
import {
  dejaRelancesAujourdhui,
  destinatairesDuJour,
  envoyerRelances,
  tracerRelances,
} from "@/lib/relance";
import { versionDeployee } from "@/lib/version";
import { envoyerCourrielSortie } from "@/lib/avis";
import {
  courrielCorrectionSortie,
  courrielSortie,
  courrielValorisation,
  empreinteSortie,
  lignesNouvellesParts,
  lignesPartage,
  lignesValeurDeLaPart,
  lignesValorisation,
  nomDeLaPart,
  pointsAVerifier,
  premierMoisDeLaPart,
} from "@/lib/sortie";
import { partagerSortie, type Rachat } from "@/lib/perf";
import { porterRetardsAuRegistre, resumeConstat, type IssueConstat } from "@/lib/constat";
import {
  decomptesSortie,
  faitsAvantSortie,
  listerMembres,
  rachatsDisponibles,
  reglagesEffectifs,
  situationsClub,
} from "@/lib/queries";
import { CLUB, REGLES, dateCourte, debutMois, decalerMois, fcfa, moisLong, variable } from "@/lib/settings";
import {
  KIND_PENALITE,
  KIND_VERSEMENT,
  METHODE,
  CATEGORIE_PENALITES_SORTANT,
  PREFIXE_SOLDE_SORTIE,
  REGLE_MEMBRE,
  SENS_CAISSE,
  STATUT_CAISSE,
  STATUT_PENALITE,
  STATUT_VERSEMENT,
} from "@/lib/valeurs";
import type { EtatFormulaire } from "./auth";

/**
 * Reprise de l'historique : marque payes tous les mois decouverts jusqu'au mois
 * choisi.
 *
 * Sans elle, un club qui cotise depuis 2023 demarre avec chaque membre en retard
 * de quarante mois, et il faudrait des centaines de saisies pour retablir la
 * verite. La date retenue est l'echeance de chaque mois, jamais aujourd'hui :
 * antidater au 10 evite de creer des penalites fictives sur du passe regle.
 *
 * Rejouable : un mois deja couvert, meme par une declaration en attente, n'est
 * jamais double. Chaque membre n'est repris qu'a partir de son adhesion.
 */
export async function reprendreHistorique(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReglages");
  const jusqua = String(donnees.get("jusqua") ?? "");
  const depuis = String(donnees.get("depuis") ?? CLUB.dateCreation.slice(0, 7));
  const reglages = await reglagesEffectifs();
  const montant = Number(donnees.get("montant") ?? reglages.cotisationMensuelle);

  if (!/^\d{4}-\d{2}$/.test(jusqua)) return { ok: false, erreur: "Mois de fin invalide." };
  if (!/^\d{4}-\d{2}$/.test(depuis)) return { ok: false, erreur: "Mois de début invalide." };
  if (!Number.isFinite(montant) || montant <= 0) return { ok: false, erreur: "Montant invalide." };

  const moisDebut = `${depuis}-01`;
  const moisFin = `${jusqua}-01`;
  if (moisFin < moisDebut) return { ok: false, erreur: "Le mois de fin précède le mois de début." };
  if (moisFin > debutMois()) return { ok: false, erreur: "On ne reprend pas l'avenir." };

  const membres = await listerMembres();
  if (membres.length === 0) return { ok: false, erreur: "Aucun membre actif." };

  /*
   * Chaque membre peut avoir sa propre borne : sur une meme annee, l'un a verse
   * douze mois et l'autre sept. Une reprise uniforme effacerait les retards de
   * ceux qui ont le moins verse. A defaut de precision, la borne commune
   * s'applique.
   */
  const idsMembres: string[] = [];
  const moisCouverts: string[] = [];
  const bornes: string[] = [];
  for (const m of membres) {
    const propre = String(donnees.get(`jusqua_${m.id}`) ?? "").trim();
    const finMembre = /^\d{4}-\d{2}$/.test(propre) ? `${propre}-01` : moisFin;
    if (finMembre > debutMois()) {
      return { ok: false, erreur: `La borne de ${m.nom} est dans l'avenir.` };
    }
    if (finMembre < moisDebut) {
      return { ok: false, erreur: `La borne de ${m.nom} précède le premier mois du club.` };
    }

    const debutMembre = `${m.date_adhesion.slice(0, 8)}01`;
    let mois = debutMembre > moisDebut ? debutMembre : moisDebut;
    let compte = 0;
    while (mois <= finMembre) {
      idsMembres.push(m.id);
      moisCouverts.push(mois);
      mois = decalerMois(mois, 1);
      compte++;
    }
    if (compte > 0) bornes.push(`${m.nom} jusqu'à ${moisLong(finMembre)}`);
  }
  if (idsMembres.length === 0) return { ok: false, erreur: "Aucun mois à reprendre sur cette période." };

  const lot = randomUUID();
  const sql = db();
  // Une seule requete pour l'ensemble : 380 allers-retours HTTP seraient interminables.
  const crees = await sql`
    insert into contributions
      (member_id, period, kind, amount, paid_on, method, note,
       batch_id, status, declared_by, reviewed_by, reviewed_at)
    select u.membre, u.mois, ${KIND_VERSEMENT.cotisation}, ${Math.round(montant)},
           (u.mois + (${reglages.jourEcheance} - 1))::date,
           ${METHODE.especes}, 'Reprise de l''historique',
           ${lot}::uuid, ${STATUT_VERSEMENT.valide},
           ${auteur.id}::uuid, ${auteur.id}::uuid, now()
    from unnest(${idsMembres}::uuid[], ${moisCouverts}::date[]) as u(membre, mois)
    where not exists (
      select 1 from contributions c
      where c.member_id = u.membre
        and c.period = u.mois
        and c.status <> ${STATUT_VERSEMENT.rejete}
    )
    returning id
  `;

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "reprise_historique",
    { entite: "contributions", id: lot },
    { depuis, jusqua, montant: Math.round(montant), crees: crees.length, bornes },
  );
  revalidatePath("/", "layout");

  if (crees.length === 0) {
    return {
      ok: true,
      message: `Rien à reprendre : tous les mois jusqu'à ${moisLong(moisFin)} sont déjà couverts.`,
    };
  }
  return {
    ok: true,
    message:
      `${crees.length} mois marqués payés jusqu'à ${moisLong(moisFin)}, ` +
      `dates à l'échéance du ${reglages.jourEcheance} pour n'engendrer aucune pénalité.`,
  };
}

/** Reglages du club conserves en base, qui priment sur les constantes des statuts. */
export async function enregistrerReglages(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReglages");
  const couples: [string, string][] = [
    ["cotisation_mensuelle", String(donnees.get("cotisation") ?? "")],
    ["jour_echeance", String(donnees.get("jourEcheance") ?? "")],
    ["taux_penalite", String(donnees.get("tauxPenalite") ?? "")],
  ];

  const sql = db();
  const retenus: string[] = [];
  for (const [cle, brut] of couples) {
    const valeur = Number(brut);
    if (!brut || !Number.isFinite(valeur) || valeur <= 0) continue;
    if (cle === "jour_echeance" && (valeur < 1 || valeur > 28)) {
      return { ok: false, erreur: "Le jour d'échéance doit tomber entre le 1 et le 28." };
    }
    if (cle === "taux_penalite" && valeur > 1) {
      return { ok: false, erreur: "Le taux de pénalité s'exprime en fraction : 0,1 pour 10 %." };
    }
    // Pas d'`on conflict` : la cle primaire de `settings` n'est pas connue avec
    // certitude, et un test explicite donne le meme resultat sans rien supposer.
    const existe = await sql`select 1 from settings where key = ${cle} limit 1`;
    if (existe.length > 0) {
      await sql`update settings set value = ${String(valeur)}, updated_at = now() where key = ${cle}`;
    } else {
      await sql`insert into settings (key, value) values (${cle}, ${String(valeur)})`;
    }
    retenus.push(cle);
  }

  if (retenus.length === 0) return { ok: false, erreur: "Aucune valeur exploitable." };
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "modification_reglages",
    { entite: "settings" },
    { retenus },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      "Réglages enregistrés. Ils priment désormais sur les valeurs des statuts inscrites dans le code.",
  };
}

/**
 * Reprise des penalites anterieures, telles que le tresorier les a constatees.
 *
 * Ces montants ne peuvent pas naitre du calcul : une fois l'historique repris,
 * tous les mois passes portent la date de leur echeance, donc sont a l'heure. Le
 * retard reel de l'epoque n'est connu que du tresorier, qui l'a suivi a la main.
 *
 * Une ligne par membre, portant le nombre de mois en quantite -- c'est ainsi que
 * le tresorier les annonce, et cela reste lisible. Rejouable : la ligne d'un
 * membre est remplacee, jamais dupliquee, tant qu'elle n'a pas ete soldee.
 */
export async function reprendrePenalites(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const jusqua = String(donnees.get("jusqua") ?? "");
  if (!/^\d{4}-\d{2}$/.test(jusqua)) {
    return { ok: false, erreur: "Indiquez jusqu'à quel mois le décompte du trésorier s'arrête." };
  }
  if (`${jusqua}-01` > debutMois()) return { ok: false, erreur: "On ne reprend pas l'avenir." };

  const reglages = await reglagesEffectifs();
  const montantUnitaire = Math.round(reglages.cotisationMensuelle * reglages.tauxPenalite);
  // La borne : au-dela, le constat automatique prend le relais.
  const borne = `${jusqua}-${String(reglages.jourEcheance).padStart(2, "0")}`;
  const membres = await listerMembres();
  const sql = db();

  let inscrites = 0;
  let remplacees = 0;
  let total = 0;

  for (const m of membres) {
    const brut = donnees.get(`mois_${m.id}`);
    const mois = Math.round(Number(brut ?? 0));
    if (!Number.isFinite(mois) || mois <= 0) continue;
    if (mois > 200) return { ok: false, erreur: `Nombre de mois invraisemblable pour ${m.nom}.` };

    const cle = `reprise_penalites:${m.id}`;
    const motif =
      `Pénalités constatées par le trésorier : ${mois} mois, arrêtées à ${moisLong(`${jusqua}-01`)}`;
    const existante = await sql`
      select id, status from penalties where source_key = ${cle} limit 1
    `;

    if (existante.length > 0 && existante[0].status === STATUT_PENALITE.due) {
      await sql`
        update penalties
        set quantity = ${mois}, unit_amount = ${montantUnitaire}, reason = ${motif},
            incurred_on = ${borne}::date
        where id = ${existante[0].id}::uuid
      `;
      remplacees++;
    } else if (existante.length === 0) {
      await sql`
        insert into penalties (member_id, kind, quantity, unit_amount, reason,
                               incurred_on, status, created_by, source_key, auto)
        values (${m.id}::uuid, ${KIND_PENALITE.retard}, ${mois}, ${montantUnitaire}, ${motif},
                ${borne}::date, ${STATUT_PENALITE.due}, ${auteur.id}::uuid, ${cle}, false)
      `;
      inscrites++;
    } else {
      continue; // deja soldee : on n'y revient pas
    }
    total += mois * montantUnitaire;
  }

  if (inscrites === 0 && remplacees === 0) {
    return { ok: false, erreur: "Aucun nombre de mois renseigné." };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "reprise_penalites",
    { entite: "penalties" },
    { inscrites, remplacees, total, jusqua },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      `${inscrites + remplacees} membre(s), ${total.toLocaleString("fr-FR")} FCFA de pénalités ` +
      `au registre, arrêtées à ${moisLong(`${jusqua}-01`)}` +
      `${remplacees > 0 ? `, dont ${remplacees} mise(s) à jour` : ""}. ` +
      `Le constat automatique ne recomptera aucun mois antérieur.`,
  };
}

/* --------------------------------------------------- regles individuelles (R5) */

const NATURES_REGLE = Object.values(REGLE_MEMBRE) as string[];

/** Natures qui pesent sur un calcul, et exigent donc une valeur chiffree. */
const NATURES_CHIFFREES: string[] = [
  REGLE_MEMBRE.cotisationParticuliere,
  REGLE_MEMBRE.multiplicateurPenalite,
  REGLE_MEMBRE.avanceMinimale,
];

/**
 * Inscrit une derogation au regime commun pour un membre.
 *
 * Les statuts valent pour tous ; le club peut neanmoins convenir d'une cotisation
 * differente, majorer les penalites d'un membre sous sanction, ou accorder le plan
 * de redressement que R5 reserve au retard declare. Ces accords se prenaient
 * jusqu'ici de memoire : les inscrire les rend opposables et datables.
 *
 * La fenetre compte autant que la regle : une derogation sans fin est un regime
 * parallele durable, qu'il vaut mieux avoir voulu que subi.
 */
export async function inscrireRegleMembre(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererSorties");

  const membreId = String(donnees.get("membre") ?? "");
  const nature = String(donnees.get("nature") ?? "");
  const valeurBrute = String(donnees.get("valeur") ?? "").trim();
  const debut = String(donnees.get("debut") ?? "").slice(0, 10);
  const fin = String(donnees.get("fin") ?? "").slice(0, 10);
  const note = String(donnees.get("note") ?? "").trim();

  if (!membreId) return { ok: false, erreur: "Choisissez un membre." };
  if (!NATURES_REGLE.includes(nature)) return { ok: false, erreur: "Nature de règle inconnue." };

  let valeur: number | null = null;
  if (NATURES_CHIFFREES.includes(nature)) {
    valeur = Number(valeurBrute);
    if (!Number.isFinite(valeur) || valeur <= 0) {
      return { ok: false, erreur: "Cette règle demande une valeur positive." };
    }
  }
  if (fin && debut && fin < debut) {
    return { ok: false, erreur: "La fin ne peut précéder le début." };
  }

  const sql = db();
  await sql`
    insert into member_rules (member_id, kind, numeric_value, starts_on, ends_on,
                              is_active, note, created_by)
    values (${membreId}::uuid, ${nature}, ${valeur},
            ${debut === "" ? null : debut}::date, ${fin === "" ? null : fin}::date,
            true, ${note === "" ? null : note}, ${auteur.id}::uuid)
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "regle_membre_inscrite",
    { entite: "member_rules", id: membreId },
    { nature, valeur, debut: debut || null, fin: fin || null, note: note || null },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Règle inscrite." };
}

/**
 * Leve une derogation sans l'effacer : elle a produit ses effets, et le registre
 * doit pouvoir dire lesquels et jusqu'a quand.
 */
export async function leverRegleMembre(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererSorties");
  const id = String(donnees.get("id") ?? "");
  if (!id) return { ok: false, erreur: "Règle introuvable." };

  const sql = db();
  await sql`update member_rules set is_active = false where id = ${id}::uuid`;
  await journaliser({ id: auteur.id, nom: auteur.nom }, "regle_membre_levee", {
    entite: "member_rules",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Règle levée : le régime commun s'applique à nouveau." };
}

/* --------------------------------------------------------- sorties (art. 20) */

/**
 * Enregistre la sortie d'un membre, au calcul du site.
 *
 * Les montants ne sont plus saisis : ils sont ceux du decompte arrete a la date
 * de sortie (`decomptesSortie`). Le bureau choisit le membre, la date et le
 * motif ; le reste se calcule, et se corrige ensuite sur justificatif
 * (`corrigerSortie`).
 *
 * EN DEUX TEMPS. Le calcul ne voit que ce qui est saisi : un releve ancien, un
 * versement en attente de validation faussent la part sans que rien ne le
 * signale. Le premier envoi ne fait donc que montrer ce que le calcul va
 * utiliser a cette date ; le bureau confirme que c'est a jour, ou saisit ce qui
 * manque et revient. La confirmation porte une empreinte de ce qui a ete montre :
 * si quoi que ce soit a change entre-temps, le site redemande.
 *
 * En une seule transaction :
 * - la sortie est inscrite : ses droits, ses penalites compensees, les frais
 *   provisoires et le net a lui verser ;
 * - ses penalites dues sont soldees par compensation, avec le motif de sortie.
 *   Rien n'entre en caisse : la caisse les reconnait a leur note et ne les
 *   compte pas comme encaissees ;
 * - le membre est desactive. Le laisser actif le ferait figurer aux relances,
 *   aux feuilles de presence et aux parts d'un club qu'il a quitte.
 *
 * Ce qu'il a verse reste en caisse ; ce qui lui est du sort de l'avoir a
 * partager des maintenant, et de la caisse le jour de son paiement.
 */
export type SaisieRachat = { membre: string; pourcentage: string; prix: string };

export type EtatSortie = EtatFormulaire & {
  /** Ce qui a ete saisi, rendu au formulaire pour qu'il ne se vide pas. */
  valeurs?: { membre: string; date: string; motif: string; note: string; rachats: SaisieRachat[] };
  /** Ce que le calcul va utiliser, a confirmer avant l'enregistrement. */
  aVerifier?: {
    empreinte: string;
    membre: string;
    date: string;
    nom: string;
    /** La valeur de sa part et les reperes de prix : rien n'est encore enregistre. */
    valorisation: string[];
    /** Le detail du calcul, dans les termes memes des courriers. */
    detail: string[];
    points: string[];
    /** Qui paie quoi, quand des membres rachetent. */
    partage: string[];
  };
};

/** Un nombre saisi a la francaise : « 33,5 », « 150 000 ». */
function nombreSaisi(texte: string): number {
  return Number(texte.replace(/[\s  ]/g, "").replace(",", "."));
}

/** Les mois que le sortant n'a pas payes a sa date de sortie, et ce qu'il y manque. */
async function moisImpayes(membreId: string, date: string): Promise<{ mois: string; manque: number }[]> {
  const situation = (await situationsClub(new Date(`${date}T23:59:59Z`), date)).find(
    (x) => x.membreId === membreId,
  );
  return (situation?.cellules ?? [])
    .filter((c) => situation?.moisEnRetard.includes(c.mois) && c.manque > 0)
    .map((c) => ({ mois: c.mois, manque: c.manque }));
}

export async function enregistrerSortie(
  _precedent: EtatSortie,
  donnees: FormData,
): Promise<EtatSortie> {
  const auteur = await exigerDroit("gererSorties");

  const membreId = String(donnees.get("membre") ?? "");
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  const motif = String(donnees.get("motif") ?? "").trim();
  const note = String(donnees.get("note") ?? "").trim();
  const confirme = String(donnees.get("confirme") ?? "");
  const pourcentages = donnees.getAll("pourcentage").map(String);
  const prixSaisis = donnees.getAll("prix").map(String);
  const saisies: SaisieRachat[] = donnees
    .getAll("acheteur")
    .map((a, i) => ({ membre: String(a), pourcentage: pourcentages[i] ?? "", prix: prixSaisis[i] ?? "" }))
    .filter((r) => r.membre || r.pourcentage.trim() || r.prix.trim());
  const valeurs = { membre: membreId, date, motif, note, rachats: saisies };
  const refus = (erreur: string): EtatSortie => ({ ok: false, erreur, valeurs });

  if (!membreId) return refus("Choisissez le membre sortant.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return refus("Indiquez la date de sortie.");
  if (!motif) return refus("Indiquez le motif de la sortie.");
  /* Le calcul a besoin des donnees du jour de sortie : un jour a venir n'en a pas encore. */
  if (date > new Date().toISOString().slice(0, 10)) {
    return refus("La date de sortie ne peut pas être dans le futur.");
  }

  const sql = db();
  const membre = await sql`select full_name, email, is_active from members where id = ${membreId}::uuid`;
  if (!membre[0]) return refus("Membre introuvable.");
  if (!membre[0].is_active) return refus("Ce membre est déjà sorti.");
  const nomSortant = String(membre[0].full_name);

  /*
   * LES ACHETEURS. Chacun rachete un pourcentage des parts, a un prix convenu
   * avec le sortant ; le club rachete ce qui reste.
   */
  const actifs = await listerMembres();
  const sortant = actifs.find((m) => m.id === membreId);
  /*
   * Une part rachetee sort comme une personne, mais son courrier va a son
   * detenteur. Une personne qui detient des parts ne sort pas seule : ses parts
   * resteraient sans detenteur.
   */
  const titulaire = sortant?.titulaireId ? actifs.find((m) => m.id === sortant.titulaireId) : null;
  const sesParts = actifs.filter((m) => m.titulaireId === membreId);
  if (sesParts.length > 0) {
    return refus(
      `${nomSortant} détient ${sesParts.length > 1 ? "des parts rachetées" : "une part rachetée"} ` +
        `(${sesParts.map((x) => x.nom).join(", ")}) : enregistrez d'abord leur sortie.`,
    );
  }
  /* Seules des personnes rachetent : une part n'a pas de mains pour payer. */
  const nomDe = new Map(actifs.filter((m) => !m.titulaireId).map((m) => [String(m.id), m.nom]));
  const rachats: Rachat[] = [];
  for (const r of saisies) {
    const nom = nomDe.get(r.membre);
    const pourcentage = nombreSaisi(r.pourcentage);
    const prix = nombreSaisi(r.prix);
    if (!r.membre || !nom) return refus("Choisissez chaque acheteur parmi les membres actifs.");
    if (r.membre === membreId) return refus("Le sortant ne peut pas racheter ses propres parts.");
    if (r.membre === titulaire?.id) {
      return refus(`${nom} détient déjà cette part : il ne peut pas la racheter.`);
    }
    if (rachats.some((x) => x.membreId === r.membre)) {
      return refus(`${nom} figure deux fois parmi les acheteurs : réunissez ses lignes.`);
    }
    if (!Number.isFinite(pourcentage) || pourcentage <= 0 || pourcentage > 100) {
      return refus(`Indiquez pour ${nom} un pourcentage des parts entre 0 et 100.`);
    }
    if (!Number.isFinite(prix) || prix < 0) return refus(`Indiquez pour ${nom} le prix convenu.`);
    rachats.push({ membreId: r.membre, fraction: Math.round(pourcentage * 1e4) / 1e6, prix: Math.round(prix) });
  }
  if (rachats.reduce((t, r) => t + r.fraction, 0) > 1 + 1e-9) {
    return refus("Les acheteurs rachètent plus de 100 % des parts : corrigez les pourcentages.");
  }
  if (rachats.length > 0 && !(await rachatsDisponibles())) {
    return refus(
      "Le rachat par des membres demande une mise à jour de la base : exécutez " +
        "scripts/migration-rachats.sql dans Neon, puis recommencez.",
    );
  }

  const d = (await decomptesSortie(date)).find((x) => x.membreId === membreId);
  if (!d) return refus("Le décompte de ce membre est introuvable : rechargez la page.");
  if (!d.releve) {
    return refus(
      `Aucun relevé de portefeuille au ${dateCourte(date)} ou avant : saisissez-en un, puis ` +
        "déclarez à nouveau la sortie.",
    );
  }

  const base = {
    avance: d.avance,
    quotePart: d.quotePart,
    part: d.part,
    acquis: d.acquis,
    penalites: d.penalitesDeduites,
  };
  const club = { actions: d.club.actions, fraisGardeCourus: d.club.fraisGardeCourus };
  const taux = { venteActions: REGLES.fraisVenteActions, transfert: REGLES.fraisTransfertSortie };
  const fraisDe = (x: { fraisVente: number; fraisGarde: number; fraisTransfert: number }) =>
    x.fraisVente + x.fraisGarde + x.fraisTransfert;
  const partage = partagerSortie(base, club, taux, rachats);
  /*
   * LES COTISATIONS IMPAYEES DU SORTANT, que l'acheteur reprend a proportion de
   * ce qu'il rachete. Il les verse au club ; elles deviennent des cotisations de
   * sa part rachetee, pour les mois qu'elles couvrent, et comptent dans son
   * poids. Le club, lui, ne reprend rien : ce qu'il rachete sort du partage.
   */
  const impayes = await moisImpayes(membreId, date);
  const arrieresTotal = impayes.reduce((t, x) => t + x.manque, 0);
  const arrieresDe = (i: number) =>
    impayes.map((x) => ({
      mois: x.mois,
      montant:
        partage.fractionClub === 0 && i === rachats.length - 1
          ? x.manque - rachats.slice(0, -1).reduce((t, r) => t + Math.round(r.fraction * x.manque), 0)
          : Math.round(rachats[i].fraction * x.manque),
    }));
  const acheteurs = partage.acheteurs.map((a, i) => {
    const mois = arrieresDe(i).filter((x) => x.montant > 0);
    return {
      ...a,
      nom: nomDe.get(a.membreId) ?? "",
      moisArrieres: mois,
      arrieres: mois.reduce((t, x) => t + x.montant, 0),
    };
  });
  const frais = fraisDe(partage);

  /*
   * Chaque acheteur recoit une part distincte de la sienne : une ligne du
   * registre, a son nom, qui cotise a proportion de sa taille a partir de la
   * premiere echeance qui suit le rachat.
   */
  const fractionSortant = sortant?.fraction ?? 1;
  const reglages = await reglagesEffectifs();
  const premierMois = premierMoisDeLaPart(date, reglages.jourEcheance);
  const parts = acheteurs.map((a) => ({
    ...a,
    partId: randomUUID(),
    lotArrieres: randomUUID(),
    taille: Math.round(a.fraction * fractionSortant * 1e6) / 1e6,
    nomPart: nomDeLaPart(a.nom, nomSortant, a.fraction * fractionSortant),
  }));

  const faits = await faitsAvantSortie(d);
  const empreinte = empreinteSortie(membreId, faits, rachats);
  if (confirme !== empreinte) {
    const tout = partagerSortie(base, club, taux, []);
    return {
      ok: false,
      valeurs,
      erreur: confirme
        ? "Les données ont changé depuis votre vérification : relisez-les avant de confirmer."
        : undefined,
      aVerifier: {
        empreinte,
        membre: membreId,
        date,
        nom: nomSortant,
        valorisation: lignesValorisation({
          quotePart: d.quotePart,
          part: d.part,
          avance: d.avance,
          penalites: d.penalitesDeduites,
          netClub: tout.netClub,
          fraisClub: fraisDe(tout),
          arrieres: arrieresTotal,
        }),
        detail: lignesValeurDeLaPart(
          {
            dateSortie: date,
            releve: d.releve,
            club: d.club,
            cotisations: d.acquis,
            avance: d.avance,
            quotePart: d.quotePart,
          },
          (() => {
            let n = 0;
            return (titre: string) => `${++n}. ${titre}`;
          })(),
          false,
        ),
        points: pointsAVerifier(faits),
        partage:
          rachats.length === 0
            ? []
            : [
                ...lignesPartage({
                  avance: d.avance,
                  acheteurs,
                  fractionClub: partage.fractionClub,
                  droitsClub: partage.droitsClub,
                  frais,
                  compensees: partage.compensees,
                  netClub: partage.netClub,
                  resteDu: partage.resteDu,
                }),
                ...lignesNouvellesParts(
                  parts.map((x) => ({ nom: x.nom, taille: x.taille })),
                  reglages.cotisationMensuelle,
                  premierMois,
                ),
              ],
      },
    };
  }

  const detail = [
    note,
    `Calculée au ${dateCourte(date)}, portefeuille au relevé du ${dateCourte(d.releve)}`,
    ...acheteurs.map(
      (a) =>
        `${a.nom} rachète ${(a.fraction * 100).toLocaleString("fr-FR", { maximumFractionDigits: 4 })} % ` +
        `des parts au prix de ${fcfa(a.prix)}` +
        (a.auClub > 0 ? `, dont ${fcfa(a.auClub)} versés au club pour les pénalités` : ""),
    ),
    `pénalités compensées ${fcfa(partage.compensees)}` +
      (d.penalitesEnCours > 0 ? `, dont ${fcfa(d.penalitesEnCours)} non inscrites au registre` : ""),
    `frais provisoires : cession ${fcfa(partage.fraisVente)}, garde ${fcfa(partage.fraisGarde)}, ` +
      `transfert ${fcfa(partage.fraisTransfert)}`,
    partage.resteDu > 0 ? `reste dû au club ${fcfa(partage.resteDu)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  /*
   * En une seule transaction : la sortie, les rachats et le poids qu'ils
   * transmettent, ce que les acheteurs doivent verser au club pour les
   * penalites (en caisse, en attente de reception), les penalites soldees, le
   * membre desactive. L'identifiant de la sortie est tire ici pour que les
   * rachats puissent s'y rattacher dans la meme transaction.
   */
  const sortieId = randomUUID();
  await sql.transaction([
    sql`
      insert into member_exits (id, member_id, exit_date, reason, gross_value, fees,
                                net_paid, forfeited, note, created_by)
      values (${sortieId}::uuid, ${membreId}::uuid, ${date}::date, ${motif}, ${partage.droitsClub},
              ${frais}, ${partage.netClub}, ${partage.compensees}, ${detail}, ${auteur.id}::uuid)
    `,
    ...parts.flatMap((a) => [
      sql`
        insert into members (id, full_name, email, role, password_hash, must_change_password,
                             is_active, joined_on, holder_id, part_fraction)
        values (${a.partId}::uuid, ${a.nomPart}, null, 'membre', null, false,
                true, ${premierMois}::date, ${a.membreId}::uuid, ${a.taille})
      `,
      sql`
        insert into share_buybacks (exit_id, seller_id, buyer_id, part_id, bought_on, fraction,
                                    weight, reference_value, price, paid_to_club, created_by)
        values (${sortieId}::uuid, ${membreId}::uuid, ${a.membreId}::uuid, ${a.partId}::uuid,
                ${date}::date, ${a.fraction}, ${a.poids}, ${a.valeur}, ${a.prix + a.auClub},
                ${a.auClub}, ${auteur.id}::uuid)
      `,
      /*
       * Les cotisations impayees reprises : une ligne par mois, au nom de la part,
       * en attente jusqu'a ce que le tresorier constate l'argent.
       */
      ...a.moisArrieres.map(
        (x) => sql`
          insert into contributions
            (member_id, period, kind, amount, paid_on, method, reference, note,
             batch_id, status, declared_by)
          values
            (${a.partId}::uuid, ${x.mois}::date, ${KIND_VERSEMENT.cotisation}, ${x.montant},
             ${date}::date, ${METHODE.mobileMoney}, null,
             ${`Cotisation impayée de ${nomSortant}, reprise par ${a.nom} au rachat de ses parts`},
             ${a.lotArrieres}::uuid, ${STATUT_VERSEMENT.enAttente}, ${auteur.id}::uuid)
        `,
      ),
    ]),
    ...acheteurs
      .filter((a) => a.auClub > 0)
      .map(
        (a) => sql`
          insert into cash_movements (movement_date, direction, category, amount, note, status, created_by)
          values (${date}::date, ${SENS_CAISSE.recette}, ${CATEGORIE_PENALITES_SORTANT}, ${a.auClub},
                  ${`Pénalités de ${nomSortant}, payées par ${a.nom} sur le rachat de ses parts`},
                  ${STATUT_CAISSE.enAttente}, ${auteur.id}::uuid)
        `,
      ),
    sql`
      update penalties
      set status = ${STATUT_PENALITE.payee},
          settled_on = ${date}::date,
          settlement_note = ${`${PREFIXE_SOLDE_SORTIE} : ${motif}`},
          resolved_by = ${auteur.id}::uuid,
          resolved_at = now()
      where member_id = ${membreId}::uuid and status = ${STATUT_PENALITE.due}
    `,
    sql`update members set is_active = false where id = ${membreId}::uuid`,
  ]);

  /*
   * Le sortant recoit le detail du calcul, en mots : les montants qu'il lit sont
   * ceux qui viennent d'etre enregistres. Un courrier qui ne part pas n'annule
   * pas la sortie ; le message le dit, pour que le bureau le lui transmette.
   */
  const courrier = await envoyerCourrielSortie(
    titulaire
      ? { nom: titulaire.nom, email: titulaire.email }
      : { nom: nomSortant, email: membre[0].email },
    courrielSortie({
      nom: titulaire ? titulaire.nom : nomSortant,
      part: titulaire ? nomSortant : undefined,
      dateSortie: date,
      motif,
      releve: d.releve,
      club: d.club,
      cotisations: d.acquis,
      avance: d.avance,
      quotePart: d.quotePart,
      droits: partage.droitsClub,
      rachats: acheteurs.map((a) => ({
        nom: a.nom,
        fraction: a.fraction,
        valeur: a.valeur,
        prix: a.prix,
        auClub: a.auClub,
        auSortant: a.auSortant,
        arrieres: a.arrieres,
      })),
      penalites: d.penalitesDeduites,
      penalitesEnCours: d.penalitesEnCours,
      compensees: partage.compensees,
      pocheActions: partage.pocheActions,
      fraisVente: partage.fraisVente,
      fraisGarde: partage.fraisGarde,
      fraisTransfert: partage.fraisTransfert,
      net: partage.netClub,
    }),
  ).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "sortie_membre",
    { entite: "member_exits", id: sortieId },
    {
      membre: membreId,
      date,
      motif,
      releve: d.releve,
      droits: partage.droitsClub,
      compensees: partage.compensees,
      frais,
      net: partage.netClub,
      rachats: acheteurs.map((a) => ({
        acheteur: a.membreId,
        fraction: a.fraction,
        prix: a.prix,
        penalites: a.auClub,
        arrieres: a.arrieres,
      })),
      courriel: courrier.detail,
    },
  );
  revalidatePath("/", "layout");
  const auClub = acheteurs.reduce((t, a) => t + a.auClub, 0);
  const arrieresRepris = acheteurs.reduce((t, a) => t + a.arrieres, 0);
  return {
    ok: true,
    message:
      `Sortie enregistrée : ${fcfa(partage.netClub)} à verser par le club à ${nomSortant}, sous ` +
      `${REGLES.delaiRemboursementMois} mois (R5)` +
      (acheteurs.length > 0
        ? `, et ${fcfa(acheteurs.reduce((t, a) => t + a.auSortant, 0))} par les acheteurs de ses parts, directement. `
        : ". ") +
      (auClub > 0
        ? `Les ${fcfa(auClub)} que les acheteurs doivent au club pour ses pénalités attendent en caisse : validez-les à réception. `
        : "") +
      (arrieresRepris > 0
        ? `Les ${fcfa(arrieresRepris)} de cotisations impayées qu'ils reprennent attendent dans Versements, ` +
          "au nom de leur part : validez-les à réception. "
        : "") +
      "Ses pénalités sont soldées avec le motif de sortie. " +
      (courrier.ok
        ? "Le détail du calcul lui a été envoyé par courriel, tous les membres en copie. "
        : `Le courriel de décompte n'est pas parti (${courrier.detail}) : transmettez-lui le détail. `) +
      "Le jour du paiement, enregistrez-le dans Caisse en dépense « Remboursement " +
      "d'un membre sorti ».",
  };
}

/**
 * Envoie au sortant la valeur de sa part, avant d'enregistrer quoi que ce soit.
 *
 * Il a le droit de la contester, preuve a l'appui : il la recoit tant qu'elle
 * peut encore changer, avec tout le calcul, et tous les membres en copie, parmi
 * lesquels ses acheteurs eventuels. Rien n'est ecrit en base, sauf au journal.
 */
export async function envoyerValorisation(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererSorties");
  const membreId = String(donnees.get("membre") ?? "");
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  if (!membreId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, erreur: "Valorisez d'abord la part, puis envoyez-la." };
  }
  if (date > new Date().toISOString().slice(0, 10)) {
    return { ok: false, erreur: "La date de sortie ne peut pas être dans le futur." };
  }

  const actifs = await listerMembres();
  const sortant = actifs.find((m) => m.id === membreId);
  if (!sortant) return { ok: false, erreur: "Ce membre n'est pas actif." };
  const titulaire = sortant.titulaireId ? actifs.find((m) => m.id === sortant.titulaireId) : null;

  const d = (await decomptesSortie(date)).find((x) => x.membreId === membreId);
  if (!d || !d.releve) {
    return { ok: false, erreur: `Aucun relevé de portefeuille au ${dateCourte(date)} ou avant.` };
  }
  const tout = partagerSortie(
    { avance: d.avance, quotePart: d.quotePart, part: d.part, acquis: d.acquis, penalites: d.penalitesDeduites },
    { actions: d.club.actions, fraisGardeCourus: d.club.fraisGardeCourus },
    { venteActions: REGLES.fraisVenteActions, transfert: REGLES.fraisTransfertSortie },
    [],
  );
  const arrieres = (await moisImpayes(membreId, date)).reduce((t, x) => t + x.manque, 0);

  const courrier = await envoyerCourrielSortie(
    titulaire ? { nom: titulaire.nom, email: titulaire.email } : { nom: sortant.nom, email: sortant.email },
    courrielValorisation({
      nom: titulaire ? titulaire.nom : sortant.nom,
      part: titulaire ? sortant.nom : undefined,
      dateSortie: date,
      releve: d.releve,
      club: d.club,
      cotisations: d.acquis,
      avance: d.avance,
      quotePart: d.quotePart,
      penalites: d.penalitesDeduites,
      penalitesEnCours: d.penalitesEnCours,
      arrieres,
      netClub: tout.netClub,
      compensees: tout.compensees,
      fraisVente: tout.fraisVente,
      fraisGarde: tout.fraisGarde,
      fraisTransfert: tout.fraisTransfert,
    }),
  ).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "valorisation_sortie_envoyee",
    { entite: "members", id: membreId },
    { date, releve: d.releve, quotePart: d.quotePart, netClub: tout.netClub, courriel: courrier.detail },
  );
  return courrier.ok
    ? {
        ok: true,
        message:
          `Valorisation envoyée à ${titulaire ? titulaire.nom : sortant.nom}, tous les membres en ` +
          "copie. Rien n'est enregistré : la sortie se déclare ensuite, avec ou sans acheteurs.",
      }
    : { ok: false, erreur: `Le courriel n'est pas parti (${courrier.detail}).` };
}

/**
 * Remplace les frais provisoires d'une sortie par les frais reels.
 *
 * Les 2 % de transfert ne sont qu'une estimation, et la provision de cession
 * peut ceder la place aux frais d'une vente reelle : le net a verser se
 * recalcule, et la dette envers le sortant suit. L'ancien montant reste au
 * journal, avec le justificatif.
 */
export async function corrigerSortie(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererSorties");

  const id = String(donnees.get("sortie") ?? "");
  const frais = Math.round(Number(donnees.get("frais") ?? Number.NaN));
  const raison = String(donnees.get("raison") ?? "").trim();
  if (!id) return { ok: false, erreur: "Sortie introuvable." };
  if (!Number.isFinite(frais) || frais < 0) return { ok: false, erreur: "Les frais doivent être positifs ou nuls." };
  if (!raison) return { ok: false, erreur: "Indiquez le justificatif des frais réels." };

  const sql = db();
  const rows = await sql`
    select e.gross_value, e.forfeited, e.fees, e.net_paid, m.full_name, m.email, e.member_id,
           to_char(e.exit_date, 'YYYY-MM-DD') as exit_date
    from member_exits e join members m on m.id = e.member_id
    where e.id = ${id}::uuid
  `;
  const e = rows[0];
  if (!e) return { ok: false, erreur: "Sortie introuvable." };

  const droits = Number(e.gross_value);
  const compensees = Number(e.forfeited);
  if (frais + compensees > droits) {
    return { ok: false, erreur: "Ces frais dépassent ce qui revient au sortant." };
  }
  const net = droits - compensees - frais;

  await sql`
    update member_exits
    set fees = ${frais}, net_paid = ${net},
        note = concat_ws(' · ', note, ${`frais réels ${fcfa(frais)} (${raison})`})
    where id = ${id}::uuid
  `;
  /* Une part rachetee sortie : le courrier va a son detenteur. */
  const tous = await listerMembres(true);
  const ligne = tous.find((m) => m.id === String(e.member_id));
  const titulaire = ligne?.titulaireId ? tous.find((m) => m.id === ligne.titulaireId) : undefined;
  const courrier = await envoyerCourrielSortie(
    titulaire ? { nom: titulaire.nom, email: titulaire.email } : { nom: e.full_name, email: e.email },
    courrielCorrectionSortie({
      nom: titulaire ? titulaire.nom : e.full_name,
      part: titulaire ? e.full_name : undefined,
      dateSortie: e.exit_date,
      fraisAvant: Number(e.fees),
      fraisApres: frais,
      netAvant: Number(e.net_paid),
      netApres: net,
      raison,
    }),
  ).catch((x: unknown) => ({ ok: false, detail: x instanceof Error ? x.message : String(x) }));

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "sortie_frais_corriges",
    { entite: "member_exits", id },
    {
      avant: { frais: Number(e.fees), net: Number(e.net_paid) },
      apres: { frais, net },
      raison,
      courriel: courrier.detail,
    },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      `Frais corrigés : ${fcfa(net)} à verser à ${e.full_name} (au lieu de ${fcfa(Number(e.net_paid))}). ` +
      (courrier.ok
        ? "Il en a été averti par courriel, tous les membres en copie."
        : `Le courriel n'est pas parti (${courrier.detail}) : prévenez-le.`),
  };
}

/* ---------------------------------------------------- essai de configuration */

/**
 * Envoie un courrier d'essai au president, pour verifier la configuration.
 *
 * La relance ne part que le 10 : sans ce bouton, une faute de frappe dans le mot
 * de passe ne se decouvre qu'un mois plus tard, quand personne n'a ete relance.
 *
 * Le courrier part a l'adresse du demandeur, jamais a une adresse saisie : un
 * formulaire qui envoie ou l'on veut depuis l'adresse du club est un relais
 * ouvert, et c'est le genre de service dont on abuse.
 */
export async function envoyerCourrielEssai(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReglages");

  if (transportConfigure() === "aucun") {
    return {
      ok: false,
      erreur:
        "Aucun transport configuré. Renseignez SMTP_HOST, SMTP_PORT, SMTP_USER et SMTP_PASS " +
        "dans les variables d'environnement, puis redéployez.",
    };
  }

  /*
   * Deux destinations possibles, toutes deux deja connues du site : l'adresse du
   * demandeur, et celle du compte d'envoi. Aucune adresse libre -- un formulaire
   * qui enverrait ou l'on veut depuis l'adresse du club serait un relais ouvert.
   *
   * Le choix compte : l'adresse du membre n'est pas forcement celle du club, et
   * attendre le courrier dans la mauvaise boite fait conclure a une panne qui
   * n'existe pas.
   */
  const versLeClub = String(donnees.get("destination") ?? "") === "club";
  const adresseClub = variable("SMTP_USER", "") || variable("EMAIL_EXPEDITEUR", "");
  const destinataire = versLeClub && adresseClub !== "" ? adresseClub : auteur.email;

  const { ok: parti, detail } = await envoyerCourriel({
    destinataire,
    sujet: `${CLUB.sigle} : essai de configuration`,
    texte: [
      `Bonjour ${auteur.nom},`,
      "",
      "Ce courrier confirme que l'envoi fonctionne : la relance du 10 partira.",
      "",
      `Transport : ${descriptionTransport()}`,
      /*
       * Horodatage a la seconde, et revision deployee : deux essais identiques
       * dans la meme boite sont replies par Gmail sous « texte des messages
       * precedents masque », et le second parait vide. Ce qui distingue les
       * messages doit donc figurer dans le corps, pas seulement dans l'en-tete.
       */
      `Essai demandé le ${new Date().toISOString().slice(0, 19).replace("T", " à ")} UTC.`,
      `Version en ligne : ${versionDeployee().revision ?? "inconnue"}.`,
      "",
      `Le bureau d'${CLUB.nom}`,
    ].join("\n"),
  });

  await journaliser({ id: auteur.id, nom: auteur.nom }, "essai_courriel", { entite: "settings" }, {
    transport: transportConfigure(),
    reussi: parti,
    detail,
    destinataire,
  });

  if (!parti) {
    return {
      ok: false,
      erreur:
        `Envoi refusé. Réponse du serveur : ${detail}. Avec Gmail, la cause la plus fréquente ` +
        "est un mot de passe ordinaire là où un mot de passe d'application est exigé, " +
        "ou le port 587 déclaré en 465.",
    };
  }
  /*
   * L'adresse est celle du compte, qui n'est pas forcement celle que l'on relevait
   * en attendant le courrier. La nommer evite de chercher dans la mauvaise boite.
   */
  return {
    ok: true,
    message:
      `Courrier remis à ${destinataire}. Vérifiez cette boîte, et son dossier Spam. ` +
      `Réponse du serveur : ${detail}`,
  };
}

/* ------------------------------------------------- relance declenchee a la main */

/**
 * Envoie la relance hors du 10.
 *
 * Le cron ne part qu'une fois par mois : entre deux, le bureau n'avait aucun
 * moyen d'ecrire aux retardataires. Le courrier est exactement celui du 10 --
 * deux redactions divergentes feraient douter de celle qu'on a recue.
 *
 * Inscrit au registre sous un canal distinct, `email-manuel` : la trace existe,
 * mais elle ne fait pas passer le membre pour deja relance et n'empeche donc pas
 * le passage automatique du lendemain. L'inverse vaut aussi -- le bureau garde le
 * droit d'ecrire un jour ou le cron a deja ecrit ; le message le lui signale
 * plutot que de le lui refuser. Le journal, lui, garde qui a decide d'ecrire.
 */
export async function relancerMaintenant(
  _precedent: EtatFormulaire,
  _donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("relancer");

  if (transportConfigure() === "aucun") {
    return { ok: false, erreur: "Aucun transport configuré : aucun courrier ne peut partir." };
  }

  const maintenant = new Date();

  /*
   * Le registre d'abord, comme au passage automatique : la relance manuelle dit
   * exactement la meme chose que celle du 10, et elle ne peut le dire juste que
   * sur un registre a jour. Le declencheur signe l'ecriture -- les titulaires du
   * droit de relancer sont ceux du droit sur les penalites.
   */
  let constat: IssueConstat | null = null;
  try {
    constat = await porterRetardsAuRegistre(auteur.id);
    await journaliser(
      { id: auteur.id, nom: auteur.nom },
      "constat_penalites_relance",
      { entite: "penalties" },
      { ...constat },
    );
  } catch {
    // Un registre en retard n'empeche pas d'ecrire : la relance passe outre.
  }

  const destinataires = await destinatairesDuJour(maintenant);
  if (destinataires.length === 0) {
    return { ok: true, message: "Personne à relancer : tout le monde est à jour." };
  }

  /*
   * Le nombre de membres deja touches aujourd'hui par le passage automatique :
   * l'envoi n'est pas refuse, mais l'annoncer evite un second courrier decide
   * sans le savoir.
   */
  const dejaVus = await dejaRelancesAujourdhui(maintenant).catch(() => new Set<string>());
  const dejaTouches = destinataires.filter((d) => dejaVus.has(d.situation.membreId)).length;

  const { envoyes, echecs } = await envoyerRelances(destinataires, maintenant);
  try {
    await tracerRelances(destinataires, envoyes, maintenant, "email-manuel");
  } catch {
    // Le registre est un temoin, pas une condition : son echec n'annule pas l'envoi.
  }
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "relance_manuelle",
    { entite: "reminder_log" },
    { concernes: destinataires.length, envoyes: envoyes.length, echecs: echecs.length },
  );
  revalidatePath("/", "layout");

  const reste = echecs.length > 0 ? ` ${echecs.length} envoi(s) ont échoué.` : "";
  const doublon =
    dejaTouches > 0
      ? ` ${dejaTouches} d'entre eux avaient déjà reçu la relance automatique aujourd'hui : ` +
        "pour ceux-là, c'est un second courrier."
      : "";
  /* Ce que le constat vient d'inscrire : le tresorier doit le savoir tout de suite. */
  const porte =
    constat && (constat.creees > 0 || constat.reajustees > 0)
      ? ` Registre mis à jour au passage : ${resumeConstat(constat)}`
      : "";
  return {
    ok: echecs.length === 0,
    message: `${envoyes.length} relance(s) envoyée(s) sur ${destinataires.length} membre(s) concerné(s).${reste}${doublon}${porte}`,
    erreur: echecs.length > 0 ? `${echecs.length} envoi(s) ont échoué.` : undefined,
  };
}
