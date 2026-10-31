import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { bulletinsDes, clotureEnClair, electeursDu, listerVotes, type Vote } from "@/lib/votes";
import { MAJORITES, STATUT_VOTE, depouiller, pourcent } from "@/lib/scrutin";
import { dateCourte, accorde } from "@/lib/settings";
import { Carte, EnTeteEcran, Vide } from "@/components/ui";
import { LienBouton } from "@/components/boutons";
import { BulletinVote } from "@/components/bulletin-vote";
import { HeureChezVous } from "@/components/fuseau";

export const dynamic = "force-dynamic";
export const metadata = { title: "Votes" };

/** Les jours qui restent avant la cloture, en clair. */
function reste(cloture: Date, maintenant: Date): string {
  const heures = (cloture.getTime() - maintenant.getTime()) / 3_600_000;
  if (heures < 1) return "dans moins d'une heure";
  if (heures < 24) return `dans ${Math.floor(heures)} ${accorde(Math.floor(heures), "heure")}`;
  const jours = Math.round(heures / 24);
  return `dans ${jours} ${accorde(jours, "jour")}`;
}

export default async function PageVotes() {
  const membre = await exigerMembre();
  const maintenant = new Date();
  let votes: Vote[] = [];
  try {
    votes = await listerVotes();
  } catch {
    votes = [];
  }
  const [bulletins, listes] = await Promise.all([bulletinsDes(votes.map((v) => v.id)), Promise.all(votes.map((v) => electeursDu(v)))]);
  const ouverts = votes.filter((v) => v.statut === STATUT_VOTE.ouvert && maintenant < v.cloture);
  const autres = votes.filter((v) => !ouverts.includes(v));

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <EnTeteEcran
          titre="Votes en cours"
          brut={ouverts.length}
          detail="Tout membre peut soumettre une question au club. Les voix comptent au prorata des parts (art. 12), et le vote est public."
        />
        <LienBouton href="/votes/nouveau">Proposer un vote</LienBouton>
      </div>

      {ouverts.length === 0 && (
        <Carte>
          <Vide>Aucun vote en cours.</Vide>
        </Carte>
      )}

      {ouverts.map((v) => {
        const i = votes.indexOf(v);
        const liste = listes[i];
        const leurs = bulletins.filter((b) => b.voteId === v.id);
        const r = depouiller(liste, leurs, v.majorite);
        const moi = liste.find((e) => e.membreId === membre.id);
        const mien = leurs.find((b) => b.membreId === membre.id)?.choix ?? null;
        return (
          <Carte key={v.id}>
            <p className="flex items-center gap-2 text-[13px]" style={{ color: "var(--ink-2)" }}>
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: "var(--accent)" }} />
              <span>
                Vote en cours · clôture le {clotureEnClair(v.cloture)}
                <HeureChezVous instant={v.cloture.toISOString()} />, {reste(v.cloture, maintenant)}
              </span>
            </p>
            <h2 className="mt-2 text-[21px] font-semibold leading-snug">
              <Link href={`/votes/${v.id}`}>{v.question}</Link>
            </h2>
            {v.details && <p className="mt-1.5 whitespace-pre-line text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>{v.details}</p>}
            <p className="mt-1.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
              Proposé par {v.auteurNom} le {dateCourte(v.creeLe.toISOString().slice(0, 10))} · {MAJORITES[v.majorite].libelle.toLowerCase()}
              {v.viseNom && ` · concerne ${v.viseNom}, qui ne vote pas`}
            </p>

            <div className="mt-4 rounded-xl border p-3.5" style={{ borderColor: "var(--line-2)" }}>
              {moi && moi.exclu === null ? (
                <>
                  <p className="mb-3 flex items-baseline justify-between gap-3 text-[13px]" style={{ color: "var(--ink-2)" }}>
                    <span>Votre voix, au prorata de votre part</span>
                    <span className="text-[19px] font-medium tabular-nums" style={{ color: "var(--ink)" }}>
                      {pourcent(moi.poids)}
                    </span>
                  </p>
                  <BulletinVote voteId={v.id} actuel={mien} />
                </>
              ) : (
                <p className="text-[14px] leading-relaxed">
                  {moi?.exclu === "vise"
                    ? "Ce vote vous concerne directement : vous ne votez pas."
                    : moi?.exclu === "suspendu"
                      ? "Votre droit de vote est suspendu (R2, plus de 30 jours de retard). Régularisez vos cotisations pour le retrouver avant la clôture."
                      : "Seuls les membres en activité votent."}
                </p>
              )}
            </div>

            <p className="mt-3 text-[13px]" style={{ color: "var(--ink-2)" }}>
              {r.votants} {accorde(r.votants, "votant")} sur {r.admis} · {pourcent(r.base > 0 ? (r.base - r.silence) / r.base : 0)} des voix
              exprimées · pour à ce stade : {pourcent(r.tauxPour)}.{" "}
              <Link href={`/votes/${v.id}`} className="font-medium underline" style={{ color: "var(--accent)" }}>
                Qui a voté quoi
              </Link>
            </p>
          </Carte>
        );
      })}

      <Carte titre={`Votes passés (${autres.length})`}>
        {autres.length === 0 ? (
          <Vide>Aucun vote passé.</Vide>
        ) : (
          <ul>
            {autres.map((v) => {
              const i = votes.indexOf(v);
              const r = depouiller(listes[i], bulletins.filter((b) => b.voteId === v.id), v.majorite);
              const annule = v.statut === STATUT_VOTE.annule;
              const date = (v.closLe ?? v.cloture).toISOString().slice(0, 10);
              return (
                <li key={v.id} className="border-t py-3" style={{ borderColor: "var(--line)" }}>
                  <Link href={`/votes/${v.id}`} className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium">{v.question}</span>
                      <span className="mt-0.5 block text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                        {annule ? "annulé" : `clos le ${dateCourte(date)}`} · {MAJORITES[v.majorite].libelle.toLowerCase()}
                      </span>
                    </span>
                    <span
                      className="flex-none text-[13px] font-semibold"
                      style={{ color: annule ? "var(--ink-2)" : r.adopte ? "var(--etat-paye)" : "var(--etat-manque)" }}
                    >
                      {annule ? "Annulé" : `${r.adopte ? "Adopté" : "Rejeté"}, ${pourcent(r.tauxPour)}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Carte>
    </>
  );
}
