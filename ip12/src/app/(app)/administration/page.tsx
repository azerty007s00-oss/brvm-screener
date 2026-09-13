import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { reglagesEffectifs, situationsClub } from "@/lib/queries";
import { journalRecent } from "@/lib/journal";
import {
  enregistrerReglages,
  reprendreHistorique,
  reprendrePenalites,
} from "@/app/actions/administration";
import { listerMembres } from "@/lib/queries";
import { CLUB, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { Champ, Depliant, FormulaireAction } from "@/components/formulaires";
import { Alerte, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

export default async function PageAdministration() {
  const membre = await exigerMembre();
  if (!peut(membre, "gererReglages")) {
    return (
      <Carte titre="Administration">
        <Alerte ton="rouge">Cette page est reservee au president.</Alerte>
      </Carte>
    );
  }

  let reglages, situations, journal, membres;
  try {
    [reglages, situations, journal, membres] = await Promise.all([
      reglagesEffectifs(),
      situationsClub(),
      journalRecent(30).catch(() => []),
      listerMembres(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const moisDecouverts = situations.reduce((total, s) => total + s.nbMoisRetard, 0);

  /*
   * Propose le dernier mois ou personne n'etait en retard, plutot qu'une date
   * arbitraire : c'est la borne que le president cherche, et elle se deduit des
   * donnees sans lire l'horloge pendant le rendu.
   */
  const premierDecouvert = situations
    .flatMap((s) => s.moisEnRetard)
    .sort()
    .at(0);
  const grille = situations[0]?.cellules ?? [];
  /*
   * Le decompte du tresorier court jusqu'au mois en cours des lors que son
   * echeance est passee. La grille s'arretant au mois courant, son dernier
   * element le donne sans lire l'horloge pendant le rendu.
   */
  const moisCourant = (grille.at(-1)?.mois ?? CLUB.dateCreation).slice(0, 7);
  const defautJusqua = (
    premierDecouvert
      ? (grille.find((c) => c.mois === premierDecouvert)
          ? grille[Math.max(0, grille.findIndex((c) => c.mois === premierDecouvert) - 1)]?.mois
          : undefined) ?? premierDecouvert
      : (grille.at(-1)?.mois ?? CLUB.dateCreation)
  ).slice(0, 7);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Statistique libelle="Cotisation" valeur={fcfa(reglages.cotisationMensuelle)} accent="or" />
        <Statistique libelle="Echeance" valeur={`le ${reglages.jourEcheance}`} />
        <Statistique
          libelle="Taux de penalite"
          valeur={`${(reglages.tauxPenalite * 100).toFixed(0)} %`}
        />
        <Statistique
          libelle="Mois decouverts"
          valeur={moisDecouverts}
          detail="tous membres confondus"
          accent={moisDecouverts > 0 ? "rouge" : "vert"}
        />
      </div>

      <Carte titre="Reprise de l'historique">
        <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
          Marque payes, en une operation, tous les mois encore decouverts jusqu&apos;au mois choisi.
          Chaque ligne est datee de l&apos;echeance du mois qu&apos;elle couvre, jamais
          d&apos;aujourd&apos;hui : antidater au {reglages.jourEcheance} evite de creer des
          penalites fictives sur du passe deja regle.
        </p>
        {moisDecouverts > 0 && (
          <div className="mb-3">
            <Alerte ton="ambre">
              {moisDecouverts} mois sont actuellement decouverts, repartis sur{" "}
              {situations.filter((s) => s.nbMoisRetard > 0).length} membres. Tant que
              l&apos;historique n&apos;est pas repris, chacun apparait en retard depuis la creation
              du club.
            </Alerte>
          </div>
        )}
        <Depliant titre="Reprendre l'historique">
          <FormulaireAction
            action={reprendreHistorique}
            libelle="Marquer ces mois payes"
            confirmation="Marquer payes tous les mois decouverts de la periode ? L'operation est rejouable et ne double jamais un mois deja couvert."
          >
            <Champ
              nom="depuis"
              libelle="Premier mois du club"
              type="month"
              valeur={CLUB.dateCreation.slice(0, 7)}
              aide="Le club a-t-il cotise des sa constitution, ou seulement a l'ouverture du compte ?"
            />
            <Champ
              nom="jusqua"
              libelle="Dernier mois a jour"
              type="month"
              valeur={defautJusqua}
              aide={
                premierDecouvert
                  ? `Propose : le mois precedant le premier decouvert (${moisLong(premierDecouvert)}). Les mois suivants resteront des retards.`
                  : "Le dernier mois ou tout le monde etait a jour."
              }
            />
            <Champ
              nom="montant"
              libelle="Montant par mois (FCFA)"
              type="number"
              min={1}
              valeur={reglages.cotisationMensuelle}
              aide="Les montants particuliers se corrigent ensuite ligne par ligne."
            />
            <details className="mt-3">
              <summary
                className="cursor-pointer list-none rounded px-2 py-1 text-xs"
                style={{ background: "var(--color-brun-100)", color: "var(--color-brun-800)" }}
              >
                + Une borne differente pour certains membres
              </summary>
              <p className="mt-2 text-xs" style={{ color: "var(--discret)" }}>
                Tous ne sont pas a jour au meme mois. Laissez vide pour appliquer la borne commune.
              </p>
              {membres.map((m) => (
                <Champ
                  key={m.id}
                  nom={`jusqua_${m.id}`}
                  libelle={m.nom}
                  type="month"
                  requis={false}
                />
              ))}
            </details>
          </FormulaireAction>
        </Depliant>
      </Carte>

      <Carte titre="Reprise des penalites">
        <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
          Les penalites anterieures ne peuvent pas naitre du calcul : une fois l&apos;historique
          repris, tous les mois passes portent la date de leur echeance, donc sont a l&apos;heure.
          Le retard reel de l&apos;epoque n&apos;est connu que du tresorier, qui l&apos;a suivi a la
          main. Saisissez ici le nombre de mois qu&apos;il annonce pour chacun — a{" "}
          {fcfa(Math.round(reglages.cotisationMensuelle * reglages.tauxPenalite))} le mois.
        </p>
        <Depliant titre="Saisir les mois de penalite par membre">
          <FormulaireAction action={reprendrePenalites} libelle="Porter au registre">
            <Champ
              nom="jusqua"
              libelle="Decompte arrete a"
              type="month"
              valeur={moisCourant}
              aide="Le dernier mois couvert par le decompte du tresorier. Au-dela, le site prend le relais et ne recompte rien en deca."
            />
            {membres.map((m) => (
              <Champ
                key={m.id}
                nom={`mois_${m.id}`}
                libelle={m.nom}
                type="number"
                min={0}
                max={200}
                valeur={0}
                requis={false}
              />
            ))}
          </FormulaireAction>
        </Depliant>
        <p className="mt-3 text-[11px]" style={{ color: "var(--discret)" }}>
          Rejouable : la ligne d&apos;un membre est remplacee tant qu&apos;elle n&apos;a pas ete
          soldee, jamais dupliquee. Laissez a zero ceux qui ne doivent rien. Le mois
          d&apos;arret compte : le constat automatique ne produira plus rien en deca, ce qui evite
          de compter deux fois les memes retards.
        </p>
      </Carte>

      <Carte titre="Reglages du club">
        <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
          Ces valeurs viennent des statuts et sont inscrites dans le code. Les modifier ici les fait
          primer, sans toucher au code, si l&apos;assemblee amende les articles 6, 8 ou 9. Laissez un
          champ vide pour conserver la valeur en vigueur.
        </p>
        <Depliant titre="Modifier les regles">
          <FormulaireAction action={enregistrerReglages} libelle="Enregistrer">
            <Champ
              nom="cotisation"
              libelle="Cotisation mensuelle (FCFA)"
              type="number"
              min={1}
              valeur={reglages.cotisationMensuelle}
              requis={false}
              aide="Art. 6."
            />
            <Champ
              nom="jourEcheance"
              libelle="Jour d'echeance"
              type="number"
              min={1}
              max={28}
              valeur={reglages.jourEcheance}
              requis={false}
              aide="Art. 8. Entre le 1 et le 28."
            />
            <Champ
              nom="tauxPenalite"
              libelle="Taux de penalite"
              type="number"
              step="0.01"
              min={0.01}
              max={1}
              valeur={reglages.tauxPenalite}
              requis={false}
              aide="Art. 9. En fraction : 0,1 pour 10 %."
            />
          </FormulaireAction>
        </Depliant>
      </Carte>

      <Carte titre={`Journal (${journal.length})`}>
        {journal.length === 0 ? (
          <Vide>Aucune operation enregistree.</Vide>
        ) : (
          <ul className="divide-y text-xs" style={{ borderColor: "var(--bordure)" }}>
            {journal.map((j) => (
              <li key={j.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <strong>{j.actor_name ?? "—"}</strong> &middot; {j.action.replace(/_/g, " ")}
                  {j.entity ? ` · ${j.entity}` : ""}
                </span>
                <span style={{ color: "var(--discret)" }}>{dateCourte(j.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px]" style={{ color: "var(--discret)" }}>
          Chaque validation, correction et constat y laisse une trace nominative.
        </p>
      </Carte>

      <p className="text-center text-[11px]" style={{ color: "var(--discret)" }}>
        {CLUB.nom} &middot; fonde le {dateCourte(CLUB.dateCreation)} &middot; premier mois repris :{" "}
        {moisLong(`${CLUB.dateCreation.slice(0, 8)}01`)}
      </p>
    </>
  );
}
