import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";
import {
  declarationsRetard,
  listerApports,
  listerMembres,
  listerMouvementsCaisse,
  listerPenalites,
  listerReunions,
  listerValorisations,
  listerVersements,
  netApport,
  objectifDuClub,
  presencesParReunion,
  situationsClub,
  synthese,
  type Reunion,
} from "./queries";
import { heureLieuDeReunion } from "./sondage";
import { bulletinsDes, electeursDu, listerVotes } from "./votes";
import { STATUT_VOTE, depouiller, pourcent } from "./scrutin";
import { KIND_PENALITE, STATUT_CAISSE, STATUT_PENALITE, STATUT_VERSEMENT } from "./valeurs";
import { dateCourte, fcfa, moisLong } from "./settings";
import type { DonneesRapport } from "./rapport-reunion";

/** Le meme texte que scripts/migration-rapports.sql. */
const TABLES = [
  `create table if not exists meeting_points (
    meeting_id uuid primary key references meetings(id) on delete cascade,
    points     text not null default '[]',
    updated_at timestamptz not null default now()
  )`,
];

/** Les points ajoutes par le bureau a l'ordre du jour d'une seance. */
export async function pointsDeReunion(reunionId: string): Promise<string[]> {
  const sql = db();
  try {
    const rows = await avecTables(TABLES, () => sql`select points from meeting_points where meeting_id = ${reunionId}::uuid`);
    const liste = rows[0] ? (JSON.parse(String(rows[0].points)) as unknown) : [];
    return Array.isArray(liste) ? liste.map(String).filter((p) => p.trim() !== "") : [];
  } catch {
    return [];
  }
}

export async function enregistrerPoints(reunionId: string, points: string[]): Promise<void> {
  const sql = db();
  await avecTables(TABLES, () => sql`
    insert into meeting_points (meeting_id, points, updated_at) values (${reunionId}::uuid, ${JSON.stringify(points)}, now())
    on conflict (meeting_id) do update set points = excluded.points, updated_at = now()
  `);
}

/** Dans la periode : apres le debut (exclu), jusqu'a la fin (incluse). */
const dans = (jour: string, debut: string | null, fin: string) => (debut === null || jour > debut) && jour <= fin;

/**
 * Les chiffres d'une seance : ce qui s'est passe depuis la precedente,
 * arretes au jour de la seance (ou a aujourd'hui, si elle est a venir).
 */
export async function donneesRapport(reunionId: string, maintenant = new Date()): Promise<{ donnees: DonneesRapport; reunion: Reunion } | null> {
  const reunions = await listerReunions();
  const reunion = reunions.find((r) => r.id === reunionId);
  if (!reunion) return null;
  const depuis = reunions.find((r) => r.date_reunion < reunion.date_reunion)?.date_reunion ?? null;
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const arrete = reunion.date_reunion < aujourdhui ? reunion.date_reunion : aujourdhui;

  const [s, situations, valos, apports, penalites, mouvements, objectif, presences, membres, declarations, versements, votes, points, heureLieu] =
    await Promise.all([
      synthese(),
      situationsClub(),
      listerValorisations(),
      listerApports(),
      listerPenalites().catch(() => []),
      listerMouvementsCaisse().catch(() => []),
      objectifDuClub(),
      presencesParReunion(),
      listerMembres(true),
      declarationsRetard(),
      listerVersements({ statut: STATUT_VERSEMENT.valide }),
      listerVotes().catch(() => []),
      pointsDeReunion(reunionId),
      heureLieuDeReunion(reunionId),
    ]);

  /* Le portefeuille au dernier releve de la periode, et sa variation hors apports (Dietz simple). */
  const releves = [...valos].filter((v) => v.date_valo <= arrete).sort((a, b) => a.date_valo.localeCompare(b.date_valo));
  const fin = releves.at(-1) ?? null;
  const debut = depuis ? ([...releves].reverse().find((v) => v.date_valo <= depuis) ?? null) : null;
  let variation: number | null = null;
  if (fin && debut && debut.id !== fin.id && debut.total > 0) {
    const a = apports.filter((x) => x.date_transfert > debut.date_valo && x.date_transfert <= fin.date_valo).reduce((t, x) => t + netApport(x), 0);
    variation = (fin.total - debut.total - a) / (debut.total + a / 2);
  }

  /* Les mois echus dans la periode : ceux dont l'echeance tombe entre les deux seances. */
  const moisPeriode = [...new Set(situations.flatMap((x) => x.cellules.map((c) => c.mois)))]
    .filter((m) => dans(`${m.slice(0, 8)}10`, depuis, arrete))
    .sort();
  const cotisations = moisPeriode.map((mois) => {
    const cellules = situations.map((x) => x.cellules.find((c) => c.mois === mois)).filter((c) => c && c.statut !== "hors_periode");
    return {
      mois,
      attendu: cellules.reduce((t, c) => t + (c?.requis ?? 0), 0),
      encaisse: cellules.reduce((t, c) => t + (c?.montant ?? 0), 0),
      aLHeure: cellules.filter((c) => c?.statut === "paye").length,
      dus: cellules.length,
      impayes: cellules.filter((c) => c?.statut === "retard" || c?.statut === "partiel").length,
    };
  });

  const encaisse = versements.filter((v) => dans(v.date_versement, depuis, arrete)).reduce((t, v) => t + v.montant, 0);
  const retards = situations
    .filter((x) => x.nbMoisRetard > 0)
    .map((x) => ({
      nom: membres.find((m) => m.id === x.membreId)?.nom ?? x.nom,
      mois: x.moisEnRetard,
      jours: x.joursDeRetard,
      suspendu: x.voteSuspendu,
      declarationExigee: x.declarationRequise,
      declare: declarations.some((d) => d.membre_id === x.membreId && x.moisEnRetard.includes(d.mois)),
    }));

  const penPeriode = penalites.filter((p) => p.statut !== STATUT_PENALITE.annulee && dans(p.date_constat, depuis, arrete));
  const caisse = mouvements
    .filter((m) => m.statut === STATUT_CAISSE.valide && dans(m.date_mouvement, depuis, arrete))
    .map((m) => ({ date: m.date_mouvement, libelle: m.note ?? m.categorie, montant: m.montant, depense: m.sens === "depense" }));

  /* Les votes de la periode : en cours a la date d'arret, ou clos dans la periode. */
  const votesPeriode = votes.filter(
    (v) =>
      v.statut !== STATUT_VOTE.annule &&
      v.creeLe.toISOString().slice(0, 10) <= arrete &&
      (v.cloture.toISOString().slice(0, 10) >= arrete || dans(v.cloture.toISOString().slice(0, 10), depuis, arrete)),
  );
  const bulletins = await bulletinsDes(votesPeriode.map((v) => v.id));
  const lignesVotes = await Promise.all(
    votesPeriode.map(async (v) => {
      const r = depouiller(await electeursDu(v), bulletins.filter((b) => b.voteId === v.id), v.majorite);
      const ouvert = v.statut === STATUT_VOTE.ouvert && maintenant < v.cloture;
      return {
        question: v.question,
        etat: ouvert
          ? `en cours, clôture le ${dateCourte(v.cloture.toISOString().slice(0, 10))} à 20 h GMT, ${r.votants} ${r.votants > 1 ? "votants" : "votant"} sur ${r.admis}`
          : `${r.adopte ? "adopté" : "rejeté"}, ${pourcent(r.tauxPour)} des voix pour`,
      };
    }),
  );

  const feuille = presences.get(reunionId);
  const noms = (statut: string) =>
    feuille ? [...feuille.entries()].filter(([, st]) => st === statut).map(([id]) => membres.find((m) => m.id === id)?.nom ?? id) : [];

  return {
    reunion,
    donnees: {
      date: reunion.date_reunion,
      heure: heureLieu?.heure ?? null,
      lieu: heureLieu?.lieu ?? null,
      depuis,
      arrete,
      portefeuille: fin ? { valeur: fin.total, dateValeur: fin.date_valo, variation } : null,
      objectif:
        objectif && fin
          ? { taux: fin.total / objectif.montant, intitule: objectif.intitule ?? `${fcfa(objectif.montant)} pour ${moisLong(objectif.echeance)}` }
          : null,
      cotisations,
      encaisse,
      aJour: { n: situations.filter((x) => x.nbMoisRetard === 0).length, total: situations.length },
      retards,
      penalites: {
        inscrites: penPeriode.reduce((t, p) => t + p.montant, 0),
        reglees: penalites
          .filter((p) => p.statut === STATUT_PENALITE.payee && p.date_reglement && dans(p.date_reglement, depuis, arrete))
          .reduce((t, p) => t + p.montant, 0),
        absences: penPeriode.filter((p) => p.nature === KIND_PENALITE.absence).reduce((t, p) => t + p.quantite, 0),
      },
      caisse: { mouvements: caisse, solde: Number.isFinite(s.totalEnCaisse) ? s.totalEnCaisse : null },
      votes: lignesVotes,
      points,
      presences: feuille && feuille.size > 0 ? { presents: noms("present"), excuses: noms("excuse"), absents: noms("absent") } : null,
    },
  };
}
