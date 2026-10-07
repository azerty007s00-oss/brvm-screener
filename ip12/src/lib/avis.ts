import "server-only";
import { listerMembres, reglesIndisponibles } from "@/lib/queries";
import { envoyerCourriel } from "@/lib/courriel";
import { CLUB, accorde, dateCourte, fcfa, lienDuSite, moisLong, ROLES } from "@/lib/settings";
import { titulaires, DROITS } from "@/lib/droits";
import type { Destinataire } from "@/lib/relance";
import type { Role } from "@/lib/settings";

/**
 * Avis adresses au bureau, par opposition aux relances adressees aux membres.
 *
 * Le site affiche tout, mais encore faut-il l'ouvrir. Une declaration de
 * versement peut attendre des jours si personne ne consulte la page : l'avis
 * porte l'information a qui doit agir, au moment ou il doit agir.
 */

/** Les adresses des titulaires d'un droit, actifs seulement. */
async function adresses(droit: keyof typeof DROITS): Promise<{ nom: string; email: string }[]> {
  const roles = DROITS[droit] as readonly Role[];
  const membres = await listerMembres().catch(() => []);
  return membres
    .filter((m) => roles.includes(m.role) && m.actif && m.email)
    .map((m) => ({ nom: m.nom, email: m.email }));
}

/**
 * Recapitulatif du 10 au tresorier : ce qu'il y a a encaisser.
 *
 * Le president y figure aussi : il valide les versements que le tresorier ne
 * peut pas valider lui-meme, et repond du suivi devant l'assemblee.
 */
export async function avertirLeBureau(
  destinataires: Destinataire[],
  maintenant = new Date(),
): Promise<number> {
  if (destinataires.length === 0) return 0;

  const enRetard = destinataires.filter((d) => d.arrieres.length > 0);
  const moisDus = enRetard.reduce((t, d) => t + d.arrieres.length, 0);
  /*
   * CE QUE LE CLUB ATTEND VRAIMENT, ET NON LE SEUL CALCUL DU MOIS.
   *
   * Ce total additionnait `totalPenalites`, la penalite que l'art. 9 fait courir
   * sur les mois impayes -- et ignorait donc tout ce que le registre porte par
   * ailleurs : les penalites d'absence, et celles de mois anciens dont la
   * cotisation a fini par etre versee sans que la penalite le soit. Le tresorier
   * lisait « Penalites dues a ce jour : 1 000 FCFA » quand le club en attendait
   * huit mille cinq cents.
   *
   * La dette inscrite, plus ce qui court sans etre encore inscrit : les deux
   * sont dues, et `nonInscrites` ne retient que les mois absents du registre,
   * donc rien n'est compte deux fois.
   */
  const penalites = destinataires.reduce(
    (t, d) => t + d.dette.montant + d.nonInscrites.montant,
    0,
  );
  const attendus = destinataires.filter((d) => d.echeanceDuJour !== null).length;

  const lignes: string[] = [
    "Bonjour,",
    "",
    `Relance de ${moisLong(maintenant.toISOString().slice(0, 8) + "01")} : ` +
      `${destinataires.length} ${accorde(destinataires.length, "membre")} ` +
        `${accorde(destinataires.length, "vient", "viennent")} d'etre ` +
        `${accorde(destinataires.length, "relance")}.`,
    "",
    "A ENCAISSER",
    `  Echeances du jour : ${attendus} ${accorde(attendus, "membre")}.`,
    `  Mois en retard : ${moisDus}, ${accorde(moisDus, "reparti")} sur ` +
      `${enRetard.length} ${accorde(enRetard.length, "membre")}.`,
    `  Penalites dues a ce jour : ${fcfa(penalites)}.`,
    "",
    "DETAIL",
  ];

  for (const d of destinataires) {
    const motifs: string[] = [];
    if (d.echeanceDuJour) motifs.push("echeance du jour");
    if (d.arrieres.length > 0) motifs.push(`${d.arrieres.length} mois en retard`);
    /*
     * La dette inscrite, toutes natures : le bureau relit cette liste pour
     * decider qui relancer, et un membre penalise pour deux absences n'y
     * figurait pas -- le compte ne regardait que les retards, sous un mot qui
     * disait le contraire.
     */
    if (d.dette.nb > 0) {
      motifs.push(
        d.dette.nb === d.dette.nbRetard
          ? `${d.dette.nb} ${accorde(d.dette.nb, "penalite")} de retard ` +
            `${accorde(d.dette.nb, "impayee")}`
          : `${d.dette.nb} ${accorde(d.dette.nb, "penalite")} ` +
            `${accorde(d.dette.nb, "impayee")}, dont ${d.dette.nbRetard} de retard`,
      );
    }
    /*
     * Ce qui court sans etre encore au registre : apres une relance, le constat
     * l'a normalement deja inscrit, et cette mention ne parait donc que si le
     * constat a echoue. Elle dit alors au bureau ce qu'il reste a porter.
     */
    if (d.nonInscrites.montant > 0) {
      motifs.push(`${fcfa(d.nonInscrites.montant)} d'art. 9 a porter au registre`);
    }
    if (d.avanceManquante) motifs.push("avance obligatoire non tenue");
    lignes.push(`  ${d.situation.nom} — ${motifs.join(", ")}`);
  }

  /*
   * UN COURRIER INCOMPLET DOIT SE DIRE INCOMPLET.
   *
   * Les regles individuelles portent la cotisation particuliere, le
   * multiplicateur de penalite, l'avance imposee et le plan de redressement. Si
   * leur lecture tombe en panne, la relance part quand meme -- c'est voulu --
   * mais sans aucune de ces mesures, et sans que rien ne le signale. Le bureau
   * croirait alors que personne n'en a.
   */
  const panne = reglesIndisponibles();
  if (panne) {
    lignes.push(
      "",
      "AVERTISSEMENT — les regles individuelles n'ont pas pu etre lues.",
      "Les courriers qui viennent de partir ne portent donc ni cotisation",
      "particuliere, ni penalites majorees, ni avance imposee, ni plan de",
      "redressement, et les montants reclames sont ceux du regime commun.",
      `Detail technique : ${panne}`,
    );
  }

  const siteUrl = lienDuSite();
  if (siteUrl) lignes.push("", `Valider les encaissements : ${siteUrl}/versements`);
  lignes.push("", `Le suivi du club — ${CLUB.nom}`);

  const bureau = await adresses("validerVersement");
  let partis = 0;
  for (const m of bureau) {
    const { ok } = await envoyerCourriel({
      destinataire: m.email,
      sujet: `${CLUB.sigle} — a encaisser apres la relance (${destinataires.length} membres)`,
      texte: lignes.join("\n"),
    });
    if (ok) partis++;
  }
  return partis;
}

/**
 * Avis de declaration : un membre dit avoir verse, la ligne attend validation.
 *
 * Un seul courrier, et non un par titulaire : le tresorier en destinataire, le
 * president et le membre qui declare en copie.
 *
 * Les envois separes ouvraient autant de fils de discussion que de
 * destinataires -- le tresorier repondait « c'est encaisse » a un courrier que
 * le president ne verrait jamais. Et l'auteur, exclu de la liste au motif qu'il
 * savait deja, n'avait aucune trace de sa propre declaration : il rouvrait le
 * site pour verifier qu'elle etait bien partie, ou ecrivait au groupe. La copie
 * lui tient lieu d'accuse de reception.
 *
 * A defaut de tresorier actif, le courrier va au premier titulaire du droit de
 * valider -- le president -- et la copie ne le double pas.
 */
/**
 * A qui adresser un avis qui attend une validation, et qui mettre en copie.
 *
 * COMMUN AUX DEUX AVIS. Le versement declare et le reglement de penalite
 * declare suivent la meme regle -- le tresorier decide, le president suit, le
 * declarant garde une copie qui lui tient d'accuse de reception -- et deux
 * ecritures de cette regle auraient fini par differer sur le seul point qui
 * compte : ne mettre personne en copie de son propre courrier.
 *
 * A defaut de tresorier joignable, l'avis va au premier titulaire du droit, et
 * la copie ne le double pas.
 */
async function aQuiValider(
  auteurId: string,
  droit: "validerVersement" | "gererPenalites",
): Promise<{
  principal: { email: string; role: Role };
  copie: { email: string; libelle: string }[];
  enCopie: string | null;
} | null> {
  const membres = await listerMembres().catch(() => []);
  const joignables = membres.filter((m) => m.actif && m.email);
  const valideurs = DROITS[droit] as readonly Role[];

  const principal =
    joignables.find((m) => m.role === "tresorier") ??
    joignables.find((m) => valideurs.includes(m.role));
  if (!principal) return null;

  /*
   * Une meme personne peut cumuler les qualites -- le tresorier qui declare
   * pour lui-meme, le president qui tient la caisse par interim -- et la casse
   * d'une adresse n'en fait pas une autre. On compare en minuscules, pour ne
   * mettre personne en copie de son propre courrier.
   */
  const declarant = joignables.find((m) => String(m.id) === auteurId);
  const president = joignables.find((m) => m.role === "president");
  const vues = new Set([principal.email.toLowerCase()]);
  const copie: { email: string; libelle: string }[] = [];
  for (const [personne, libelle] of [
    [president, "le president"],
    [declarant, "le membre qui declare"],
  ] as const) {
    if (!personne) continue;
    const adresse = personne.email.toLowerCase();
    if (vues.has(adresse)) continue;
    vues.add(adresse);
    copie.push({ email: personne.email, libelle });
  }

  const libelles = copie.map((c) => c.libelle);
  return {
    principal,
    copie,
    enCopie:
      libelles.length === 0
        ? null
        : `En copie : ${libelles.length === 1 ? libelles[0] : libelles.join(" et ")}.`,
  };
}

export async function avertirDeclaration(params: {
  auteurId: string;
  membreNom: string;
  mois: string[];
  montant: number;
  avecJustificatif: boolean;
}): Promise<number> {
  const destinataires = await aQuiValider(params.auteurId, "validerVersement");
  if (!destinataires) return 0;
  const { principal, copie, enCopie } = destinataires;

  const lignes = [
    "Bonjour,",
    "",
    `${params.membreNom} declare avoir verse ${fcfa(params.montant)}.`,
    params.mois.length === 1
      ? `Mois couvert : ${moisLong(params.mois[0])}.`
      : `Mois couverts : ${params.mois.map(moisLong).join(", ")}.`,
    params.avecJustificatif
      ? "Un justificatif est joint."
      : "Aucun justificatif n'est joint pour l'instant.",
    "",
    `A valider par le ${ROLES[principal.role].toLowerCase()}.` + (enCopie ? ` ${enCopie}` : ""),
    "La ligne est deja visible de tous, marquee « en attente » : rien ne se perd",
    "tant que la validation n'a pas eu lieu.",
  ];
  const siteUrl = lienDuSite();
  if (siteUrl) lignes.push("", `Valider : ${siteUrl}/versements`);
  lignes.push("", `Le suivi du club — ${CLUB.nom}`);

  const { ok } = await envoyerCourriel({
    destinataire: principal.email,
    copie: copie.map((c) => c.email),
    sujet: `${CLUB.sigle} — versement declare par ${params.membreNom}, a valider`,
    texte: lignes.join("\n"),
  });
  // Ce que l'appelant compte, ce sont les personnes atteintes, non les envois.
  return ok ? 1 + copie.length : 0;
}

/**
 * Le membre declare avoir regle une penalite : le tresorier doit le savoir.
 *
 * L'avis dit expressement que la penalite reste due tant qu'il ne s'est pas
 * prononce. Sans cette phrase, une declaration lue en diagonale ferait croire
 * l'affaire close -- et la relance du 10, qui continue de reclamer la somme,
 * passerait pour une erreur du site.
 */
export async function avertirReglementPenalite(params: {
  auteurId: string;
  membreNom: string;
  quantite: number;
  montant: number;
  avecJustificatif: boolean;
}): Promise<number> {
  const destinataires = await aQuiValider(params.auteurId, "gererPenalites");
  if (!destinataires) return 0;
  const { principal, copie, enCopie } = destinataires;

  const lignes = [
    "Bonjour,",
    "",
    `${params.membreNom} declare avoir regle ${params.quantite} ` +
      `${accorde(params.quantite, "penalite")}, ` +
      `soit ${fcfa(params.montant)}.`,
    params.avecJustificatif
      ? "Un justificatif est joint."
      : "Aucun justificatif n'est joint pour l'instant.",
    "",
    `A verifier par le ${ROLES[principal.role].toLowerCase()}.` + (enCopie ? ` ${enCopie}` : ""),
    "La penalite reste due jusqu'a la validation : rien n'entre en caisse sur",
    "parole, et la relance continue de la reclamer tant que la ligne n'est pas",
    "soldee.",
  ];
  const siteUrl = lienDuSite();
  if (siteUrl) lignes.push("", `Verifier : ${siteUrl}/penalites`);
  lignes.push("", `Le suivi du club — ${CLUB.nom}`);

  const { ok } = await envoyerCourriel({
    destinataire: principal.email,
    copie: copie.map((c) => c.email),
    sujet: `${CLUB.sigle} — reglement de penalite declare par ${params.membreNom}, a verifier`,
    texte: lignes.join("\n"),
  });
  return ok ? 1 + copie.length : 0;
}

/** Qui recoit ces avis, pour le dire a l'ecran. */
export function destinatairesAvis(roles: Record<Role, string>): string {
  return titulaires("validerVersement", roles);
}

/**
 * Avis d'absence, adresse au membre que le secretariat vient de pointer absent.
 *
 * Une absence se penalise par tranches, et se justifie en la passant en
 * « excuse ». Encore faut-il que l'interesse sache qu'elle a ete relevee : sans
 * avis, il decouvre la penalite au moment ou elle est constatee, quand il est
 * trop tard pour dire qu'il avait prevenu.
 */
export async function avertirAbsence(params: {
  membreId: string;
  seance: { date: string; titre: string | null };
  /** Absences injustifiees du membre, celle-ci comprise. */
  total: number;
  regles: { penaliteAbsence: number; absencesParTranche: number };
}): Promise<boolean> {
  const membres = await listerMembres().catch(() => []);
  const membre = membres.find((m) => String(m.id) === params.membreId);
  if (!membre?.email) return false;

  const { penaliteAbsence, absencesParTranche } = params.regles;
  const fermeUneTranche =
    absencesParTranche > 0 && params.total > 0 && params.total % absencesParTranche === 0;

  const lignes = [
    `Bonjour ${membre.nom},`,
    "",
    `Le secretariat a enregistre votre absence a la seance du ${dateCourte(params.seance.date)}` +
      `${params.seance.titre ? ` — ${params.seance.titre}` : ""}.`,
    "",
    `Vous comptez desormais ${params.total} ${accorde(params.total, "absence")} ` +
      `${accorde(params.total, "injustifiee")}.`,
    fermeUneTranche
      ? `Ce nombre ferme une tranche de ${absencesParTranche} : une penalite de ` +
        `${fcfa(penaliteAbsence)} est due.`
      : `A la prochaine absence injustifiee, une penalite de ${fcfa(penaliteAbsence)} sera due ` +
        `— le club sanctionne par tranche de ${absencesParTranche}, non l'empechement ponctuel.`,
    "",
    "Si votre absence etait justifiee, signalez-le au secretaire : il la passera en " +
      "« excuse », et elle sortira du compte penalisable.",
  ];
  const siteUrl = lienDuSite();
  if (siteUrl) lignes.push("", `Feuille de presence : ${siteUrl}/reunions`);
  lignes.push("", `Le suivi du club — ${CLUB.nom}`);

  const { ok } = await envoyerCourriel({
    destinataire: membre.email,
    sujet: `${CLUB.sigle} — absence relevee a la seance du ${dateCourte(params.seance.date)}`,
    texte: lignes.join("\n"),
  });
  return ok;
}

/**
 * Les acces d'un membre, envoyes a lui seul.
 *
 * Le president reinitialisait, lisait le mot de passe a l'ecran, puis le
 * recopiait dans WhatsApp -- ou il restait, lisible par qui ouvrirait le
 * telephone, et sans le lien du site que personne ne retenait.
 *
 * Le courrier ne vaut pas mieux qu'un message pour transporter un secret, mais
 * il va a une seule adresse au lieu d'un groupe de dix, et le mot de passe est
 * provisoire : le site exige d'en choisir un autre avant de s'ouvrir. Ce qui
 * transite ici ne sert qu'une fois.
 */
export async function envoyerAcces(
  membre: { nom: string; email: string },
  motDePasseProvisoire: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = lienDuSite();
  const prenom = membre.nom.trim().split(/\s+/)[1] ?? membre.nom;

  const lignes = [
    `Bonjour ${prenom},`,
    "",
    `Votre acces au site du club ${CLUB.nom} est pret.`,
    "",
    ...(url ? [`Adresse du site : ${url}`, ""] : []),
    `Identifiant : ${membre.email}`,
    `Mot de passe provisoire : ${motDePasseProvisoire}`,
    "",
    "Ce mot de passe ne sert qu'une fois : a la premiere connexion, le site vous",
    "demande d'en choisir un autre, connu de vous seul. Le president lui-meme ne",
    "peut pas le lire.",
    "",
    "Vous y verrez a tout moment ce que vous avez verse, ce que vous devez, et ce",
    "que vaut votre part du portefeuille. Les comptes sont ouverts a tous les",
    "membres : c'est le principe de l'article 12.",
    "",
    "Si cette adresse n'est pas la votre, ou si vous n'avez pas demande cet acces,",
    "signalez-le au president.",
    "",
    `Le bureau — ${CLUB.nom}`,
  ];

  return envoyerCourriel({
    destinataire: membre.email,
    sujet: `${CLUB.sigle} — votre acces au site du club`,
    texte: lignes.join("\n"),
  });
}
