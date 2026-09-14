import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerValorisations, synthese } from "@/lib/queries";
import { enregistrerValorisation, supprimerValorisation } from "@/app/actions/titres";
import { pourcent } from "@/lib/perf";
import { REGLES, dateCourte, fcfa } from "@/lib/settings";
import { Champ, ChampCache, Depliant, FormulaireAction } from "@/components/formulaires";
import { Carte, Statistique, Vide } from "@/components/ui";
import { CourbePortefeuille } from "@/components/courbe";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

export default async function PagePortefeuille() {
  const membre = await exigerMembre();

  let valos, s;
  try {
    [valos, s] = await Promise.all([listerValorisations(), synthese()]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const derniere = valos.at(-1) ?? null;
  const precedente = valos.at(-2) ?? null;
  const variation = derniere && precedente ? (derniere.total - precedente.total) / precedente.total : null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Statistique libelle="Valeur totale" valeur={derniere ? fcfa(derniere.total) : "--"} accent="or" />
        <Statistique libelle="Actions" valeur={derniere ? fcfa(derniere.actions) : "--"} />
        <Statistique libelle="Liquidites" valeur={derniere ? fcfa(derniere.liquidites) : "--"} />
        <Statistique
          libelle="Depuis le releve precedent"
          valeur={pourcent(variation)}
          accent={variation !== null && variation < 0 ? "rouge" : "vert"}
        />
      </div>

      <Carte titre="Evolution">
        <CourbePortefeuille points={valos.map((v) => ({ date: v.date_valo, valeur: v.total }))} />
      </Carte>

      <Carte titre="Repartition des parts">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            La quote-part se calcule sur le capital echu de chacun, diminue des penalites
            dues (art. 9). Une avance ne donne aucun droit tant que le mois qu&apos;elle couvre
            n&apos;est pas venu : elle est volontaire, donc ni remuneree ni penalisee, et
            figure a part, rendue au nominal. La repartition porte sur l&apos;avoir du club,
            compte-titres et caisse reunis.
          </p>

        {s.parts.length === 0 || !derniere ? (
          <Vide>Les parts s&apos;afficheront des qu&apos;un releve sera saisi.</Vide>
        ) : (
          <ul className="space-y-2">
            {s.parts.map((p) => (
              <li key={p.membreId}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{p.nom}</span>
                  <span className="whitespace-nowrap">
                    {fcfa(p.valeur)}{" "}
                    <span
                      className="text-xs"
                      style={{ color: p.plusValue >= 0 ? "var(--color-vert-600)" : "var(--color-rouge-600)" }}
                    >
                      ({p.plusValue >= 0 ? "+" : ""}
                      {fcfa(p.plusValue)})
                    </span>
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full" style={{ background: "var(--color-brun-100)" }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(p.part * 100).toFixed(2)}%`, background: "var(--color-or-500)" }}
                  />
                </div>
                <p className="mt-0.5 text-[11px]" style={{ color: "var(--discret)" }}>
                  {(p.part * 100).toFixed(1).replace(".", ",")} % &middot; verse {fcfa(p.verse)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-[11px]" style={{ color: "var(--discret)" }}>
          Art. 12 : les droits de vote sont proportionnels aux parts, elles-memes proportionnelles aux
          versements valides.
        </p>
      </Carte>

      {peut(membre, "gererCompteTitres") && (
        <Carte titre="Saisir un releve">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            A relever tous les {REGLES.periodiciteValorisationMois} mois sur le compte-titres, par
            le president ou le vice-president. Une seconde saisie a la meme date remplace la
            precedente.
          </p>
          <Depliant titre="Nouveau releve">
            <FormulaireAction action={enregistrerValorisation} libelle="Enregistrer le releve">
              <Champ nom="dateValo" libelle="Date du releve" type="date" valeur={new Date().toISOString().slice(0, 10)} />
              <Champ
                nom="total"
                libelle="Valeur totale du compte (FCFA)"
                type="number"
                min={1}
                aide="Le montant global du releve, liquidites comprises."
              />
              <Champ
                nom="liquidites"
                libelle="Dont liquidites (FCFA)"
                type="number"
                min={0}
                valeur={0}
                aide="La part non investie. La valeur des titres s'en deduit."
              />
              <Champ nom="note" libelle="Note" requis={false} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}

      <Carte titre={`Releves (${valos.length})`}>
        {valos.length === 0 ? (
          <Vide>Aucun releve saisi.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {[...valos].reverse().map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium">{fcfa(v.total)}</p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {dateCourte(v.date_valo)} &middot; actions {fcfa(v.actions)} &middot; liquidites{" "}
                    {fcfa(v.liquidites)}
                  </p>
                </div>
                {peut(membre, "gererCompteTitres") && (
                  <FormulaireAction
                    action={supprimerValorisation}
                    libelle="Supprimer"
                    variante="danger"
                    compact
                    confirmation="Supprimer ce releve ?"
                  >
                    <ChampCache nom="id" valeur={v.id} />
                  </FormulaireAction>
                )}
              </li>
            ))}
          </ul>
        )}
      </Carte>
    </>
  );
}
