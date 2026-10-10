import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import {
  listerMouvementsCaisse,
  reglementsPenalite,
  situationsClub,
  synthese,
} from "@/lib/queries";
import { STATUT_CAISSE, STATUT_REGLEMENT } from "@/lib/valeurs";
import { couleurSigne, dureeEnClair, pourcent } from "@/lib/perf";
import { CLUB, REGLES, dateCourte, debutMois, fcfa, moisLong, nombre } from "@/lib/settings";
import { Carte, CarteEtat, EnTeteEcran, ValeurChiffree, Vide } from "@/components/ui";
import { LienBouton } from "@/components/boutons";
import { Frise, GlypheEtat, LIBELLE_STATUT, STATUTS_LEGENDE, statutLigne } from "@/components/glyphe-etat";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";
import { penalitesNonInscrites } from "@/lib/constat";
import type { ReactNode } from "react";
import { cotisationsARegler, type StatutMois } from "@/lib/penalites";
import { Chiffre } from "@/components/chiffre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accueil" };

/** Deux chiffres cote a cote : « Cotisation due », « Penalites ». */
function Couple({ chiffres }: { chiffres: { libelle: string; brut: number }[] }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {chiffres.map((c) => (
        <div key={c.libelle}>
          <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {c.libelle}
          </p>
          <p className="mt-0.5 text-[17px] font-medium whitespace-nowrap tabular-nums">
            <Chiffre valeur={c.brut} format="fcfa" />
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Une ligne de « A faire » ou « A traiter » : un compte, ce qu'il designe, et
 * ou cela se traite. Le nombre est a l'encre et grand ; c'est lui qu'on lit.
 */
function LigneATraiter({
  compte,
  titre,
  detail,
  href,
}: {
  compte: number | string;
  titre: string;
  detail: string;
  href: string;
}) {
  return (
    <li style={{ borderTop: "1px solid var(--line)" }}>
      <Link href={href} className="tapable flex items-center gap-3.5 py-3">
        <span className="w-8 flex-none text-[22px] leading-none font-medium tabular-nums">
          {compte}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium">{titre}</span>
          <span className="block truncate text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            {detail}
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-4 w-4 flex-none"
          style={{ fill: "none", stroke: "var(--ink-3)", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }}
        >
          <path d="M9.5 6 L15.5 12 L9.5 18" />
        </svg>
      </Link>
    </li>
  );
}

export default async function TableauDeBord() {
  const membre = await exigerMembre();

  let s, situations;
  try {
    [s, situations] = await Promise.all([synthese(), situationsClub()]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }
  /* Apres `situations`, dont elle a besoin. Rend `null` si le registre resiste. */
  const courues = await penalitesNonInscrites(situations);

  const maPart = s.parts.find((p) => p.membreId === membre.id);
  const maSituation = situations.find((x) => x.membreId === membre.id);
  const retardataires = situations.filter((x) => x.nbMoisRetard > 0);
  const estBureau = membre.role === "president" || membre.role === "tresorier";

  /*
   * LES TROIS FILES DU TRESORIER, ET NON UNE SEULE.
   *
   * « A traiter » ne comptait que les versements a valider. Les reglements de
   * penalite et les mouvements de caisse attendaient chacun sur leur page, et
   * l'ecran qui se veut la synthese du necessaire n'en disait rien -- d'autant
   * plus genant que les penalites se declarent desormais depuis les
   * versements, et atterrissent dans une file que ce bloc ne voyait pas.
   *
   * Lues pour le seul bureau, et sans jamais faire tomber la page : la table
   * des reglements peut manquer tant que sa migration n'a pas tourne.
   */
  const [reglementsEnAttente, mouvementsEnAttente] = estBureau
    ? await Promise.all([
        reglementsPenalite({ statut: STATUT_REGLEMENT.enAttente }).catch(() => []),
        listerMouvementsCaisse()
          .then((m) => m.filter((x) => x.statut === STATUT_CAISSE.enAttente))
          .catch(() => []),
      ])
    : [[], []];

  const maFenetre = maSituation?.cellules.slice(-14) ?? [];
  const moisCourant = debutMois();
  /*
   * LA DETTE DE PENALITES, LA MEME QUE PARTOUT AILLEURS.
   *
   * Cet ecran annoncait `totalPenalites`, la penalite que l'art. 9 fait courir
   * sur les mois impayes, a quatre endroits. Elle ignore tout ce que le registre
   * porte par ailleurs : les penalites d'absence, et celles de mois anciens dont
   * la cotisation a fini par etre versee sans que la penalite le soit. L'accueil
   * affichait donc 1 000 FCFA quand « Mon compte », le recapitulatif du bureau et
   * la relance en annoncaient 8 500.
   *
   * La dette inscrite plus ce qui court : les deux sont dues, et `nonInscrites`
   * ne retient que les mois absents du registre, donc rien n'est compte deux fois.
   */
  const detteDe = (membreId: string) =>
    (s.parts.find((p) => p.membreId === membreId)?.dues ?? 0) +
    (courues?.get(membreId)?.montant ?? 0);
  const maDette = maSituation ? detteDe(membre.id) : 0;
  const aFaire = maSituation && (maSituation.nbMoisRetard > 0 || maDette > 0);

  const rangStatut = (st: StatutMois) => {
    const i = STATUTS_LEGENDE.indexOf(st);
    return i < 0 ? STATUTS_LEGENDE.length : i;
  };
  const moisDuClub = situations
    .map((x) => x.cellules.find((c) => c.mois === moisCourant))
    .filter((c) => c !== undefined && c.statut !== "hors_periode")
    .map((c) => c!)
    .sort((a, b) => rangStatut(a.statut) - rangStatut(b.statut));
  const payesCeMois = moisDuClub.filter(
    (c) => c.statut === "paye" || c.statut === "paye_en_retard",
  ).length;
  const compteParEtat = STATUTS_LEGENDE.map((st) => ({
    statut: st,
    nb: moisDuClub.filter((c) => c.statut === st).length,
  })).filter((x) => x.nb > 0);
  const compteEnClair = compteParEtat
    .map((x) => `${x.nb} ${LIBELLE_STATUT[x.statut].toLowerCase()}`)
    .join(", ");

  /*
   * Les deux chiffres poses a droite du heros. Le type est ecrit a la main : la
   * premiere entree porte un montant, la seconde un taux et sa couleur, et sans
   * annotation TypeScript en ferait une union ou chaque champ manque a l'une des
   * deux -- exactement le genre de silence qui a laisse passer la cellule vide.
   */
  const cles: {
    libelle: string;
    valeur?: ReactNode;
    brut?: number;
    unite?: string;
    encre?: string;
  }[] = [
    {
      libelle: "Portefeuille du club",
      valeur: s.valorisation ? undefined : "--",
      brut: s.valorisation ? s.valorisation.total : undefined,
      unite: s.valorisation ? "FCFA" : undefined,
    },
    {
      libelle: "Performance annualisee",
      valeur: s.tri !== null ? pourcent(s.tri) : "--",
      encre: couleurSigne(s.tri),
    },
  ];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <EnTeteEcran
          titre="Ma part"
          sous={s.valorisation ? `au ${dateCourte(s.valorisation.date_valo)}` : "aucun relevé saisi"}
          chiffre={maPart && s.valorisation ? undefined : "--"}
          brut={maPart && s.valorisation ? maPart.valeur : undefined}
          unite={maPart && s.valorisation ? "FCFA" : undefined}
          detail={
            maPart
              ? `${(maPart.part * 100).toFixed(1).replace(".", ",")} % du portefeuille, au prorata de mes versements validés.`
              : "Votre part se calcule dès votre premier versement validé."
          }
        />
        {/*
          * Ces deux chiffres passent par `ValeurChiffree`, comme ceux des
          * bandeaux : la copie ecrite a la main qui vivait ici n'affichait ni
          * les montants poses dans `brut` -- l'accueil annoncait « Portefeuille
          * du club FCFA », sans chiffre -- ni la couleur de performance.
          */}
        <div className="flex gap-10 lg:gap-14">
          {cles.map((c, i) => (
            <div key={c.libelle}>
              <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                {c.libelle}
              </p>
              <div className="mt-1">
                <ValeurChiffree
                  brut={c.brut}
                  valeur={c.valeur}
                  unite={c.unite}
                  encre={c.encre}
                  retard={i * 22}
                  taille="text-[18px] lg:text-[22px]"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-11 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
        {/*
          * A FAIRE d'abord, et sur la colonne de droite sur grand ecran : c'est
          * la seule chose de la page qui reclame un geste. Le reste se lit.
          */}
        <div className="flex flex-col gap-11 xl:order-2">
          {maSituation && (
            <Carte titre={aFaire ? "À faire" : "Rien à faire"}>
              {!aFaire ? (
                <p className="flex items-center gap-2.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                  <GlypheEtat statut="paye" taille={18} />
                  Vous êtes à jour. Prochaine échéance le {REGLES.jourEcheance} du mois.
                </p>
              ) : (
                <>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5">
                      <GlypheEtat statut="retard" taille={22} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium" style={{ color: "var(--etat-manque)" }}>
                        {maSituation.nbMoisRetard > 0
                          ? `${maSituation.nbMoisRetard} mois de cotisation en retard`
                          : "Pénalités de retard à régler"}
                      </p>
                      <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
                        {maSituation.moisEnRetard.length > 0
                          ? `${maSituation.moisEnRetard.map((m) => moisLong(m)).join(", ")}. `
                          : ""}
                        La pénalité de l&apos;art. 9 reste acquise au club, même après
                        régularisation.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4">
                    <Couple
                      chiffres={[
                        {
                          /*
                           * Elle portait la cotisation du SEUL mois courant, a
                           * cote d'une dette de penalites ENTIERE : qui devait
                           * trois mois lisait 5 000 FCFA. Elle porte maintenant
                           * tout ce qu'il faut verser pour etre a jour -- le
                           * meme calcul que le courrier de relance.
                           */
                          libelle: "Cotisations à régler",
                          brut: cotisationsARegler(maSituation.cellules).total,
                        },
                        {
                          /*
                           * L'etiquette disait « Penalites (10 %) », a cote de la
                           * cotisation du mois : elle promettait donc la penalite
                           * du mois, et portait le total de tous les mois en
                           * retard. Elle porte maintenant la dette entiere, et le
                           * dit.
                           */
                          libelle: "Pénalités dues",
                          brut: maDette,
                        },
                      ]}
                    />
                  </div>

                  <div className="mt-5">
                    <LienBouton href="/versements">Déclarer mon versement</LienBouton>
                  </div>
                </>
              )}

              {maSituation.voteSuspendu && (
                <p className="mt-4 text-[12.5px]" style={{ color: "var(--etat-manque)" }}>
                  R2 : votre droit de vote est suspendu au-delà de{" "}
                  {REGLES.suspensionVoteApresJours} jours de retard, jusqu&apos;à régularisation
                  complète.
                </p>
              )}
              {maSituation.declarationRequise && (
                <p className="mt-2 text-[12.5px]" style={{ color: "var(--etat-attente)" }}>
                  R3 : vous devez déclarer ce retard sur le groupe WhatsApp du club en taguant tous
                  les membres, puis l&apos;enregistrer depuis la page{" "}
                  <Link href="/versements" className="underline">
                    Versements
                  </Link>
                  .
                </p>
              )}
            </Carte>
          )}

          {/*
            * CE QUI ATTEND UN GESTE DU BUREAU, ET RIEN D'AUTRE.
            *
            * Le bloc comptait aussi « membres en retard » : les memes noms que
            * la liste des retardataires, affichee juste en dessous. Sur un
            * telephone, on lisait deux fois de suite DROPOU, KONE, KOUADIO.
            * La liste suffit ; ce bloc ne garde que les validations.
            */}
          {estBureau &&
            (s.enAttenteValidation > 0 ||
              reglementsEnAttente.length > 0 ||
              mouvementsEnAttente.length > 0) && (
            <Carte titre="À traiter">
              <ul>
                {s.enAttenteValidation > 0 && (
                  <LigneATraiter
                    compte={s.enAttenteValidation}
                    titre={`Versement${s.enAttenteValidation > 1 ? "s" : ""} à valider`}
                    detail="Déclarés par les membres, en attente de votre visa"
                    href="/versements"
                  />
                )}
                {reglementsEnAttente.length > 0 && (
                  <LigneATraiter
                    compte={reglementsEnAttente.length}
                    titre={`Règlement${reglementsEnAttente.length > 1 ? "s" : ""} de pénalité à valider`}
                    detail={[...new Set(reglementsEnAttente.map((r) => r.membre_nom))].join(", ")}
                    href="/penalites"
                  />
                )}
                {mouvementsEnAttente.length > 0 && (
                  <LigneATraiter
                    compte={mouvementsEnAttente.length}
                    titre={`Mouvement${mouvementsEnAttente.length > 1 ? "s" : ""} de caisse à valider`}
                    detail="Saisis, en attente de votre visa"
                    href="/caisse"
                  />
                )}
              </ul>
            </Carte>
          )}

          <Carte titre={`Retardataires (${retardataires.length})`}>
            {retardataires.length === 0 ? (
              <Vide>Aucun retard : les {situations.length} membres sont à jour.</Vide>
            ) : (
              <ul>
                {retardataires.map((r) => (
                  <li
                    key={r.membreId}
                    className="flex items-baseline gap-3 py-2.5 text-[13.5px]"
                    style={{ borderTop: "1px solid var(--line)" }}
                  >
                    <span className="min-w-0 flex-1 truncate">{r.nom}</span>
                    <span className="w-28 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                      {r.nbMoisRetard} mois &middot; {r.joursDeRetard} j
                    </span>
                    <span className="w-24 text-right font-medium tabular-nums">
                      {nombre(detteDe(r.membreId))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {retardataires.some((r) => r.voteSuspendu || r.declarationRequise) && (
              <p className="mt-3 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                {retardataires
                  .filter((r) => r.voteSuspendu || r.declarationRequise)
                  .map(
                    (r) =>
                      `${r.nom} : ${[r.voteSuspendu ? "vote suspendu" : null, r.declarationRequise ? "R3 à déclarer" : null].filter(Boolean).join(" · ")}`,
                  )
                  .join(" ; ")}
              </p>
            )}
          </Carte>
        </div>

        <div className="flex flex-col gap-11 xl:order-1">
          {maSituation && (
            <Carte
              titre="Mon suivi"
              action={
                <Link href="/versements" className="text-[13px]" style={{ color: "var(--ink-2)" }}>
                  Voir le registre &rarr;
                </Link>
              }
            >
              <div className="mb-2.5 flex items-baseline justify-between gap-3">
                <span className="truncate text-[14px] font-medium">{maSituation.nom}</span>
                <span
                  className="flex-none text-[12.5px] font-medium"
                  style={{ color: statutLigne(maFenetre).encre }}
                >
                  {statutLigne(maFenetre).texte}
                </span>
              </div>
              <Frise cellules={maFenetre} taille={18} etiquette={maSituation.nom} />
              <div className="mt-5">
                <Couple
                  chiffres={[
                    { libelle: "Versements validés", brut: maSituation.verse },
                    { libelle: "Pénalités dues", brut: maDette },
                  ]}
                />
              </div>
            </Carte>
          )}

          <Carte
            titre={`Le club en ${moisLong(moisCourant)}`}
            action={
              <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                {payesCeMois} sur {moisDuClub.length} payées
              </span>
            }
          >
            {moisDuClub.length === 0 ? (
              <Vide>Aucun mois en cours à suivre.</Vide>
            ) : (
              <>
                <div
                  role="img"
                  aria-label={`Cotisations de ${moisLong(moisCourant)} : ${compteEnClair}`}
                  className="flex flex-wrap gap-1.5"
                >
                  {moisDuClub.map((c, i) => (
                    <GlypheEtat key={i} statut={c.statut} taille={22} />
                  ))}
                </div>
                <p className="mt-3 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                  {compteEnClair}.
                </p>
              </>
            )}
          </Carte>

          <Carte titre="Performance">
            {/*
              * Deux colonnes, a toute largeur : cette carte occupe une
              * demi-colonne des 1 280 px, ou quatre montants a sept chiffres
              * ne tiennent pas cote a cote.
              */}
            <CarteEtat
              colonnes={2}
              chiffres={[
                { libelle: "Versé par le club", brut: s.totalVerse, unite: "FCFA" },
                { libelle: "Place en bourse", brut: s.totalApports, unite: "FCFA" },
                { libelle: "En caisse", brut: s.totalEnCaisse, unite: "FCFA" },
                { libelle: "Membres", brut: situations.length },
              ]}
            />
            {/*
              * La performance annualisee figure deja en tete d'ecran, a cote de
              * la valeur du portefeuille : la repeter ici la faisait lire deux
              * fois. Reste l'exercice en cours, qu'on ne lit nulle part ailleurs.
              */}
            <div className="mt-5">
              <div>
                <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                  Exercice en cours
                </p>
                <p
                  className="mt-0.5 text-[17px] font-medium tabular-nums"
                  style={{ color: couleurSigne(s.exercice?.rendement) }}
                >
                  {s.exercice?.rendement != null ? pourcent(s.exercice.rendement) : "--"}
                </p>
              </div>
            </div>

            <details className="mt-3">
              <summary
                className="tapable flex h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 text-[13px] lg:h-11"
                style={{ color: "var(--ink-2)" }}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="chevron flex-none">
                  <path
                    d="M9.5 6 L15.5 12 L9.5 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Comment la performance est calculée
              </summary>
              <div
                className="contenu-depliant space-y-2 pt-1 pb-2 pl-8 text-[13px] leading-relaxed"
                style={{ color: "var(--ink-2)" }}
              >
                <p>
                  Le taux annualisé porte sur les dates réelles de virement au compte-titres.
                  {s.triPeriode && (
                    <>
                      {" "}
                      Il couvre {dureeEnClair(s.triPeriode.annees)} de placement, du{" "}
                      {dateCourte(s.triPeriode.debut)} au {dateCourte(s.triPeriode.fin)}, date du
                      dernier relevé.
                      {s.triPeriode.debut === CLUB.ouvertureCompteTitres && (
                        <>
                          {" "}
                          La période part de l&apos;ouverture du compte chez {CLUB.sgi} : les
                          virements antérieurs avaient quitté la caisse, mais n&apos;étaient pas
                          encore places.
                        </>
                      )}
                    </>
                  )}
                </p>
                {s.exercice?.rendement != null && (
                  <p>
                    L&apos;exercice en cours suit la méthode Dietz modifiée : gain de gestion{" "}
                    {fcfa(s.exercice.gain)} sur un capital moyen de {fcfa(s.exercice.capitalMoyen)}.
                  </p>
                )}
              </div>
            </details>
          </Carte>
        </div>
      </div>

      <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
        Cotisation statutaire : {fcfa(REGLES.cotisationMensuelle)} par mois et par membre, exigible
        le {REGLES.jourEcheance} (art. 8). Club fondé le {dateCourte(CLUB.dateCreation)}.
      </p>
    </>
  );
}
