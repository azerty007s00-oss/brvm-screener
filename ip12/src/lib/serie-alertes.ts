import "server-only";
import { after } from "next/server";
import { db } from "./db";
import { envoyerAlertes, type Alerte } from "./alertes";
import { listerMembres, reglagesEffectifs, situationsClub } from "./queries";
import { debutMois, decalerMois } from "./settings";
import {
  alerteClubAJour,
  alerteSerieJ3,
  alerteSerieJourJ,
  alerteSerieTombee,
  alerteSerieValidee,
  record,
  serieEnCours,
  type MoisSerie,
} from "./serie";

/** Le mois courant traite comme « pas encore paye » : la serie d'avant ce mois. */
function sansMois(cellules: MoisSerie[], mois: string[], moisCourant: string): MoisSerie[] {
  return cellules.map((c) => (mois.includes(c.mois) ? { ...c, statut: c.mois === moisCourant ? "a_venir" : "retard" } : c));
}

/**
 * Le membre apprend la validation de son versement. Paye a l'heure, c'est
 * sa serie qui le lui dit (et son record, s'il tombe) ; sinon, l'avis
 * ordinaire. Si tout le club est desormais a l'heure, tout le monde le sait,
 * une fois par mois.
 */
export function alerterValidation(membreId: string, moisValides: string[], ordinaire: Alerte): void {
  try {
    after(async () => {
      try {
        const [situations, reglages] = await Promise.all([situationsClub(), reglagesEffectifs()]);
        const moisCourant = debutMois();
        const ligne = situations.find((x) => x.membreId === membreId);
        const aLHeure = ligne && !ligne.titulaireId
          ? ligne.cellules.filter((c) => moisValides.includes(c.mois) && c.mois <= moisCourant && c.statut === "paye")
          : [];
        if (ligne && aLHeure.length > 0) {
          const n = serieEnCours(ligne.cellules, moisCourant);
          const avant = record(sansMois(ligne.cellules, moisValides, moisCourant), moisCourant);
          const moisPaye = aLHeure.map((c) => c.mois).sort().at(-1)!;
          await envoyerAlertes([membreId], {
            ...alerteSerieValidee(n, avant, moisPaye, reglages.jourEcheance),
            corpsVoile: ordinaire.corpsVoile,
            url: "/",
            etiquette: "serie",
          });
        } else {
          await envoyerAlertes([ligne?.titulaireId ?? membreId], ordinaire);
        }

        /* Tout le club a l'heure ce mois-ci : une fois, grace a une cle posee sans doublon. */
        const tous = situations.every((x) => {
          const c = x.cellules.find((y) => y.mois === moisCourant);
          return !c || c.statut === "hors_periode" || c.statut === "paye";
        });
        if (tous) {
          const sql = db();
          const pris = await sql`
            insert into settings (key, value) values (${`club_a_jour:${moisCourant.slice(0, 7)}`}, ${new Date().toISOString()})
            on conflict (key) do nothing returning key
          `;
          if (pris.length > 0) {
            const personnes = (await listerMembres()).filter((m) => m.actif && !m.titulaireId);
            await envoyerAlertes(
              personnes.map((m) => m.id),
              { ...alerteClubAJour(personnes.length, reglages.jourEcheance), url: "/", etiquette: `club-a-jour-${moisCourant}` },
            );
          }
        }
      } catch {
        // L'avis perdu se rattrape sur l'accueil : la serie s'y lit.
      }
    });
  } catch {
    // Hors requete : rien a differer.
  }
}

/**
 * Le passage de 18 h, cote serie : trois jours avant l'echeance et le jour
 * meme, a qui a une serie en jeu et n'a pas encore paye ; le lendemain, a qui
 * l'a perdue. Les autres jours, rien. Une personne seulement : une part
 * rachetee n'a pas de serie a elle.
 */
export async function passageSerie(maintenant: Date): Promise<{ j3: number; jourJ: number; tombees: number }> {
  const bilan = { j3: 0, jourJ: 0, tombees: 0 };
  const reglages = await reglagesEffectifs();
  const je = reglages.jourEcheance;
  const jour = maintenant.getUTCDate();
  if (jour !== je - 3 && jour !== je && jour !== je + 1) return bilan;

  const moisCourant = debutMois(maintenant);
  const situations = await situationsClub(maintenant);
  for (const x of situations) {
    if (x.titulaireId) continue;
    const c = x.cellules.find((y) => y.mois === moisCourant);
    if (!c) continue;
    if (jour === je - 3 || jour === je) {
      if (c.statut !== "a_venir" && c.statut !== "partiel") continue;
      const n = serieEnCours(x.cellules, moisCourant);
      if (n < 1) continue;
      await envoyerAlertes([x.membreId], {
        ...(jour === je ? alerteSerieJourJ(n) : alerteSerieJ3(n, je)),
        url: "/versements",
        etiquette: "serie",
      });
      if (jour === je) bilan.jourJ++;
      else bilan.j3++;
    } else if (c.statut === "retard" || c.statut === "partiel") {
      const n = serieEnCours(sansMois(x.cellules, [moisCourant], moisCourant), moisCourant);
      if (n < 2) continue;
      await envoyerAlertes([x.membreId], {
        ...alerteSerieTombee(n, decalerMois(moisCourant, 1), je),
        url: "/versements",
        etiquette: "serie",
      });
      bilan.tombees++;
    }
  }
  return bilan;
}
