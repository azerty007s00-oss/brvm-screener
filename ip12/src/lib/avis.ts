import "server-only";
import { listerMembres } from "@/lib/queries";
import { envoyerCourriel } from "@/lib/courriel";
import { CLUB, dateCourte, fcfa, moisLong, variable } from "@/lib/settings";
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
  const penalites = destinataires.reduce((t, d) => t + d.situation.totalPenalites, 0);
  const attendus = destinataires.filter((d) => d.echeanceDuJour !== null).length;

  const lignes: string[] = [
    "Bonjour,",
    "",
    `Relance de ${moisLong(maintenant.toISOString().slice(0, 8) + "01")} : ` +
      `${destinataires.length} membre(s) viennent d'etre relances.`,
    "",
    "A ENCAISSER",
    `  Echeances du jour : ${attendus} membre(s).`,
    `  Mois en retard : ${moisDus}, repartis sur ${enRetard.length} membre(s).`,
    `  Penalites dues a ce jour : ${fcfa(penalites)}.`,
    "",
    "DETAIL",
  ];

  for (const d of destinataires) {
    const motifs: string[] = [];
    if (d.echeanceDuJour) motifs.push("echeance du jour");
    if (d.arrieres.length > 0) motifs.push(`${d.arrieres.length} mois en retard`);
    if (d.situation.nbPenalitesImpayees > 0) {
      motifs.push(`${d.situation.nbPenalitesImpayees} penalite(s) impayee(s)`);
    }
    if (d.avanceManquante) motifs.push("avance obligatoire non tenue");
    lignes.push(`  ${d.situation.nom} — ${motifs.join(", ")}`);
  }

  const siteUrl = variable("NEXT_PUBLIC_SITE_URL", "");
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
 * Adresse aux titulaires du droit de valider. L'auteur de la declaration en est
 * exclu : s'avertir soi-meme n'apprend rien, et le tresorier qui saisit pour lui
 * recevrait un courrier a chaque geste.
 */
export async function avertirDeclaration(params: {
  auteurId: string;
  membreNom: string;
  mois: string[];
  montant: number;
  avecJustificatif: boolean;
}): Promise<number> {
  const bureau = await adresses("validerVersement");
  const membres = await listerMembres().catch(() => []);
  const auteur = membres.find((m) => String(m.id) === params.auteurId);

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
    "La ligne est visible de tous et attend votre validation.",
  ];
  const siteUrl = variable("NEXT_PUBLIC_SITE_URL", "");
  if (siteUrl) lignes.push("", `Valider : ${siteUrl}/versements`);
  lignes.push("", `Le suivi du club — ${CLUB.nom}`);

  let partis = 0;
  for (const m of bureau) {
    // Averti celui qui vient de saisir n'apprend rien a personne.
    if (auteur && m.email === auteur.email) continue;
    const { ok } = await envoyerCourriel({
      destinataire: m.email,
      sujet: `${CLUB.sigle} — versement declare par ${params.membreNom}, a valider`,
      texte: lignes.join("\n"),
    });
    if (ok) partis++;
  }
  return partis;
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
    `Vous comptez desormais ${params.total} absence(s) injustifiee(s).`,
    fermeUneTranche
      ? `Ce nombre ferme une tranche de ${absencesParTranche} : une penalite de ` +
        `${fcfa(penaliteAbsence)} est due.`
      : `A la prochaine absence injustifiee, une penalite de ${fcfa(penaliteAbsence)} sera due ` +
        `— le club sanctionne par tranche de ${absencesParTranche}, non l'empechement ponctuel.`,
    "",
    "Si votre absence etait justifiee, signalez-le au secretaire : il la passera en " +
      "« excuse », et elle sortira du compte penalisable.",
  ];
  const siteUrl = variable("NEXT_PUBLIC_SITE_URL", "");
  if (siteUrl) lignes.push("", `Feuille de presence : ${siteUrl}/reunions`);
  lignes.push("", `Le suivi du club — ${CLUB.nom}`);

  const { ok } = await envoyerCourriel({
    destinataire: membre.email,
    sujet: `${CLUB.sigle} — absence relevee a la seance du ${dateCourte(params.seance.date)}`,
    texte: lignes.join("\n"),
  });
  return ok;
}
