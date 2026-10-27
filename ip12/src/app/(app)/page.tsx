import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import {
  listerMouvementsCaisse,
  reglementsPenalite,
  situationsClub,
  synthese,
  versementsEnAttente,
} from "@/lib/queries";
import { STATUT_CAISSE, STATUT_REGLEMENT } from "@/lib/valeurs";
import { couleurSigne, dureeEnClair, pourcent } from "@/lib/perf";
import { CLUB, REGLES, accorde, dateCourte, deMois, debutMois, fcfa, moisLong, nombre } from "@/lib/settings";
import { Carte, CarteEtat, EnTeteEcran, ValeurChiffree, Vide } from "@/components/ui";
import { LienBouton } from "@/components/boutons";
import { Frise, GlypheEtat, LIBELLE_STATUT, STATUTS_LEGENDE, estEntame, statutLigne } from "@/components/glyphe-etat";
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
 * Une tuile du bandeau : un libelle, le chiffre, et une ligne qui le situe.
 *
 * Quatre tuiles cote a cote disent l'etat du club d'un regard, avant tout
 * texte. Une seule couleur y signale ce qui reclame un geste : l'accent, sur
 * la tuile qui mene a une file a traiter. Le reste demeure a l'encre.
 */
function Tuile({
  libelle,
  brut,
  valeur,
  unite,
  encre,
  contexte,
  href,
  rang,
}: {
  libelle: string;
  brut?: number;
  valeur?: ReactNode;
  unite?: string;
  encre?: string;
  contexte: ReactNode;
  /** Une file a traiter : la tuile y mene, et porte l'accent. */
  href?: string;
  rang: number;
}) {
  const corps = (
    <>
      <p className="text-[12.5px]" style={{ color: href ? "var(--accent)" : "var(--ink-2)" }}>
        {libelle}
      </p>
      <div className="mt-1.5">
        <ValeurChiffree
          brut={brut}
          valeur={valeur}
          unite={unite}
          encre={encre ?? (href ? "var(--accent)" : undefined)}
          retard={rang * 22}
          taille="text-[20px] lg:text-[24px]"
        />
      </div>
      <p className="mt-1 truncate text-[12px]" style={{ color: "var(--ink-3)" }}>
        {contexte}
      </p>
    </>
  );
  const cadre = {
    borderColor: href ? "var(--accent)" : "var(--line)",
    background: "var(--carte)",
  };
  return (
    <li>
      {href ? (
        <Link href={href} className="tapable block h-full rounded-xl border p-3.5" style={cadre}>
          {corps}
        </Link>
      ) : (
        <div className="h-full rounded-xl border p-3.5" style={cadre}>
          {corps}
        </div>
      )}
    </li>
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
  /* Des personnes : une part rachetee a sa ligne de cotisation, pas une place de membre. */
  const nbMembres = situations.filter((x) => !x.titulaireId).length;
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
  const [versementsAValider, reglementsEnAttente, mouvementsEnAttente] = estBureau
    ? await Promise.all([
        versementsEnAttente().catch(() => []),
        reglementsPenalite({ statut: STATUT_REGLEMENT.enAttente }).catch(() => []),
        listerMouvementsCaisse()
          .then((m) => m.filter((x) => x.statut === STATUT_CAISSE.enAttente))
          .catch(() => []),
      ])
    : [[], [], []];

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
   * La dette inscrite plus ce qui court : les deux sont dues, et la part du
   * membre les porte deja reunies (lib/queries, synthese). Ce qui court ne sert
   * ici qu'a defaut de part.
   */
  const detteDe = (membreId: string) =>
    s.parts.find((p) => p.membreId === membreId)?.dues ?? courues?.get(membreId)?.montant ?? 0;
  const maDette = maSituation ? detteDe(membre.id) : 0;
  const aFaireMoi = Boolean(maSituation && (maSituation.nbMoisRetard > 0 || maDette > 0));
  /*
   * LES PARTS RACHETEES QUE CE MEMBRE DETIENT.
   *
   * Elles ont leurs propres mois et leurs propres penalites, et c'est lui qui
   * les paie. L'accueil n'en disait rien : le detenteur d'une part qui devait la
   * penalite reprise au rachat lisait « Rien a faire, vous etes a jour », et
   * « Ma part » ignorait la valeur de ce qu'il avait rachete.
   */
  const partsDetenues = situations
    .filter((x) => x.titulaireId === membre.id)
    .map((x) => ({
      situation: x,
      valeur: s.parts.find((p) => p.membreId === x.membreId)?.valeur ?? 0,
      dette: detteDe(x.membreId),
      cotisations: cotisationsARegler(x.cellules).total,
    }));
  const partsAFaire = partsDetenues.filter(
    (p) => p.situation.nbMoisRetard > 0 || p.dette > 0 || p.cotisations > 0,
  );
  const aFaire = aFaireMoi || partsAFaire.length > 0;
  const valeurPartsDetenues = partsDetenues.reduce((t, p) => t + p.valeur, 0);

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
  /* « 5 payés », « 1 payé » : l'etat s'accorde avec le nombre de membres. */
  const compteEnClair = compteParEtat
    .map((x) => {
      const libelle = LIBELLE_STATUT[x.statut].toLowerCase();
      return `${x.nb} ${x.nb > 1 ? libelle.replace(/^(payé|incomplet)/, "$1s") : libelle}`;
    })
    .join(", ");

  /*
   * Une avance payee a l'ancien montant : depuis la fusion des parts rachetees,
   * un mois paye 5 000 d'avance en demande 7 500. Ce n'est pas un retard, mais
   * le complement est du avant l'echeance, sous peine de penalite.
   */
  const aCompleter = (maSituation?.avances ?? []).filter(estEntame);
  /*
   * Des declarations, comme la boite « A valider » les compte : un versement de
   * deux mois est une declaration, non deux lignes ; un reglement de trois
   * penalites, une seule.
   */
  const nbVersements = new Set(versementsAValider.map((v) => v.lot)).size;
  const nbReglements = new Set(reglementsEnAttente.map((r) => r.lot ?? r.id)).size;
  const aValider = nbVersements + nbReglements + mouvementsEnAttente.length;
  const prochain = maSituation?.prochainReglement ?? null;

  return (
    <>
      <EnTeteEcran
        titre="Ma part"
        sous={s.valorisation ? `au ${dateCourte(s.valorisation.date_valo)}` : "aucun relevé saisi"}
        chiffre={maPart && s.valorisation ? undefined : "--"}
        brut={maPart && s.valorisation ? maPart.valeur : undefined}
        unite={maPart && s.valorisation ? "FCFA" : undefined}
        detail={
          (maPart
            ? `${(maPart.part * 100).toFixed(1).replace(".", ",")} % du portefeuille, au prorata de mes versements validés.`
            : "Votre part se calcule dès votre premier versement validé.") +
          (partsDetenues.length > 0
            ? ` En plus, ${accorde(partsDetenues.length, "part rachetée", "parts rachetées")} : ${fcfa(valeurPartsDetenues)}.`
            : "")
        }
      />

      {/*
        * LE BANDEAU : L'ETAT DU CLUB EN QUATRE CHIFFRES.
        *
        * Le portefeuille et la performance etaient poses a droite du heros, en
        * petit ; le compte du mois et la file a traiter, plus bas, dans des
        * cartes. Reunis en tuiles, ils se lisent d'un regard en ouvrant la page.
        * La quatrieme tuile depend du lecteur : la file a valider pour le
        * bureau, son prochain versement pour un membre.
        */}
      <ul className="apparait grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tuile
          rang={0}
          libelle="Portefeuille du club"
          brut={s.valorisation ? s.valorisation.total : undefined}
          valeur={s.valorisation ? undefined : "--"}
          unite={s.valorisation ? "FCFA" : undefined}
          contexte={s.valorisation ? "selon le dernier relevé" : "aucun relevé saisi"}
        />
        <Tuile
          rang={1}
          libelle="Performance"
          valeur={s.tri !== null ? pourcent(s.tri) : "--"}
          encre={couleurSigne(s.tri)}
          contexte={`par an, depuis ${(s.triPeriode?.debut ?? CLUB.dateCreation).slice(0, 4)}`}
        />
        <Tuile
          rang={2}
          libelle="Cotisations du mois"
          valeur={`${payesCeMois} / ${moisDuClub.length}`}
          contexte={
            payesCeMois === moisDuClub.length
              ? `${moisLong(moisCourant).split(" ")[0]} : toutes payées`
              : `${moisLong(moisCourant).split(" ")[0]} : ${moisDuClub.length - payesCeMois} à recevoir`
          }
        />
        {estBureau ? (
          <Tuile
            rang={3}
            libelle="À valider"
            brut={aValider}
            contexte={
              aValider === 0
                ? "rien en attente"
                : [
                    nbVersements > 0 ? `${nbVersements} ${accorde(nbVersements, "versement", "versements")}` : null,
                    nbReglements > 0 ? `${nbReglements} ${accorde(nbReglements, "pénalité", "pénalités")}` : null,
                    mouvementsEnAttente.length > 0 ? `${mouvementsEnAttente.length} en caisse` : null,
                  ]
                    .filter(Boolean)
                    .join(", ")
            }
            href={aValider === 0 ? undefined : "/a-valider"}
          />
        ) : (
          <Tuile
            rang={3}
            libelle="Mon prochain versement"
            brut={prochain?.reste}
            valeur={prochain ? undefined : "--"}
            unite={prochain ? "FCFA" : undefined}
            contexte={prochain ? `pour ${moisLong(prochain.mois)}` : "rien à verser"}
            href={aFaire || aCompleter.length > 0 ? "/versements" : undefined}
          />
        )}
      </ul>

      <div className="grid grid-cols-1 gap-11 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
        {/*
          * A FAIRE d'abord, et sur la colonne de droite sur grand ecran : c'est
          * la seule chose de la page qui reclame un geste. Le reste se lit.
          */}
        <div className="flex flex-col gap-11 xl:order-2">
          {maSituation && (
            <Carte titre={aFaire || aCompleter.length > 0 ? "À faire" : "Rien à faire"}>
              {!aFaireMoi && aCompleter.length > 0 ? (
                <>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5">
                      <GlypheEtat statut="a_venir" entame taille={22} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium">
                        {aCompleter.length} {accorde(aCompleter.length, "mois payé", "mois payés")} d&apos;avance à compléter
                      </p>
                      <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
                        Votre cotisation est passée à {fcfa(aCompleter[0].requis)}. Il manque{" "}
                        {fcfa(aCompleter.reduce((t, c) => t + c.manque, 0))} sur{" "}
                        {aCompleter.map((c) => moisLong(c.mois)).join(", ")}, dont{" "}
                        {fcfa(aCompleter[0].manque)} avant le {REGLES.jourEcheance}{" "}
                        {moisLong(aCompleter[0].mois).split(" ")[0]}.
                      </p>
                    </div>
                  </div>
                  <div className="mt-5">
                    <LienBouton href="/versements">Compléter mon avance</LienBouton>
                  </div>
                </>
              ) : !aFaireMoi ? (
                <p className="flex items-center gap-2.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                  <GlypheEtat statut="paye" taille={18} />
                  {partsAFaire.length > 0
                    ? "Votre part est à jour."
                    : `Vous êtes à jour. Prochaine échéance le ${REGLES.jourEcheance} du mois.`}
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
                          : "Pénalités à régler"}
                      </p>
                      {/*
                        * La phrase de l'art. 9 parle des retards : elle n'a rien a
                        * faire sous une penalite d'absence, seule dette du membre.
                        */}
                      <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
                        {maSituation.moisEnRetard.length > 0
                          ? `${maSituation.moisEnRetard.map((m) => moisLong(m)).join(", ")}. ` +
                            "La pénalité de l'art. 9 reste acquise au club, même après régularisation."
                          : "Déclarez leur règlement depuis Versements, en choisissant « une pénalité »."}
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

              {/*
                * Chaque part rachetee qui doit quelque chose, a part : ses mois et
                * ses penalites ne sont pas ceux de son detenteur.
                */}
              {partsAFaire.map((p) => (
                <div
                  key={p.situation.membreId}
                  className="mt-4 border-t pt-4"
                  style={{ borderColor: "var(--line)" }}
                >
                  <p className="text-[14px] font-medium" style={{ color: "var(--etat-manque)" }}>
                    Part rachetée : {p.situation.nom}
                  </p>
                  <div className="mt-3">
                    <Couple
                      chiffres={[
                        { libelle: "Cotisations à régler", brut: p.cotisations },
                        { libelle: "Pénalités dues", brut: p.dette },
                      ]}
                    />
                  </div>
                  <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                    Déclarez le versement en choisissant cette part : elle a ses propres mois et ses
                    propres pénalités.
                  </p>
                </div>
              ))}
              {!aFaireMoi && partsAFaire.length > 0 && (
                <div className="mt-5">
                  <LienBouton href="/versements">Déclarer un versement</LienBouton>
                </div>
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
          {estBureau && aValider > 0 && (
            <Carte titre="À traiter">
              <ul>
                {nbVersements > 0 && (
                  <LigneATraiter
                    compte={nbVersements}
                    titre={`Versement${nbVersements > 1 ? "s" : ""} à valider`}
                    detail={[...new Set(versementsAValider.map((v) => v.membre_nom))].join(", ")}
                    href="/a-valider?type=versements"
                  />
                )}
                {nbReglements > 0 && (
                  <LigneATraiter
                    compte={nbReglements}
                    titre={`Règlement${nbReglements > 1 ? "s" : ""} de pénalité à valider`}
                    detail={[...new Set(reglementsEnAttente.map((r) => r.membre_nom))].join(", ")}
                    href="/a-valider?type=penalites"
                  />
                )}
                {mouvementsEnAttente.length > 0 && (
                  <LigneATraiter
                    compte={mouvementsEnAttente.length}
                    titre={`Mouvement${mouvementsEnAttente.length > 1 ? "s" : ""} de caisse à valider`}
                    detail="Saisis, en attente de votre visa"
                    href="/a-valider?type=caisse"
                  />
                )}
              </ul>
            </Carte>
          )}

          <Carte titre={`Retardataires (${retardataires.length})`}>
            {retardataires.length === 0 ? (
              <Vide>Aucun retard : les {nbMembres} membres sont à jour.</Vide>
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
                  aria-label={`Cotisations ${deMois(moisCourant)} : ${compteEnClair}`}
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
                { libelle: "Membres", brut: nbMembres },
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
