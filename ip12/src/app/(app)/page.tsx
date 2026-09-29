import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { situationsClub, synthese } from "@/lib/queries";
import { dureeEnClair, pourcent } from "@/lib/perf";
import { CLUB, REGLES, dateCourte, debutMois, fcfa, moisLong, nombre } from "@/lib/settings";
import { Badge, Carte, CarteEtat, EnTeteEcran, Vide } from "@/components/ui";
import {
  Frise,
  GlypheEtat,
  LIBELLE_STATUT,
  STATUTS_LEGENDE,
  statutLigne,
} from "@/components/glyphe-etat";
import {
  EcranInitialisation,
  estTableAbsente,
} from "@/components/initialisation";
import type { StatutMois } from "@/lib/penalites";

export const dynamic = "force-dynamic";

/**
 * Le bouton qui mene a l'action, quand la page en designe une.
 *
 * L'or plein porte l'encre brune : 6,9:1, le seul emploi de l'or ou le texte
 * pose dessus reste lisible dans les deux themes.
 */
function BoutonPrincipal({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="tapable grid h-13 place-items-center rounded-2xl text-[15px] font-bold"
      style={{ background: "var(--ink)", color: "var(--page)" }}
    >
      {children}
    </Link>
  );
}

/** Deux chiffres cote a cote, sous un titre : « Cotisation due », « Penalite ». */
function Couple({
  gauche,
  droite,
}: {
  gauche: { libelle: string; valeur: string };
  droite: { libelle: string; valeur: string };
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {[gauche, droite].map((c) => (
        <div key={c.libelle}>
          <p className="text-[12px]" style={{ color: "var(--discret)" }}>
            {c.libelle}
          </p>
          <p className="text-[17px] font-bold whitespace-nowrap tabular-nums">{c.valeur}</p>
        </div>
      ))}
    </div>
  );
}

/** Une ligne-resume : un compte, ce qu'il designe, et ou cela se traite. */
function LigneATraiter({
  compte,
  ton,
  titre,
  detail,
  href,
}: {
  compte: number;
  ton: "ambre" | "rouge";
  titre: string;
  detail: string;
  href: string;
}) {
  return (
    <li>
      <Link href={href} className="tapable flex items-center gap-3 py-2.5">
        <span
          className="grid h-9 w-9 flex-none place-items-center rounded-xl text-[15px] font-bold"
          style={{
            background: ton === "rouge" ? "var(--rouge-fond)" : "var(--ambre-fond)",
            color: ton === "rouge" ? "var(--rouge-encre)" : "var(--ambre-encre)",
          }}
        >
          {compte}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{titre}</span>
          <span className="block truncate text-[12px]" style={{ color: "var(--discret)" }}>
            {detail}
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-4 w-4 flex-none"
          style={{
            fill: "none",
            stroke: "var(--discret)",
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }}
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

  const maPart = s.parts.find((p) => p.membreId === membre.id);
  const maSituation = situations.find((x) => x.membreId === membre.id);
  const retardataires = situations.filter((x) => x.nbMoisRetard > 0);
  const estBureau = membre.role === "president" || membre.role === "tresorier";

  const maFenetre = maSituation?.cellules.slice(-14) ?? [];
  const moisCourant = debutMois();

  /*
   * Ce qui me reste a verser ce mois-ci : la cellule du mois courant le sait
   * deja, taux particulier compris. Rien n'est recalcule ici.
   */
  const celluleDuMois = maSituation?.cellules.find((c) => c.mois === moisCourant);
  const aFaire =
    maSituation && (maSituation.nbMoisRetard > 0 || maSituation.totalPenalites > 0);

  /* L'etat du mois courant, membre par membre : un glyphe chacun, tries. */
  const rangStatut = (st: StatutMois) => {
    const i = STATUTS_LEGENDE.indexOf(st);
    return i < 0 ? STATUTS_LEGENDE.length : i;
  };
  const moisDuClub = situations
    .map((x) => x.cellules.find((c) => c.mois === moisCourant))
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && c!.statut !== "hors_periode")
    .sort((a, b) => rangStatut(a.statut) - rangStatut(b.statut));
  const payesCeMois = moisDuClub.filter(
    (c) => c.statut === "paye" || c.statut === "paye_en_retard",
  ).length;
  const compteParEtat = STATUTS_LEGENDE.map((st) => ({
    statut: st,
    nb: moisDuClub.filter((c) => c.statut === st).length,
  })).filter((x) => x.nb > 0);

  return (
    <>
      <EnTeteEcran
        titre="Ma part"
        sous={
          s.valorisation ? `au ${dateCourte(s.valorisation.date_valo)}` : "— aucun releve saisi"
        }
        chiffre={maPart && s.valorisation ? nombre(maPart.valeur) : "--"}
        unite={maPart && s.valorisation ? "FCFA" : undefined}
        detail={
          maPart
            ? `${(maPart.part * 100).toFixed(1).replace(".", ",")} % du portefeuille, au prorata de mes versements valides.`
            : "Votre part se calcule des votre premier versement valide."
        }
      />

      <CarteEtat
        chiffres={[
          {
            libelle: "Portefeuille du club",
            valeur: s.valorisation ? nombre(s.valorisation.total) : "--",
            unite: s.valorisation ? "FCFA" : undefined,
          },
          {
            libelle: "Performance annualisee",
            valeur: s.tri !== null ? pourcent(s.tri) : "--",
            contexte: s.triPeriode ? `TRI depuis le ${dateCourte(s.triPeriode.debut)}` : undefined,
          },
        ]}
      />

      {/*
       * Ce qu'il y a a faire, avant tout le reste.
       *
       * Un membre ouvre le site pour savoir s'il doit quelque chose. La reponse
       * etait auparavant au milieu de la page, apres quatre chiffres de
       * gestion : elle est desormais la premiere chose qui suit sa part.
       */}
      {maSituation && (
        <Carte titre="A faire">
          {!aFaire ? (
            <p className="flex items-center gap-2 text-[14px]">
              <GlypheEtat statut="paye" taille={22} />
              <span>
                Rien a faire. Prochaine echeance le {REGLES.jourEcheance} du mois.
              </span>
            </p>
          ) : (
            <div
              className="rounded-2xl p-3.5"
              style={{ background: "var(--rouge-fond)" }}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5">
                  <GlypheEtat statut="retard" taille={26} />
                </span>
                <div className="min-w-0">
                  <p
                    className="text-[15px] leading-snug font-bold"
                    style={{ color: "var(--rouge-encre)" }}
                  >
                    {maSituation.nbMoisRetard > 0
                      ? `${maSituation.nbMoisRetard} mois de cotisation en retard`
                      : "Penalites de retard a regler"}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-snug">
                    {maSituation.moisEnRetard.length > 0
                      ? `${maSituation.moisEnRetard.map((m) => moisLong(m)).join(", ")}. `
                      : ""}
                    La penalite de l&apos;art. 9 reste acquise au club, meme apres
                    regularisation.
                  </p>
                </div>
              </div>

              <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--bordure)" }}>
                <Couple
                  gauche={{
                    libelle: "Cotisation due",
                    valeur: fcfa(celluleDuMois?.manque ?? REGLES.cotisationMensuelle),
                  }}
                  droite={{
                    libelle: `Penalites (${Math.round(REGLES.tauxPenalite * 100)} %)`,
                    valeur: fcfa(maSituation.totalPenalites),
                  }}
                />
              </div>

              <div className="mt-3">
                <BoutonPrincipal href="/versements">
                  Declarer mon versement
                </BoutonPrincipal>
              </div>
            </div>
          )}

          {maSituation.voteSuspendu && (
            <p className="mt-3 text-xs" style={{ color: "var(--rouge-encre)" }}>
              R2 : votre droit de vote est suspendu au-dela de{" "}
              {REGLES.suspensionVoteApresJours} jours de retard, jusqu&apos;a
              regularisation complete.
            </p>
          )}
          {maSituation.declarationRequise && (
            <p className="mt-2 text-xs" style={{ color: "var(--ambre-encre)" }}>
              R3 : vous devez declarer ce retard sur le groupe WhatsApp du club en
              taguant tous les membres, puis l&apos;enregistrer depuis la page{" "}
              <Link href="/versements" className="underline">
                Versements
              </Link>
              .
            </p>
          )}
        </Carte>
      )}

      {estBureau && (s.enAttenteValidation > 0 || retardataires.length > 0) && (
        <Carte titre="A traiter">
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {s.enAttenteValidation > 0 && (
              <LigneATraiter
                compte={s.enAttenteValidation}
                ton="ambre"
                titre={`Versement${s.enAttenteValidation > 1 ? "s" : ""} a valider`}
                detail="Declares par les membres, en attente de votre visa"
                href="/versements"
              />
            )}
            {retardataires.length > 0 && (
              <LigneATraiter
                compte={retardataires.length}
                ton="rouge"
                titre={`Membre${retardataires.length > 1 ? "s" : ""} en retard`}
                detail={retardataires.map((r) => r.nom).join(", ")}
                href="/penalites"
              />
            )}
          </ul>
        </Carte>
      )}

      {maSituation && (
        <Carte
          titre="Mon suivi"
          action={
            <Link href="/versements" className="text-xs underline" style={{ color: "var(--gold-ink)" }}>
              Voir le registre
            </Link>
          }
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-[15px] font-semibold">{maSituation.nom}</span>
            <span
              className="flex-none text-[12px] font-semibold"
              style={{ color: statutLigne(maFenetre).encre }}
            >
              {statutLigne(maFenetre).texte}
            </span>
          </div>
          <Frise cellules={maFenetre} taille={18} etiquette={maSituation.nom} />
          <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--bordure)" }}>
            <Couple
              gauche={{ libelle: "Versements valides", valeur: fcfa(maSituation.verse) }}
              droite={{
                libelle: "Penalites dues",
                valeur: fcfa(maSituation.totalPenalites),
              }}
            />
          </div>
        </Carte>
      )}

      <Carte
        titre={`Le club en ${moisLong(moisCourant)}`}
        action={
          <span className="text-xs" style={{ color: "var(--discret)" }}>
            {payesCeMois} sur {moisDuClub.length} payees
          </span>
        }
      >
        {moisDuClub.length === 0 ? (
          <Vide>Aucun mois en cours a suivre.</Vide>
        ) : (
          <>
            <div
              role="img"
              aria-label={`Cotisations de ${moisLong(moisCourant)} : ${compteParEtat
                .map((x) => `${x.nb} ${LIBELLE_STATUT[x.statut].toLowerCase()}`)
                .join(", ")}`}
              className="flex flex-wrap gap-1.5"
            >
              {moisDuClub.map((c, i) => (
                <GlypheEtat key={i} statut={c.statut} taille={24} />
              ))}
            </div>
            <p className="mt-2.5 text-[12px]" style={{ color: "var(--discret)" }}>
              {compteParEtat
                .map((x) => `${x.nb} ${LIBELLE_STATUT[x.statut].toLowerCase()}`)
                .join(", ")}
              .
            </p>
          </>
        )}
      </Carte>

      {(s.tri !== null || s.exercice) && (
        <Carte titre="Performance">
          <div className="grid gap-4 sm:grid-cols-2">
            {s.tri !== null && (
              <div>
                {/*
                 * Une performance negative reste en encre : le rouge est reserve
                 * a ce qui manque ou bloque, et un marche qui baisse ne demande
                 * aucune action au membre qui lit la page.
                 */}
                <p className="text-2xl font-semibold tabular-nums">
                  {pourcent(s.tri)}
                  <span
                    className="ml-1 text-xs font-normal"
                    style={{ color: "var(--discret)" }}
                  >
                    par an
                  </span>
                </p>
                <p className="text-xs" style={{ color: "var(--discret)" }}>
                  TRI annualise sur les dates reelles de virement au
                  compte-titres.
                  {s.triPeriode && (
                    <>
                      {" "}
                      Il porte sur {dureeEnClair(s.triPeriode.annees)} de
                      placement, du {dateCourte(s.triPeriode.debut)} au{" "}
                      {dateCourte(s.triPeriode.fin)}, date du dernier releve.
                      {/*
                       * Les premiers virements portent la date a laquelle l'argent a
                       * quitte la caisse, avant que le compte existe. Le dire evite de
                       * laisser croire a une date choisie au hasard -- et rappelle que
                       * le taux ne compte pas les semaines de transit.
                       */}
                      {s.triPeriode.debut === CLUB.ouvertureCompteTitres && (
                        <>
                          {" "}
                          La periode part de l&apos;ouverture du compte chez{" "}
                          {CLUB.sgi} : les virements anterieurs avaient quitte
                          la caisse, mais n&apos;etaient pas encore places.
                        </>
                      )}
                    </>
                  )}
                </p>
              </div>
            )}
            {s.exercice?.rendement != null && (
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {pourcent(s.exercice.rendement)}
                </p>
                <p className="text-xs" style={{ color: "var(--discret)" }}>
                  Exercice en cours (Dietz modifie) &middot; gain de gestion{" "}
                  {fcfa(s.exercice.gain)} sur un capital moyen de{" "}
                  {fcfa(s.exercice.capitalMoyen)}.
                </p>
              </div>
            )}
          </div>
          <div
            className="mt-4 grid grid-cols-2 gap-3 border-t pt-3"
            style={{ borderColor: "var(--bordure)" }}
          >
            <Couple
              gauche={{ libelle: "Verse par le club", valeur: fcfa(s.totalVerse) }}
              droite={{ libelle: "Place en bourse", valeur: fcfa(s.totalApports) }}
            />
            <Couple
              gauche={{ libelle: "En caisse", valeur: fcfa(s.totalEnCaisse) }}
              droite={{
                libelle: "Membres",
                valeur: String(situations.length),
              }}
            />
          </div>
        </Carte>
      )}

      <Carte titre={`Retardataires (${retardataires.length})`}>
        {retardataires.length === 0 ? (
          <Vide>
            Aucun retard : les {situations.length} membres sont a jour.
          </Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {retardataires.map((r) => (
              <li
                key={r.membreId}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <div>
                  <p className="text-sm font-medium">{r.nom}</p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {r.nbMoisRetard} mois &middot; {r.joursDeRetard} jours
                    &middot; {fcfa(r.totalPenalites)} de penalites
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.voteSuspendu && <Badge ton="rouge">Vote suspendu</Badge>}
                  {r.exclusionEncourue && <Badge ton="rouge">Art. 20</Badge>}
                  {r.declarationRequise && (
                    <Badge ton="ambre">R3 a declarer</Badge>
                  )}
                  {r.retardDeclare && (
                    <Badge ton="neutre">Retard declare</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Carte>

      <p
        className="text-center text-[11px]"
        style={{ color: "var(--discret)" }}
      >
        Cotisation statutaire : {fcfa(REGLES.cotisationMensuelle)} par mois et
        par membre, exigible le {REGLES.jourEcheance} (art. 8). Club fonde le{" "}
        {dateCourte(CLUB.dateCreation)}.
      </p>
    </>
  );
}
