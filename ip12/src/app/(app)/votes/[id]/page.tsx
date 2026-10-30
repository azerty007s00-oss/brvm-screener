import Link from "next/link";
import { notFound } from "next/navigation";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { bulletinsDes, clotureEnClair, electeursDu, voteParId } from "@/lib/votes";
import { MAJORITES, STATUT_VOTE, depouiller, phraseResultat, pourcent } from "@/lib/scrutin";
import { accorde, dateCourte } from "@/lib/settings";
import { annulerVoteAction } from "@/app/actions/votes";
import { Champ, ChampCache, Depliant, FormulaireAction } from "@/components/formulaires";
import { Carte } from "@/components/ui";
import { BulletinVote } from "@/components/bulletin-vote";
import { Barres, Votants } from "@/components/depouillement";
import { HeureChezVous } from "@/components/fuseau";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vote" };

export default async function PageVote({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const membre = await exigerMembre();
  const v = await voteParId(id).catch(() => null);
  if (!v) notFound();

  const maintenant = new Date();
  const [liste, bulletins] = await Promise.all([electeursDu(v), bulletinsDes([v.id])]);
  const r = depouiller(liste, bulletins, v.majorite);
  const annule = v.statut === STATUT_VOTE.annule;
  const ouvert = v.statut === STATUT_VOTE.ouvert && maintenant < v.cloture;
  const clos = !annule && !ouvert;
  const moi = liste.find((e) => e.membreId === membre.id);
  const mien = bulletins.find((b) => b.membreId === membre.id)?.choix ?? null;
  const peutAnnuler = ouvert && (v.auteurId === membre.id || peut(membre, "annulerVote"));
  const discret = { color: "var(--ink-2)" };

  return (
    <>
      <p className="text-[13px]">
        <Link href="/votes" className="underline" style={{ color: "var(--accent)" }}>
          Votes
        </Link>
      </p>

      <section className="flex flex-col gap-2">
        <p className="text-[13px]" style={discret}>
          {annule
            ? `Annulé${v.annulePar ? ` par ${v.annulePar}` : ""}`
            : ouvert
              ? "Vote en cours · clôture le "
              : `Clos le ${dateCourte((v.closLe ?? v.cloture).toISOString().slice(0, 10))} · `}
          {ouvert && (
            <>
              {clotureEnClair(v.cloture)}
              <HeureChezVous instant={v.cloture.toISOString()} />
              {" · "}
            </>
          )}
          {!annule && `majorité requise : ${MAJORITES[v.majorite].regle}`}
        </p>
        <h1 className="text-[23px] font-semibold leading-snug">{v.question}</h1>
        {v.details && <p className="whitespace-pre-line text-[14.5px] leading-relaxed" style={discret}>{v.details}</p>}
        <p className="text-[13px]" style={discret}>
          Proposé par {v.auteurNom} le {dateCourte(v.creeLe.toISOString().slice(0, 10))}
          {v.viseNom && ` · concerne ${v.viseNom}, qui ne vote pas`}
        </p>
        {annule && v.motifAnnulation && (
          <p className="rounded-lg px-3 py-2.5 text-[14px]" style={{ background: "var(--sunk)" }}>
            Motif de l&apos;annulation : {v.motifAnnulation}
          </p>
        )}
        {clos && (
          <div className="mt-2">
            <p className="text-[28px] font-semibold" style={{ color: r.adopte ? "var(--etat-paye)" : "var(--etat-manque)" }}>
              {r.adopte ? "Adopté" : "Rejeté"}
            </p>
            <p className="text-[14.5px] leading-relaxed" style={discret}>
              {phraseResultat(r, v.majorite)}
            </p>
          </div>
        )}
      </section>

      {ouvert && (
        <Carte titre="Votre voix">
          {moi && moi.exclu === null ? (
            <>
              <p className="mb-3 flex items-baseline justify-between gap-3 text-[13px]" style={discret}>
                <span>Au prorata de votre part du club (art. 12)</span>
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
        </Carte>
      )}

      {!annule && (
        <Carte titre={ouvert ? "Où en est le vote" : "Les voix"}>
          <p className="mb-4 text-[13px]" style={discret}>
            {r.votants} {accorde(r.votants, "votant")} sur {r.admis}. Les voix suivent les parts (art. 12) ; une abstention et un silence
            comptent dans le total : il faut {MAJORITES[v.majorite].regle} qui peuvent voter, pas seulement de celles qui se sont prononcées.
          </p>
          <Barres r={r} majorite={v.majorite} />
        </Carte>
      )}

      <Carte titre="Qui a voté quoi">
        <p className="mb-1 text-[12.5px]" style={discret}>
          Le vote est public.{ouvert ? " Chacun peut changer d'avis jusqu'à la clôture." : ""}
        </p>
        <Votants electeurs={liste} bulletins={bulletins} clos={!ouvert} />
      </Carte>

      {peutAnnuler && (
        <div className="sans-impression">
          <Depliant titre="Annuler ce vote">
            <FormulaireAction
              action={annulerVoteAction}
              libelle="Annuler le vote et prévenir tout le monde"
              variante="danger"
              confirmation="Annuler ce vote ? Les bulletins déjà déposés ne compteront pas."
            >
              <ChampCache nom="voteId" valeur={v.id} />
              <Champ nom="motif" libelle="Motif, lu par tous les membres" />
            </FormulaireAction>
          </Depliant>
        </div>
      )}
    </>
  );
}
