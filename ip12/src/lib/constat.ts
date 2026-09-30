import "server-only";
import { db } from "@/lib/db";
import {
  bornesReprisePenalites, listerMembres, listerPenalites, situationsClub,
} from "@/lib/queries";
import { DROITS } from "@/lib/droits";
import type { Role } from "@/lib/settings";
import { cleRetard, dejaAuRegistre, echeanceDuMois } from "@/lib/penalites";
import { moisLong } from "@/lib/settings";
import { KIND_PENALITE, STATUT_PENALITE } from "@/lib/valeurs";

/**
 * Transcription au registre des penalites que l'art. 9 fait courir.
 *
 * POURQUOI CE CODE A QUITTE L'ACTION.
 *
 * Il n'avait qu'un appelant : le bouton « Porter au registre » de la page
 * Penalites. Le registre n'avancait donc que quand le bureau y pensait -- alors
 * que la penalite est acquise de plein droit des l'echeance passee. Le decalage
 * n'etait pas anodin : le seuil de R5 ne compte que les penalites INSCRITES, si
 * bien qu'un membre dont les penalites n'etaient jamais constatees ne
 * s'approchait jamais du seuil d'exclusion, quel que soit son retard. L'oubli
 * d'un clic le protegeait d'une regle votee par l'assemblee.
 *
 * La relance appelle desormais ce constat avant d'ecrire ses courriers. Le
 * registre est donc a jour au moment ou l'on annonce une dette, et la page garde
 * son bouton pour les constats hors relance.
 */
export type IssueConstat = {
  /** Penalites nouvellement inscrites. */
  creees: number;
  /** Montants revus, R4 ayant double les trois derniers mois. */
  reajustees: number;
  /** Deja reglees ou annulees : jamais retouchees. */
  intactes: number;
  /** Mois couverts par la reprise du tresorier, non recomptes. */
  couvertes: number;
};

/** Motif lisible, qui dit pourquoi la penalite est due et a quel titre. */
export function motifPenalite(p: { mois: string; doublee: boolean; figee: boolean }): string {
  const base = `Retard de versement — ${moisLong(p.mois)}`;
  if (p.figee) return `${base} (regle apres l'echeance, penalite acquise, art. 9)`;
  return p.doublee ? `${base} (doublee, R4)` : base;
}

/**
 * Porte au registre ce que les statuts prevoient pour les mois impayes.
 *
 * Rejouable sans risque. Une penalite deja reglee ou annulee n'est jamais
 * retouchee : seules celles encore dues voient leur montant reajuste, ce qui
 * compte puisque R4 double les trois derniers mois des que le retard atteint
 * trois mois.
 *
 * `auteurId` porte la signature de l'ecriture. Appele par la relance, c'est le
 * titulaire du droit sur les penalites -- l'ecriture reste nominative, et le
 * journal dit sous quel titre elle a eu lieu.
 */
export async function porterRetardsAuRegistre(auteurId: string): Promise<IssueConstat> {
  const sql = db();
  const [situations, bornes] = await Promise.all([situationsClub(), bornesReprisePenalites()]);

  const issue: IssueConstat = { creees: 0, reajustees: 0, intactes: 0, couvertes: 0 };

  for (const s of situations) {
    const borne = bornes.get(s.membreId);
    for (const p of s.penalites) {
      // Deja compte dans la reprise du tresorier : ne pas le compter une seconde fois.
      if (borne && p.mois <= borne) {
        issue.couvertes++;
        continue;
      }
      const cle = cleRetard(s.membreId, p.mois);
      const echeance = echeanceDuMois(p.mois);

      /*
       * On cherche la ligne par sa cle, mais aussi par le couple membre-echeance :
       * la base porte des penalites ecrites par une version anterieure, dont les
       * cles suivaient une autre convention (`retard:2026-04`, sans identifiant de
       * membre, et une ligne `majoration:` distincte pour R4). Ne chercher que ses
       * propres cles reviendrait a recreer ce qui existe deja sous un autre nom.
       */
      const existante = await sql`
        select id, status, unit_amount, source_key from penalties
        where source_key = ${cle}
           or (member_id = ${s.membreId}::uuid
               and kind = ${KIND_PENALITE.retard}
               and incurred_on = ${echeance}::date)
        limit 1
      `;

      if (existante.length === 0) {
        await sql`
          insert into penalties (member_id, kind, quantity, unit_amount, reason,
                                 incurred_on, status, created_by, source_key, auto)
          values (${s.membreId}::uuid, ${KIND_PENALITE.retard}, 1, ${p.montant},
                  ${motifPenalite(p)},
                  ${echeance}::date, ${STATUT_PENALITE.due}, ${auteurId}::uuid, ${cle}, true)
        `;
        issue.creees++;
        continue;
      }

      const courante = existante[0];
      if (courante.status !== STATUT_PENALITE.due || courante.source_key !== cle) {
        // Soldee, ou ecrite par une autre version : on n'y touche pas.
        issue.intactes++;
      } else if (Number(courante.unit_amount) !== p.montant) {
        await sql`
          update penalties
          set unit_amount = ${p.montant},
              reason = ${motifPenalite(p)}
          where id = ${courante.id}::uuid
        `;
        issue.reajustees++;
      }
    }
  }

  return issue;
}

/**
 * Ce que l'art. 9 fait courir et que le registre ne porte pas encore, par membre.
 *
 * UNE SEULE FOIS, POUR TROIS LECTEURS. Le courrier de relance, le recapitulatif
 * au bureau et la page « Mon compte » doivent annoncer la meme somme : la dette
 * inscrite plus ce qui court. Trois calculs auraient fini par donner trois
 * chiffres, et c'est exactement le defaut qu'on vient de corriger deux fois.
 *
 * La relance constate avant d'ecrire, si bien que cette part est normalement
 * vide au moment ou elle parle. Elle ne l'est pas le reste du mois : un mois
 * devient impaye le 11, et le constat suivant ne passe que le 7. C'est cette
 * fenetre que cette lecture couvre.
 *
 * Rend `null` si le registre n'a pas pu etre lu. L'appelant traite alors ce
 * qui court comme nul : mieux vaut taire une penalite que la reclamer deux fois.
 */
export async function penalitesNonInscrites(
  situations: { membreId: string; penalites: { mois: string; montant: number }[] }[],
): Promise<Map<string, { nb: number; montant: number; mois: string[] }> | null> {
  let registre: { membreId: string; nature: string; dateConstat: string; cle: string | null }[];
  let bornes: Map<string, string>;
  try {
    const [lignes, reprises] = await Promise.all([
      listerPenalites(),
      bornesReprisePenalites().catch(() => new Map<string, string>()),
    ]);
    registre = lignes.map((p) => ({
      membreId: p.membre_id,
      nature: p.nature,
      dateConstat: p.date_constat,
      cle: p.source_key,
    }));
    bornes = reprises;
  } catch {
    return null;
  }

  const index = new Map<string, { nb: number; montant: number; mois: string[] }>();
  for (const s of situations) {
    const courues = s.penalites.filter(
      (p) => !dejaAuRegistre(s.membreId, p.mois, registre, bornes.get(s.membreId)),
    );
    index.set(s.membreId, {
      nb: courues.length,
      montant: courues.reduce((t, p) => t + p.montant, 0),
      mois: courues.map((p) => p.mois),
    });
  }
  return index;
}

/** Ce que le constat a fait, en une phrase. */
export function resumeConstat({ creees, reajustees, intactes, couvertes }: IssueConstat): string {
  const sousReprise =
    couvertes > 0
      ? ` ${couvertes} mois relevent de la reprise du tresorier et ne sont pas recomptes.`
      : "";
  if (creees === 0 && reajustees === 0) {
    return `Le registre est deja a jour, rien a constater.${sousReprise}`;
  }
  const parts: string[] = [];
  if (creees > 0) {
    parts.push(`${creees} penalite${creees > 1 ? "s" : ""} constatee${creees > 1 ? "s" : ""}`);
  }
  if (reajustees > 0) parts.push(`${reajustees} reajustee${reajustees > 1 ? "s" : ""} (R4)`);
  if (intactes > 0) {
    parts.push(
      `${intactes} deja reglee${intactes > 1 ? "s" : ""} ou annulee${intactes > 1 ? "s" : ""}, ` +
        `laissee${intactes > 1 ? "s" : ""} intacte${intactes > 1 ? "s" : ""}`,
    );
  }
  return `${parts.join(", ")}.${sousReprise}`;
}

/**
 * Qui signe un constat que personne n'a declenche a la main.
 *
 * La colonne `created_by` du registre n'accepte pas le vide : une ecriture porte
 * un nom. La relance emprunte donc celui du premier titulaire du droit sur les
 * penalites -- le tresorier, le president a defaut. Sans titulaire joignable, le
 * constat n'a pas lieu : mieux vaut un registre en retard qu'une ecriture
 * anonyme dans un livre de comptes.
 */
export async function signataireDuConstat(): Promise<{ id: string; nom: string } | null> {
  const titulaires = DROITS.gererPenalites as readonly Role[];
  const membres = await listerMembres().catch(() => []);
  const actifs = membres.filter((m) => m.actif && titulaires.includes(m.role));
  const choisi =
    actifs.find((m) => m.role === "tresorier") ?? actifs.find((m) => m.role === "president") ?? null;
  return choisi ? { id: String(choisi.id), nom: choisi.nom } : null;
}
