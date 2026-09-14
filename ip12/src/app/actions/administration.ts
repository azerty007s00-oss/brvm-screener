"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { descriptionTransport, envoyerCourriel, transportConfigure } from "@/lib/courriel";
import { versionDeployee } from "@/lib/version";
import { listerMembres, reglagesEffectifs } from "@/lib/queries";
import { CLUB, REGLES, debutMois, decalerMois, fcfa, moisLong, variable } from "@/lib/settings";
import {
  KIND_PENALITE,
  KIND_VERSEMENT,
  METHODE,
  REGLE_MEMBRE,
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
  if (!/^\d{4}-\d{2}$/.test(depuis)) return { ok: false, erreur: "Mois de debut invalide." };
  if (!Number.isFinite(montant) || montant <= 0) return { ok: false, erreur: "Montant invalide." };

  const moisDebut = `${depuis}-01`;
  const moisFin = `${jusqua}-01`;
  if (moisFin < moisDebut) return { ok: false, erreur: "Le mois de fin precede le mois de debut." };
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
      return { ok: false, erreur: `La borne de ${m.nom} precede le premier mois du club.` };
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
    if (compte > 0) bornes.push(`${m.nom} jusqu'a ${moisLong(finMembre)}`);
  }
  if (idsMembres.length === 0) return { ok: false, erreur: "Aucun mois a reprendre sur cette periode." };

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
      message: `Rien a reprendre : tous les mois jusqu'a ${moisLong(moisFin)} sont deja couverts.`,
    };
  }
  return {
    ok: true,
    message:
      `${crees.length} mois marques payes jusqu'a ${moisLong(moisFin)}, ` +
      `dates a l'echeance du ${reglages.jourEcheance} pour n'engendrer aucune penalite.`,
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
      return { ok: false, erreur: "Le jour d'echeance doit tomber entre le 1 et le 28." };
    }
    if (cle === "taux_penalite" && valeur > 1) {
      return { ok: false, erreur: "Le taux de penalite s'exprime en fraction : 0,1 pour 10 %." };
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
      "Reglages enregistres. Ils priment desormais sur les valeurs des statuts inscrites dans le code.",
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
    return { ok: false, erreur: "Indiquez jusqu'a quel mois le decompte du tresorier s'arrete." };
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
      `Penalites constatees par le tresorier — ${mois} mois, arretees a ${moisLong(`${jusqua}-01`)}`;
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
    return { ok: false, erreur: "Aucun nombre de mois renseigne." };
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
      `${inscrites + remplacees} membre(s) — ${total.toLocaleString("fr-FR")} FCFA de penalites ` +
      `au registre, arretees a ${moisLong(`${jusqua}-01`)}` +
      `${remplacees > 0 ? `, dont ${remplacees} mise(s) a jour` : ""}. ` +
      `Le constat automatique ne recomptera aucun mois anterieur.`,
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
  if (!NATURES_REGLE.includes(nature)) return { ok: false, erreur: "Nature de regle inconnue." };

  let valeur: number | null = null;
  if (NATURES_CHIFFREES.includes(nature)) {
    valeur = Number(valeurBrute);
    if (!Number.isFinite(valeur) || valeur <= 0) {
      return { ok: false, erreur: "Cette regle demande une valeur positive." };
    }
  }
  if (fin && debut && fin < debut) {
    return { ok: false, erreur: "La fin ne peut preceder le debut." };
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
  return { ok: true, message: "Regle inscrite." };
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
  if (!id) return { ok: false, erreur: "Regle introuvable." };

  const sql = db();
  await sql`update member_rules set is_active = false where id = ${id}::uuid`;
  await journaliser({ id: auteur.id, nom: auteur.nom }, "regle_membre_levee", {
    entite: "member_rules",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Regle levee : le regime commun s'applique a nouveau." };
}

/* --------------------------------------------------------- sorties (art. 20) */

/**
 * Enregistre la sortie d'un membre et solde ses comptes.
 *
 * L'art. 20 rembourse la part au cours de cession, diminuee de 2 % de frais.
 * L'art. 9 veut que les penalites soient « definitivement acquises au benefice du
 * club » : elles ne se remboursent pas, et se retranchent donc du versement.
 *
 * Les montants sont saisis, non imposes. Le site en propose le calcul au dernier
 * releve, mais les frais reels de la SGI ne sont connus qu'apres coup et le club
 * vote : les chiffres ouvrent la discussion, ils ne la closent pas.
 *
 * Le membre est desactive dans le meme mouvement. Le laisser actif le ferait
 * figurer aux relances, aux feuilles de presence et aux parts d'un club qu'il a
 * quitte -- et fausserait la repartition de tous les autres.
 */
export async function enregistrerSortie(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererSorties");

  const membreId = String(donnees.get("membre") ?? "");
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  const motif = String(donnees.get("motif") ?? "").trim();
  const brut = Math.round(Number(donnees.get("valeurBrute") ?? 0));
  const frais = Math.round(Number(donnees.get("frais") ?? 0));
  const acquis = Math.round(Number(donnees.get("acquisAuClub") ?? 0));
  const note = String(donnees.get("note") ?? "").trim();

  if (!membreId) return { ok: false, erreur: "Choisissez le membre sortant." };
  if (!date) return { ok: false, erreur: "Indiquez la date de sortie." };
  if (!motif) return { ok: false, erreur: "Indiquez le motif de la sortie." };
  for (const [libelle, v] of [
    ["La valeur brute", brut],
    ["Les frais", frais],
    ["Le montant acquis au club", acquis],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) return { ok: false, erreur: `${libelle} doit etre positif ou nul.` };
  }
  if (frais + acquis > brut) {
    return {
      ok: false,
      erreur: "Frais et penalites depassent la valeur de la part : le club ne peut reclamer au sortant.",
    };
  }

  const sql = db();
  const membre = await sql`select full_name, is_active from members where id = ${membreId}::uuid`;
  if (!membre[0]) return { ok: false, erreur: "Membre introuvable." };
  if (!membre[0].is_active) return { ok: false, erreur: "Ce membre est deja sorti." };

  const net = brut - frais - acquis;

  await sql`
    insert into member_exits (member_id, exit_date, reason, gross_value, fees,
                              net_paid, forfeited, note, created_by)
    values (${membreId}::uuid, ${date}::date, ${motif}, ${brut}, ${frais},
            ${net}, ${acquis}, ${note === "" ? null : note}, ${auteur.id}::uuid)
  `;
  await sql`update members set is_active = false where id = ${membreId}::uuid`;

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "sortie_membre",
    { entite: "member_exits", id: membreId },
    { date, motif, brut, frais, acquis, net },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Sortie enregistree : ${fcfa(net)} a verser a ${membre[0].full_name}, sous ${REGLES.delaiRemboursementMois} mois (R5).`,
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
        "Aucun transport configure. Renseignez SMTP_HOST, SMTP_PORT, SMTP_USER et SMTP_PASS " +
        "dans les variables d'environnement, puis redeployez.",
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
    sujet: `${CLUB.sigle} — essai de configuration`,
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
      `Essai demande le ${new Date().toISOString().slice(0, 19).replace("T", " a ")} UTC.`,
      `Version en ligne : ${versionDeployee().revision ?? "inconnue"}.`,
      "",
      `Le bureau — ${CLUB.nom}`,
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
        `Envoi refuse. Reponse du serveur : ${detail}. Avec Gmail, la cause la plus frequente ` +
        "est un mot de passe ordinaire la ou un mot de passe d'application est exige, " +
        "ou le port 587 declare en 465.",
    };
  }
  /*
   * L'adresse est celle du compte, qui n'est pas forcement celle que l'on relevait
   * en attendant le courrier. La nommer evite de chercher dans la mauvaise boite.
   */
  return {
    ok: true,
    message:
      `Courrier remis a ${destinataire} — verifiez cette boite, et son dossier Spam. ` +
      `Reponse du serveur : ${detail}`,
  };
}
