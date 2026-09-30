import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerApports, listerValorisations, netApport, synthese } from "@/lib/queries";
import { netPlaceParDate } from "@/lib/placement";
import { enregistrerValorisation, supprimerValorisation } from "@/app/actions/titres";
import { pourcent } from "@/lib/perf";
import { CLUB, REGLES, dateCourte, fcfa, nombre } from "@/lib/settings";
import { Champ, ChampCache, FormulaireAction } from "@/components/formulaires";
import { Carte, CarteEtat, EnTeteEcran, Vide } from "@/components/ui";
import { Panneau } from "@/components/panneau";
import { MenuLigne } from "@/components/menu-ligne";
import { CourbePortefeuille } from "@/components/courbe";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Portefeuille" };

export default async function PagePortefeuille() {
  const membre = await exigerMembre();

  let valos, s, apports;
  try {
    /*
     * `listerApports` est deja lu par `synthese`, et `cache()` le dedoublonne
     * sur le rendu : le demander ici ne coute aucune requete de plus.
     */
    [valos, s, apports] = await Promise.all([listerValorisations(), synthese(), listerApports()]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const derniere = valos.at(-1) ?? null;
  const precedente = valos.at(-2) ?? null;
  const variation =
    derniere && precedente ? (derniere.total - precedente.total) / precedente.total : null;
  const ecart = derniere && precedente ? derniere.total - precedente.total : null;
  const peutSaisir = peut(membre, "gererCompteTitres");

  /*
   * Le net place a la date de chaque releve : la somme des virements vers le
   * compte-titres, retraits deduits, dates au plus tard ce jour-la. La courbe
   * en a besoin pour separer ce que le club a verse de ce que la gestion a
   * rapporte -- sans quoi la hausse de la valeur se lit comme une performance.
   */
  const netsPlaces = netPlaceParDate(
    valos.map((v) => v.date_valo),
    apports.map((a) => ({ date: a.date_transfert, net: netApport(a) })),
  );
  const tracesCourbe = valos.map((v, i) => ({
    date: v.date_valo,
    valeur: v.total,
    netPlace: netsPlaces[i],
  }));

  /*
   * LA VARIATION SE PREND SUR LA LISTE ENTIERE, non sur la tranche affichee.
   *
   * La page coupait la liste a sept, puis lisait le releve precedent dans la
   * tranche : la septieme ligne n'en avait pas, et sa variation sortait vide
   * -- alors que le huitieme releve existe et que l'ecart se calcule.
   */
  const duPlusRecent = [...valos].reverse();
  const lignes = duPlusRecent.map((v, i) => {
    const avant = duPlusRecent[i + 1];
    return { v, ecartLigne: avant && avant.total !== 0 ? v.total / avant.total - 1 : null };
  });
  const recents = lignes.slice(0, 7);
  const anciens = lignes.slice(7);

  const ligneReleve = ({ v, ecartLigne }: (typeof lignes)[number]) => (
    <li
      key={v.id}
      className="flex items-center gap-3 py-2 text-[13.5px]"
      style={{ borderTop: "1px solid var(--line)" }}
    >
      <span className="min-w-0 flex-1 tabular-nums">{dateCourte(v.date_valo)}</span>
      <span className="text-right font-medium tabular-nums">{nombre(v.total)}</span>
      <span className="w-16 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
        {ecartLigne === null ? "" : pourcent(ecartLigne, 1)}
      </span>
      {peutSaisir && (
        <MenuLigne
          etiquette={`Actions sur le releve du ${dateCourte(v.date_valo)}`}
          actions={[
            {
              libelle: "Supprimer ce releve",
              action: supprimerValorisation,
              champs: <ChampCache nom="id" valeur={v.id} />,
              confirmation: `Supprimer le releve du ${dateCourte(v.date_valo)} ?`,
              confirmer: "Supprimer",
            },
          ]}
        />
      )}
    </li>
  );

  /* Le meme formulaire, sorti du chemin de lecture. */
  const saisie = peutSaisir ? (
    <Panneau
      libelle="Nouveau releve"
      titre="Nouveau releve"
      introduction={
        <>
          A relever tous les {REGLES.periodiciteValorisationMois} mois sur le compte-titres, par le
          president ou le vice-president. Une seconde saisie a la meme date remplace la precedente.
          {derniere ? (
            <>
              {" "}
              Dernier releve : {fcfa(derniere.total)} le {dateCourte(derniere.date_valo)}.
            </>
          ) : null}
        </>
      }
    >
      <FormulaireAction action={enregistrerValorisation} libelle="Enregistrer le releve">
        <Champ
          nom="dateValo"
          libelle="Date du releve"
          type="date"
          valeur={new Date().toISOString().slice(0, 10)}
        />
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
        <Champ nom="note" libelle="Note (facultatif)" requis={false} />
      </FormulaireAction>
    </Panneau>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <EnTeteEcran
          titre="Valeur du portefeuille"
          sous={derniere ? `au ${dateCourte(derniere.date_valo)}` : "— aucun releve saisi"}
          chiffre={derniere ? undefined : "--"}
          brut={derniere ? derniere.total : undefined}
          unite={derniere ? "FCFA" : undefined}
          detail={
            ecart !== null && variation !== null && precedente ? (
              <>
                <span className="font-medium" style={{ color: "var(--ink)" }}>
                  {ecart >= 0 ? "+" : "−"}
                  {nombre(Math.abs(ecart))} FCFA ({pourcent(variation)})
                </span>{" "}
                depuis le releve du {dateCourte(precedente.date_valo)}.
              </>
            ) : (
              `Compte-titres tenu chez ${CLUB.sgi}.`
            )
          }
        />
        <div className="sans-impression">{saisie}</div>
      </div>

      <CarteEtat
        chiffres={[
          {
            libelle: "Actions",
            valeur: derniere ? undefined : "--",
            brut: derniere ? derniere.actions : undefined,
            unite: derniere ? "FCFA" : undefined,
            contexte:
              derniere && derniere.total > 0
                ? `${((derniere.actions / derniere.total) * 100).toFixed(1).replace(".", ",")} % de la valeur`
                : undefined,
          },
          {
            libelle: "Liquidites",
            valeur: derniere ? undefined : "--",
            brut: derniere ? derniere.liquidites : undefined,
            unite: derniere ? "FCFA" : undefined,
            contexte:
              derniere && derniere.total > 0
                ? `${((derniere.liquidites / derniere.total) * 100).toFixed(1).replace(".", ",")} %, non investies`
                : undefined,
          },
          {
            libelle: "Performance annualisee",
            valeur: s.tri !== null ? pourcent(s.tri) : "--",
            contexte: s.triPeriode ? `TRI depuis le ${dateCourte(s.triPeriode.debut)}` : undefined,
          },
          {
            libelle: "Exercice en cours",
            valeur: s.exercice?.rendement != null ? pourcent(s.exercice.rendement) : "--",
            contexte:
              s.exercice?.gain != null ? `Dietz modifie · gain ${nombre(s.exercice.gain)}` : undefined,
          },
        ]}
      />

      <Carte
        titre="Valeur relevee"
        action={
          <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            {valos.length} releve{valos.length > 1 ? "s" : ""}
            {valos[0] ? ` depuis le ${dateCourte(valos[0].date_valo)}` : ""}
          </span>
        }
      >
        <CourbePortefeuille points={tracesCourbe} gainExercice={s.exercice?.gain ?? null} />
      </Carte>

      {/*
        * `grid-cols-1` et non la colonne implicite : une piste `auto` ne
        * descend jamais sous le contenu minimum de ses elements, et un nom de
        * membre un peu long faisait deborder toute la page de 152 px.
        * `minmax(0, 1fr)`, ce que produit `grid-cols-1`, l'y autorise.
        */}
      <div className="grid grid-cols-1 gap-11 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] xl:items-start">
        <Carte
          titre="Repartition des parts"
          action={
            <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              Compte-titres et caisse reunis
            </span>
          }
        >
          {s.parts.length === 0 || !derniere ? (
            <Vide>Les parts s&apos;afficheront des qu&apos;un releve sera saisi.</Vide>
          ) : (
            <>
              {/*
               * Une seule barre pour tout le club, un segment par membre : on y
               * lit d'un coup le poids de chacun, ce que dix barres separees ne
               * donnaient pas. Le segment « vous » est a l'encre, les autres au
               * filet -- aucune couleur n'est necessaire pour s'y reconnaitre.
               */}
              <div className="flex gap-0.5" aria-hidden="true">
                {s.parts.map((p, i) => (
                  <span
                    key={p.membreId}
                    /*
                     * Chaque segment pousse depuis la gauche, l'un apres
                     * l'autre : on voit la barre se composer part par part,
                     * ce qu'une barre posee d'un coup ne montre pas.
                     */
                    className="segment-part h-2 rounded-sm"
                    /*
                     * La part passe par flex-grow, non par une largeur en
                     * pourcentage : dix segments a 100 % plus neuf ecarts de
                     * 2 px debordaient de 18 px -- et la page avec.
                     */
                    style={{
                      flex: `${p.part} 1 0%`,
                      background: p.membreId === membre.id ? "var(--ink)" : "var(--line-2)",
                      ["--i" as string]: i,
                    }}
                  />
                ))}
              </div>

              <ul className="mt-4">
                {s.parts.map((p) => {
                  const moi = p.membreId === membre.id;
                  return (
                    <li
                      key={p.membreId}
                      className="flex items-baseline gap-3 py-2.5 text-[13.5px]"
                      style={{ borderTop: "1px solid var(--line)" }}
                    >
                      <span
                        className="min-w-0 flex-1 truncate"
                        style={{ fontWeight: moi ? 600 : 400 }}
                      >
                        {p.nom}
                        {moi && (
                          <span
                            className="ml-2 text-[12px] font-medium"
                            style={{ color: "var(--ink-3)" }}
                          >
                            vous
                          </span>
                        )}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {nombre(p.valeur)}
                      </span>
                      <span className="w-24 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                        {p.plusValue >= 0 ? "+" : "−"}
                        {nombre(Math.abs(p.plusValue))}
                      </span>
                      <span className="w-12 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                        {(p.part * 100).toFixed(1).replace(".", ",")} %
                      </span>
                    </li>
                  );
                })}
              </ul>

              <details className="mt-3">
                <summary
                  className="tapable flex h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 text-[13px] lg:h-11"
                  style={{ color: "var(--ink-2)" }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    aria-hidden="true"
                    className="chevron flex-none"
                  >
                    <path
                      d="M9.5 6 L15.5 12 L9.5 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Comment la part est calculee
                </summary>
                <div
                  className="contenu-depliant space-y-2 pt-1 pb-2 pl-8 text-[13px] leading-relaxed"
                  style={{ color: "var(--ink-2)" }}
                >
                  <p>
                    La quote-part se calcule sur le capital echu de chacun, diminue des penalites
                    dues (art. 9). Une avance ne donne aucun droit tant que le mois qu&apos;elle
                    couvre n&apos;est pas venu : elle est volontaire, donc ni remuneree ni
                    penalisee, et figure a part, rendue au nominal.
                  </p>
                  <p>
                    Art. 12 : les droits de vote sont proportionnels aux parts, elles-memes
                    proportionnelles aux versements valides. La repartition porte sur l&apos;avoir
                    du club, compte-titres et caisse reunis.
                  </p>
                </div>
              </details>
            </>
          )}
        </Carte>

        <Carte
          titre="Releves"
          action={
            <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              {valos.length} au total
            </span>
          }
        >
          {valos.length === 0 ? (
            <Vide>Aucun releve saisi.</Vide>
          ) : (
            <>
              <ul>{recents.map(ligneReleve)}</ul>
              {/*
                * Les plus anciens se replient, ils ne disparaissent pas.
                *
                * La page n'en montrait que sept, sans rien dire des autres :
                * la liste comptait quatorze releves avant la refonte, et les
                * sept premieres annees du club s'etaient tues. Un <details>
                * plutot qu'un lien : il n'y a pas d'autre page ou aller, et
                * celui-ci s'ouvre sans JavaScript.
                */}
              {anciens.length > 0 && (
                <details className="mt-1">
                  <summary
                    className="tapable flex h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 text-[13px] lg:h-11"
                    style={{ color: "var(--ink-2)" }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      aria-hidden="true"
                      className="chevron flex-none"
                    >
                      <path
                        d="M9.5 6 L15.5 12 L9.5 18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Afficher les {anciens.length} releves plus anciens
                  </summary>
                  <ul className="contenu-depliant">{anciens.map(ligneReleve)}</ul>
                </details>
              )}
            </>
          )}
          {peutSaisir && (
            <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
              Un releve tous les {REGLES.periodiciteValorisationMois} mois, saisi par le president
              ou le vice-president. Une seconde saisie a la meme date remplace la precedente.
            </p>
          )}
        </Carte>
      </div>
    </>
  );
}
