import { exigerMembre } from "@/lib/auth";
import { listerApports, synthese } from "@/lib/queries";
import { enregistrerApport } from "@/app/actions/titres";
import { CLUB, dateCourte, fcfa } from "@/lib/settings";
import { SENS_TRANSFERT } from "@/lib/valeurs";
import { Champ, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

export default async function PageCompteTitres() {
  const membre = await exigerMembre();

  let apports, s;
  try {
    [apports, s] = await Promise.all([listerApports(), synthese()]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const estPresident = membre.role === "president";
  const entrees = apports.filter((a) => a.sens !== SENS_TRANSFERT.sortie);
  const sorties = apports.filter((a) => a.sens === SENS_TRANSFERT.sortie);

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
          libelle="Reste en caisse"
          valeur={fcfa(s.totalEnCaisse)}
          detail="Encaisse non investie"
          accent={s.totalEnCaisse < 0 ? "rouge" : "neutre"}
        />
      </div>

      {estPresident ? (
        <Carte titre="Nouveau mouvement">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            L&apos;art. 14 confie la transmission des ordres au president : votre saisie vaut
            enregistrement, sans validation par un tiers.
          </p>
          <Depliant titre="Enregistrer un mouvement vers la SGI">
            <FormulaireAction action={enregistrerApport} libelle="Enregistrer">
              <Champ
                nom="dateApport"
                libelle="Date du virement"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Champ nom="montant" libelle="Montant (FCFA)" type="number" min={1} />
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
            Seul le president enregistre les mouvements vers la SGI (art. 14). Vous en avez ici la
            lecture complete.
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
