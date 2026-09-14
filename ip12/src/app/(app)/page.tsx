import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { situationsClub, synthese } from "@/lib/queries";
import { dureeEnClair, pourcent } from "@/lib/perf";
import { CLUB, REGLES, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { Alerte, Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

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

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Statistique
          libelle="Portefeuille"
          valeur={s.valorisation ? fcfa(s.valorisation.total) : "--"}
          detail={s.valorisation ? `Releve du ${dateCourte(s.valorisation.date_valo)}` : "Aucun releve saisi"}
          accent="or"
        />
        <Statistique
          libelle="Ma part"
          valeur={maPart && s.valorisation ? fcfa(maPart.valeur) : "--"}
          detail={
            maPart
              ? `${(maPart.part * 100).toFixed(1).replace(".", ",")} % du club${s.valorisation ? "" : " — releve a saisir"}`
              : undefined
          }
        />
        <Statistique
          libelle="Verse par le club"
          valeur={fcfa(s.totalVerse)}
          detail={`dont ${fcfa(s.totalApports)} places en bourse`}
        />
        <Statistique
          libelle="En caisse"
          valeur={fcfa(s.totalEnCaisse)}
          detail="Encaisse non encore investi"
          accent={s.totalEnCaisse < 0 ? "rouge" : "neutre"}
        />
      </div>

      {(s.tri !== null || s.exercice) && (
        <Carte titre="Performance">
          <div className="grid gap-4 sm:grid-cols-2">
            {s.tri !== null && (
              <div>
                <p
                  className="text-2xl font-semibold"
                  style={{ color: s.tri >= 0 ? "var(--color-vert-600)" : "var(--color-rouge-600)" }}
                >
                  {pourcent(s.tri)}
                  <span className="ml-1 text-xs font-normal" style={{ color: "var(--discret)" }}>
                    par an
                  </span>
                </p>
                <p className="text-xs" style={{ color: "var(--discret)" }}>
                  TRI annualise sur les dates reelles de virement au compte-titres.
                  {s.triPeriode && (
                    <>
                      {" "}
                      Il porte sur {dureeEnClair(s.triPeriode.annees)} de placement, du{" "}
                      {dateCourte(s.triPeriode.debut)} au {dateCourte(s.triPeriode.fin)}, date du
                      dernier releve.
                    </>
                  )}
                </p>
              </div>
            )}
            {s.exercice?.rendement != null && (
              <div>
                <p
                  className="text-2xl font-semibold"
                  style={{
                    color: s.exercice.rendement >= 0 ? "var(--color-vert-600)" : "var(--color-rouge-600)",
                  }}
                >
                  {pourcent(s.exercice.rendement)}
                </p>
                <p className="text-xs" style={{ color: "var(--discret)" }}>
                  Exercice en cours (Dietz modifie) &middot; gain de gestion{" "}
                  {fcfa(s.exercice.gain)} sur un capital moyen de {fcfa(s.exercice.capitalMoyen)}.
                </p>
              </div>
            )}
          </div>
        </Carte>
      )}

      <Carte titre="Ma situation">
        {!maSituation || maSituation.nbMoisRetard === 0 ? (
          <Alerte ton="vert">
            Vous etes a jour de vos versements. Prochaine echeance : le {REGLES.jourEcheance} du mois.
          </Alerte>
        ) : (
          <div className="space-y-3">
            <Alerte
              ton={maSituation.exclusionEncourue ? "rouge" : "ambre"}
              titre={`${maSituation.nbMoisRetard} mois de retard`}
            >
              {maSituation.moisEnRetard.map((m) => moisLong(m)).join(", ")}. Penalites dues :{" "}
              <strong>{fcfa(maSituation.totalPenalites)}</strong> (art. 9
              {maSituation.penalites.some((p) => p.doublee) ? ", doublees par R4" : ""}).
            </Alerte>
            {maSituation.voteSuspendu && (
              <p className="text-xs" style={{ color: "var(--color-rouge-600)" }}>
                R2 : votre droit de vote est suspendu au-dela de {REGLES.suspensionVoteApresJours} jours
                de retard, jusqu&apos;a regularisation complete.
              </p>
            )}
            {maSituation.declarationRequise && (
              <p className="text-xs" style={{ color: "var(--color-ambre-600)" }}>
                R3 : vous devez declarer ce retard sur le groupe WhatsApp du club en taguant tous les
                membres, puis l&apos;enregistrer depuis la page{" "}
                <Link href="/versements" className="underline">
                  Versements
                </Link>
                .
              </p>
            )}
          </div>
        )}
      </Carte>

      {estBureau && s.enAttenteValidation > 0 && (
        <Carte titre="A traiter">
          <Alerte ton="ambre">
            {s.enAttenteValidation} versement{s.enAttenteValidation > 1 ? "s" : ""} en attente de
            validation.{" "}
            <Link href="/versements" className="underline">
              Ouvrir la liste
            </Link>
          </Alerte>
        </Carte>
      )}

      <Carte titre={`Retardataires (${retardataires.length})`}>
        {retardataires.length === 0 ? (
          <Vide>Aucun retard : les {situations.length} membres sont a jour.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {retardataires.map((r) => (
              <li key={r.membreId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium">{r.nom}</p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {r.nbMoisRetard} mois &middot; {r.joursDeRetard} jours &middot;{" "}
                    {fcfa(r.totalPenalites)} de penalites
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.voteSuspendu && <Badge ton="rouge">Vote suspendu</Badge>}
                  {r.exclusionEncourue && <Badge ton="rouge">Art. 20</Badge>}
                  {r.declarationRequise && <Badge ton="ambre">R3 a declarer</Badge>}
                  {r.retardDeclare && <Badge ton="neutre">Retard declare</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Carte>

      <p className="text-center text-[11px]" style={{ color: "var(--discret)" }}>
        Cotisation statutaire : {fcfa(REGLES.cotisationMensuelle)} par mois et par membre, exigible le{" "}
        {REGLES.jourEcheance} (art. 8). Club fonde le {dateCourte(CLUB.dateCreation)}.
      </p>
    </>
  );
}
