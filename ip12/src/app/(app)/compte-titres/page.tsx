import { exigerMembre } from "@/lib/auth";
import { listerApports, synthese } from "@/lib/queries";
import { enregistrerApport, validerApport } from "@/app/actions/titres";
import { CLUB, dateCourte, fcfa } from "@/lib/settings";
import { Champ, ChampCache, Depliant, FormulaireAction } from "@/components/formulaires";
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

  const peutSaisir = membre.role === "president" || membre.role === "tresorier";
  const enAttente = apports.filter((a) => a.statut === "en_attente");

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Statistique libelle="Place en bourse" valeur={fcfa(s.totalApports)} detail={`Chez ${CLUB.sgi}`} accent="or" />
        <Statistique
          libelle="Reste en caisse"
          valeur={fcfa(s.totalEnCaisse)}
          detail="Encaisse disponible"
          accent={s.totalEnCaisse < 0 ? "rouge" : "neutre"}
        />
      </div>

      {peutSaisir && (
        <Carte titre="Nouvel apport au compte-titres">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            {membre.role === "president"
              ? "En tant que president, votre saisie vaut validation (art. 14)."
              : "Votre saisie restera en attente de la validation du president."}
          </p>
          <Depliant titre="Enregistrer un virement vers la SGI">
            <FormulaireAction action={enregistrerApport} libelle="Enregistrer">
              <Champ nom="dateApport" libelle="Date du virement" type="date" valeur={new Date().toISOString().slice(0, 10)} />
              <Champ nom="montant" libelle="Montant (FCFA)" type="number" min={1} />
              <Champ nom="reference" libelle="Reference / bordereau" requis={false} />
              <Champ nom="note" libelle="Note" requis={false} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}

      {membre.role === "president" && enAttente.length > 0 && (
        <Carte titre={`A valider (${enAttente.length})`}>
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {enAttente.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium">{fcfa(a.montant)}</p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {dateCourte(a.date_apport)} &middot; prepare par {a.saisi_par_nom ?? "--"}
                  </p>
                </div>
                <FormulaireAction action={validerApport} libelle="Valider" compact>
                  <ChampCache nom="id" valeur={a.id} />
                </FormulaireAction>
              </li>
            ))}
          </ul>
        </Carte>
      )}

      <Carte titre={`Historique des apports (${apports.length})`}>
        {apports.length === 0 ? (
          <Vide>Aucun apport enregistre.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {apports.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {fcfa(a.montant)}{" "}
                    {a.statut === "en_attente" && <Badge ton="ambre">En attente</Badge>}
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {dateCourte(a.date_apport)}
                    {a.reference ? ` · ${a.reference}` : ""}
                    {a.valide_par_nom ? ` · valide par ${a.valide_par_nom}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Carte>
    </>
  );
}
