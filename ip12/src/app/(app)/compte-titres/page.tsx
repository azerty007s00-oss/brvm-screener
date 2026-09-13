import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerApports, listerMouvementsCaisse, synthese } from "@/lib/queries";
import { enregistrerApport } from "@/app/actions/titres";
import { CLUB, dateCourte, fcfa } from "@/lib/settings";
import { SENS_TRANSFERT } from "@/lib/valeurs";
import { Champ, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

export default async function PageCompteTitres() {
  const membre = await exigerMembre();

  let apports, s, caisse;
  try {
    [apports, s, caisse] = await Promise.all([
      listerApports(),
      synthese(),
      listerMouvementsCaisse().catch(() => []),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const peutSaisir = peut(membre, "gererCompteTitres");
  const entrees = apports.filter((a) => a.sens !== SENS_TRANSFERT.sortie);
  const sorties = apports.filter((a) => a.sens === SENS_TRANSFERT.sortie);

  /*
   * Les frais se payent de deux facons : retenus a l'arrivee sur le virement, ou
   * regles depuis la caisse. Les cumuler des deux sources donne le seul chiffre
   * qui compte -- ce que la SGI et la banque ont coute au club.
   */
  const fraisRetenus = apports.reduce((t, a) => t + a.frais, 0);
  const fraisPayesEnCaisse = caisse
    .filter(
      (m) =>
        m.statut === "valide" &&
        m.sens === "depense" &&
        (m.categorie === "frais_sgi" || m.categorie === "frais_bancaires"),
    )
    .reduce((t, m) => t + m.montant, 0);
  const fraisTotaux = fraisRetenus + fraisPayesEnCaisse;
  const netInvesti = s.totalApports - fraisRetenus;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Statistique
          libelle="Net place en bourse"
          valeur={fcfa(s.totalApports)}
          detail={`Chez ${CLUB.sgi}`}
          accent="or"
        />
        <Statistique libelle="Apports" valeur={fcfa(entrees.reduce((t, a) => t + a.montant, 0))} />
        <Statistique
          libelle="Retraits"
          valeur={fcfa(sorties.reduce((t, a) => t + a.montant, 0))}
          accent={sorties.length > 0 ? "rouge" : "neutre"}
        />
        <Statistique
          libelle="Frais supportes"
          valeur={fcfa(fraisTotaux)}
          detail="Depot, SGI et banque"
          accent={fraisTotaux > 0 ? "rouge" : "neutre"}
        />
      </div>

      {fraisTotaux > 0 && (
        <Carte titre="Ce que les frais ont coute">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between gap-2">
              <span style={{ color: "var(--discret)" }}>Retenus a l&apos;arrivee sur les virements</span>
              <span className="tabular-nums">{fcfa(fraisRetenus)}</span>
            </li>
            <li className="flex justify-between gap-2">
              <span style={{ color: "var(--discret)" }}>Regles depuis la caisse</span>
              <span className="tabular-nums">{fcfa(fraisPayesEnCaisse)}</span>
            </li>
            <li
              className="flex justify-between gap-2 border-t pt-1 font-semibold"
              style={{ borderColor: "var(--bordure)" }}
            >
              <span>Total supporte par le club</span>
              <span className="tabular-nums">{fcfa(fraisTotaux)}</span>
            </li>
          </ul>
          <p className="mt-3 text-[11px]" style={{ color: "var(--discret)" }}>
            Sur {fcfa(s.totalApports)} vires, {fcfa(netInvesti)} sont reellement arrives sur le
            compte-titres. Le TRI porte sur le montant vire, frais compris : ce sont des sommes
            engagees, et une performance qui les ignorerait flatterait sans rien vouloir dire.
          </p>
        </Carte>
      )}

      {peutSaisir ? (
        <Carte titre="Nouveau mouvement">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            L&apos;art. 14 confie la transmission des ordres au president, le bureau agissant
            par delegation : votre saisie vaut enregistrement, sans validation par un tiers.
          </p>
          <Depliant titre="Enregistrer un mouvement vers la SGI">
            <FormulaireAction action={enregistrerApport} libelle="Enregistrer">
              <Champ
                nom="dateApport"
                libelle="Date du virement"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Champ
                nom="montant"
                libelle="Montant vire (FCFA)"
                type="number"
                min={1}
                aide="Ce qui quitte la caisse, frais compris."
              />
              <Champ
                nom="frais"
                libelle="Dont frais de depot (FCFA)"
                type="number"
                min={0}
                valeur={0}
                requis={false}
                aide="La part retenue par la SGI a l'arrivee. Zero si les frais sont regles a part depuis la caisse."
              />
              <Selection
                nom="sens"
                libelle="Sens"
                valeur={SENS_TRANSFERT.entree}
                options={[
                  { valeur: SENS_TRANSFERT.entree, libelle: "Apport — de la caisse vers la SGI" },
                  { valeur: SENS_TRANSFERT.sortie, libelle: "Retrait — de la SGI vers la caisse" },
                ]}
              />
              <Champ nom="note" libelle="Note ou reference" requis={false} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      ) : (
        <Carte titre="Mouvements du compte-titres">
          <p className="text-xs" style={{ color: "var(--discret)" }}>
            Les mouvements vers la SGI sont enregistres par le president et le vice-president
            (art. 14). Vous en avez ici la lecture complete.
          </p>
        </Carte>
      )}

      <Carte titre={`Historique (${apports.length})`}>
        {apports.length === 0 ? (
          <Vide>Aucun mouvement enregistre.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {apports.map((a) => {
              const sortie = a.sens === SENS_TRANSFERT.sortie;
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      {sortie ? "-" : "+"} {fcfa(a.montant)}
                      {sortie && <Badge ton="ambre">Retrait</Badge>}
                    </p>
                    <p className="text-xs" style={{ color: "var(--discret)" }}>
                      {dateCourte(a.date_transfert)}
                      {a.frais > 0 ? ` · dont ${fcfa(a.frais)} de frais` : ""}
                      {a.saisi_par_nom ? ` · ${a.saisi_par_nom}` : ""}
                      {a.note ? ` · ${a.note}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Carte>
    </>
  );
}
