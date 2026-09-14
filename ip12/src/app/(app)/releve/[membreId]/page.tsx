import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import {
  listerMembres,
  listerPenalites,
  listerVersements,
  situationsClub,
  synthese,
} from "@/lib/queries";
import { CLUB, REGLES, ROLES, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { pourcent } from "@/lib/perf";
import { STATUT_PENALITE, STATUT_VERSEMENT, libelleMode } from "@/lib/valeurs";
import { BoutonImprimer } from "@/components/impression";
import { Alerte, Carte } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

/**
 * Releve individuel, fait pour le papier.
 *
 * Ce qu'un membre demande quand il veut une preuve : ce qu'il a verse, ce qu'il
 * doit, ce que vaut sa part, et a quelle date le tout a ete arrete. Un ecran ne
 * se signe pas et ne se classe pas.
 */
export default async function PageReleve({ params }: { params: Promise<{ membreId: string }> }) {
  const { membreId } = await params;
  const lecteur = await exigerMembre();

  /*
   * Chacun imprime le sien ; le bureau imprime celui de tous, puisqu'il tient les
   * comptes. Un membre n'a pas a editer la piece d'un autre, meme si les soldes du
   * club sont ouverts a tous (art. 12).
   */
  const sien = membreId === lecteur.id;
  if (!sien && !peut(lecteur, "validerVersement") && !peut(lecteur, "gererReglages")) {
    return (
      <Carte titre="Releve">
        <Alerte ton="rouge">
          Vous pouvez editer votre propre releve. Celui d&apos;un autre membre revient au bureau.
        </Alerte>
        <Link href={`/releve/${lecteur.id}`} className="text-sm underline">
          Voir mon releve
        </Link>
      </Carte>
    );
  }

  let membres, situations, s, versements, penalites;
  try {
    [membres, situations, s, versements, penalites] = await Promise.all([
      listerMembres(true),
      situationsClub(),
      synthese(),
      listerVersements({ membreId }),
      listerPenalites({ membreId }),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const membre = membres.find((m) => String(m.id) === membreId);
  const situation = situations.find((x) => x.membreId === membreId);
  const part = s.parts.find((p) => p.membreId === membreId);
  if (!membre) {
    return (
      <Carte titre="Releve">
        <Alerte ton="rouge">Membre introuvable.</Alerte>
      </Carte>
    );
  }

  const regles = versements.filter((v) => v.statut === STATUT_VERSEMENT.valide);
  const totalVerse = regles.reduce((t, v) => t + v.montant, 0);
  const penalitesDues = penalites.filter((p) => p.statut === STATUT_PENALITE.due);
  const penalitesReglees = penalites.filter((p) => p.statut === STATUT_PENALITE.payee);
  const totalDu = penalitesDues.reduce((t, p) => t + p.montant, 0);
  const edite = new Date().toISOString().slice(0, 10);

  const ligne = (libelle: string, valeur: string) => (
    <li className="flex justify-between gap-3 py-1">
      <span style={{ color: "var(--discret)" }}>{libelle}</span>
      <span className="tabular-nums">{valeur}</span>
    </li>
  );

  return (
    <>
      <div className="sans-impression flex flex-wrap items-center justify-between gap-2">
        <Link href="/mon-compte" className="text-xs underline" style={{ color: "var(--discret)" }}>
          Retour
        </Link>
        <BoutonImprimer libelle="Imprimer ce releve" />
      </div>

      <div className="a-imprimer impression-encadre rounded-xl border p-5"
        style={{ background: "var(--carte)", borderColor: "var(--bordure)" }}
      >
        <header className="border-b pb-3" style={{ borderColor: "var(--bordure)" }}>
          <p className="text-xs uppercase tracking-widest" style={{ color: "var(--discret)" }}>
            {CLUB.nom} &middot; {CLUB.ville}
          </p>
          <h1 className="mt-1 text-xl font-semibold">Releve individuel</h1>
          <p className="mt-1 text-sm">
            {membre.nom} &middot; {ROLES[membre.role]}
            {membre.date_adhesion ? ` · membre depuis le ${dateCourte(membre.date_adhesion)}` : ""}
          </p>
          <p className="text-xs" style={{ color: "var(--discret)" }}>
            Edite le {dateCourte(edite)}
            {s.valorisation ? ` · arrete au dernier releve du ${dateCourte(s.valorisation.date_valo)}` : ""}
          </p>
        </header>

        <section className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <h2 className="mb-1 text-sm font-semibold">Versements</h2>
            <ul className="text-sm">
              {ligne("Mois regles", String(regles.length))}
              {ligne("Total verse", fcfa(totalVerse))}
              {ligne("Mois en retard", String(situation?.nbMoisRetard ?? 0))}
            </ul>
          </div>
          <div>
            <h2 className="mb-1 text-sm font-semibold">Part au capital (art. 12)</h2>
            <ul className="text-sm">
              {ligne("Capital acquis", part ? fcfa(part.acquis) : "--")}
              {part && part.avance > 0 ? ligne("Avance en depot", fcfa(part.avance)) : null}
              {part && part.dues > 0 ? ligne("Penalites deduites", `- ${fcfa(part.dues)}`) : null}
              {ligne("Quote-part", part ? pourcent(part.part, 2).replace("+", "") : "--")}
              {ligne("Valeur de la part", part ? fcfa(part.valeur) : "--")}
              {ligne("Plus-value", part ? fcfa(part.plusValue) : "--")}
            </ul>
          </div>
        </section>

        <section className="mt-4">
          <h2 className="mb-1 text-sm font-semibold">Penalites (art. 9)</h2>
          <ul className="text-sm">
            {ligne("Dues a ce jour", fcfa(totalDu))}
            {ligne("Deja reglees", fcfa(penalitesReglees.reduce((t, p) => t + p.montant, 0)))}
          </ul>
          {penalitesDues.length > 0 && (
            <ul className="mt-2 text-xs" style={{ color: "var(--discret)" }}>
              {penalitesDues.map((p) => (
                <li key={p.id}>
                  {dateCourte(p.date_constat)} &middot; {p.motif ?? p.nature} &middot; {fcfa(p.montant)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4">
          <h2 className="mb-1 text-sm font-semibold">Detail des versements</h2>
          {versements.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--discret)" }}>
              Aucun versement enregistre.
            </p>
          ) : (
            <div className="defilement-x">
              <table className="w-full min-w-[26rem] text-xs">
                <thead>
                  <tr style={{ color: "var(--discret)" }}>
                    <th className="py-1 text-left font-medium">Mois</th>
                    <th className="py-1 text-right font-medium">Montant</th>
                    <th className="py-1 text-left font-medium">Verse le</th>
                    <th className="py-1 text-left font-medium">Mode</th>
                    <th className="py-1 text-left font-medium">Etat</th>
                  </tr>
                </thead>
                <tbody>
                  {versements.map((v) => (
                    <tr key={v.id} className="border-t" style={{ borderColor: "var(--bordure)" }}>
                      <td className="py-1">{moisLong(v.mois)}</td>
                      <td className="py-1 text-right tabular-nums">{fcfa(v.montant)}</td>
                      <td className="py-1">{dateCourte(v.date_versement)}</td>
                      <td className="py-1">{libelleMode(v.mode)}</td>
                      <td className="py-1">
                        {v.statut === STATUT_VERSEMENT.valide
                          ? "Valide"
                          : v.statut === STATUT_VERSEMENT.rejete
                            ? "Annule"
                            : "En attente"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {situation && situation.nbMoisRetard > 0 && (
          <section className="mt-4">
            <h2 className="mb-1 text-sm font-semibold">Situation statutaire</h2>
            <ul className="text-xs" style={{ color: "var(--discret)" }}>
              <li>
                {situation.nbMoisRetard} mois en retard, dont le plus ancien depuis{" "}
                {situation.joursDeRetard} jours.
              </li>
              {situation.voteSuspendu && (
                <li>
                  Droit de vote suspendu (R2, au-dela de {REGLES.suspensionVoteApresJours} jours),
                  jusqu&apos;a regularisation complete.
                </li>
              )}
              {situation.declarationRequise && (
                <li>Declaration au groupe exigee par R3, et non encore enregistree.</li>
              )}
              {situation.exclusionEncourue && (
                <li>Exclusion encourue au titre de l&apos;art. 20 et de R5.</li>
              )}
            </ul>
          </section>
        )}

        <footer className="mt-5 border-t pt-3 text-[11px]" style={{ borderColor: "var(--bordure)", color: "var(--discret)" }}>
          Piece editee par l&apos;outil de suivi du club, sur les ecritures validees a la date
          d&apos;edition. La quote-part se calcule sur le capital echu, diminue des penalites
          dues : une avance est un depot, rendu au nominal, qui ne produit rien jusqu&apos;au
          mois qu&apos;il couvre. La valeur suit l&apos;avoir du club — compte-titres tenu chez{" "}
          {CLUB.sgi} et caisse — et varie avec le marche.
        </footer>
      </div>
    </>
  );
}
