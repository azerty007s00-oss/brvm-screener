import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { LIBELLE_STATUT, STATUT_RESOLUTION, type Resolution, type StatutResolution } from "@/lib/statuts";
import { listerResolutions } from "@/lib/statuts-base";
import { bulletinsDes, electeursDu, listerVotes } from "@/lib/votes";
import { STATUT_VOTE, depouiller, pourcent } from "@/lib/scrutin";
import { importerResolutions, inscrireResolution, retirerResolution } from "@/app/actions/statuts";
import { dateCourte } from "@/lib/settings";
import { Champ, ChampCache, FormulaireAction, Selection } from "@/components/formulaires";
import { Panneau } from "@/components/panneau";
import { MenuLigne } from "@/components/menu-ligne";
import { EnTeteEcran, Vide } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Résolutions" };

const FILTRES: { cle: StatutResolution | null; libelle: string }[] = [
  { cle: null, libelle: "Toutes" },
  { cle: STATUT_RESOLUTION.adoptee, libelle: "Adoptées" },
  { cle: STATUT_RESOLUTION.aConfirmer, libelle: "À confirmer" },
];

const TONS: Record<StatutResolution, { fond: string; encre: string }> = {
  adoptee: { fond: "var(--etat-ok-fond)", encre: "var(--etat-ok)" },
  a_confirmer: { fond: "var(--etat-attente-fond)", encre: "var(--etat-attente)" },
  remplacee: { fond: "var(--sunk)", encre: "var(--ink-2)" },
};

/** Les mois, pour regrouper : « Juillet 2026 ». */
function moisDe(iso: string): string {
  const t = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export default async function PageResolutions({ searchParams }: { searchParams: Promise<{ statut?: string }> }) {
  const membre = await exigerMembre();
  const peutGerer = peut(membre, "gererStatuts");
  const { statut } = await searchParams;
  const filtre = FILTRES.find((f) => f.cle !== null && f.cle === statut)?.cle ?? null;

  const [resolutions, votes] = await Promise.all([listerResolutions(), listerVotes().catch(() => [])]);
  const maintenant = new Date();
  const clos = votes.filter((v) => v.statut !== STATUT_VOTE.annule && (v.statut !== STATUT_VOTE.ouvert || v.cloture <= maintenant));
  const [bulletins, listes] = await Promise.all([bulletinsDes(clos.map((v) => v.id)), Promise.all(clos.map((v) => electeursDu(v)))]);
  const votesDuSite = clos.map((v, i) => ({ v, r: depouiller(listes[i], bulletins.filter((b) => b.voteId === v.id), v.majorite) }));

  const choisies = filtre ? resolutions.filter((r) => r.statut === filtre) : resolutions;
  const groupes: { mois: string; liste: Resolution[] }[] = [];
  for (const r of choisies) {
    const mois = moisDe(r.decideeLe);
    const g = groupes.at(-1);
    if (g && g.mois === mois) g.liste.push(r);
    else groupes.push({ mois, liste: [r] });
  }

  return (
    <>
      <EnTeteEcran
        titre="Les résolutions"
        detail="Ce que le club a décidé depuis les statuts, de la plus récente à la plus ancienne. Chacune renvoie à l'article qu'elle précise."
      />
      <p className="-mt-2 mb-5">
        <Link href="/statuts" className="text-[13px] font-medium">
          ‹ Retour aux statuts
        </Link>
      </p>

      {resolutions.length > 0 && (
        <nav aria-label="Filtrer" className="mb-5 flex flex-wrap gap-2">
          {FILTRES.map((f) => {
            const nb = f.cle ? resolutions.filter((r) => r.statut === f.cle).length : resolutions.length;
            const ici = filtre === f.cle;
            return (
              <Link
                key={f.libelle}
                href={f.cle ? `/statuts/resolutions?statut=${f.cle}` : "/statuts/resolutions"}
                scroll={false}
                aria-current={ici ? "true" : undefined}
                className="tapable inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-semibold no-underline"
                style={
                  ici
                    ? { background: "var(--ink)", color: "var(--page)", borderColor: "var(--ink)" }
                    : { color: "var(--ink-2)", borderColor: "var(--line-2)" }
                }
              >
                {f.libelle} · {nb}
              </Link>
            );
          })}
        </nav>
      )}

      {resolutions.length === 0 ? (
        <Vide>
          Aucune résolution inscrite. {peutGerer ? "Inscrivez-les une à une, ou importez un fichier de résolutions, ci-dessous." : ""}
        </Vide>
      ) : (
        <div className="flex flex-col gap-6">
          {groupes.map((g) => (
            <section key={g.mois}>
              <h3 className="mb-1 text-[12px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--ink-2)" }}>
                {g.mois}
              </h3>
              <ul>
                {g.liste.map((r) => (
                  <li key={r.code} id={r.code} className="scroll-mt-20 py-3" style={{ borderTop: "1px solid var(--line)" }}>
                    <div className="flex items-start gap-2">
                      <b className="w-8 flex-none pt-0.5 text-[14px]" style={{ color: "var(--accent)" }}>
                        {r.code}
                      </b>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-[14.5px] font-semibold">{r.titre}</span>
                          <span
                            className="rounded-full px-2 py-0.5 text-[12px] font-semibold"
                            style={{ background: TONS[r.statut].fond, color: TONS[r.statut].encre }}
                          >
                            {LIBELLE_STATUT[r.statut]}
                          </span>
                        </p>
                        {r.detail && (
                          <p className="mt-1 text-[13.5px] leading-snug" style={{ color: "var(--ink-2)" }}>
                            {r.detail}
                          </p>
                        )}
                        <p className="mt-1 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                          {r.quand}
                          {r.vote ? ` · ${r.vote}` : ""}
                          {r.articles.map((n, i) => (
                            <span key={n}>
                              {i === 0 ? " · " : ", "}
                              <Link href={`/statuts#art-${n}`}>art. {n}</Link>
                            </span>
                          ))}
                        </p>
                        {r.precision && (
                          <p
                            className="mt-2 rounded-lg px-2.5 py-2 text-[12.5px] leading-snug"
                            style={{ background: TONS[r.statut].fond, color: "var(--ink)" }}
                          >
                            {r.precision}
                          </p>
                        )}
                        {r.statut === STATUT_RESOLUTION.aConfirmer && (
                          <p className="mt-2">
                            <Link
                              href={`/votes/nouveau?question=${encodeURIComponent(`Confirmer la résolution ${r.code} : ${r.titre}`)}`}
                              className="tapable inline-flex min-h-9 items-center rounded-lg px-3 text-[13px] font-semibold no-underline"
                              style={{ background: "var(--ink)", color: "var(--page)" }}
                            >
                              Proposer un vote de confirmation
                            </Link>
                          </p>
                        )}
                      </div>
                      {peutGerer && (
                        <MenuLigne
                          etiquette={`Actions sur la résolution ${r.code}`}
                          actions={[
                            {
                              libelle: "Retirer cette résolution",
                              action: retirerResolution,
                              champs: <ChampCache nom="code" valeur={r.code} />,
                              confirmation: `Retirer la résolution ${r.code} de la liste ?`,
                              confirmer: "Retirer",
                            },
                          ]}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {votesDuSite.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-1 text-[12px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--ink-2)" }}>
            Votes sur le site
          </h3>
          <ul>
            {votesDuSite.map(({ v, r }) => (
              <li key={v.id} className="py-3" style={{ borderTop: "1px solid var(--line)" }}>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={`/votes/${v.id}`} className="text-[14.5px] font-semibold">
                    {v.question}
                  </Link>
                  <span
                    className="rounded-full px-2 py-0.5 text-[12px] font-semibold"
                    style={r.adopte ? { background: TONS.adoptee.fond, color: TONS.adoptee.encre } : { background: "var(--sunk)", color: "var(--ink-2)" }}
                  >
                    {r.adopte ? "Adopté" : "Rejeté"}
                  </span>
                </p>
                <p className="mt-1 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                  Clos le {dateCourte((v.closLe ?? v.cloture).toISOString().slice(0, 10))} · pour {pourcent(r.base > 0 ? r.pour / r.base : 0)} ·{" "}
                  <a href={`/votes/${v.id}/pv`} target="_blank" rel="noopener">
                    procès-verbal
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {peutGerer && (
        <section className="mt-8 flex flex-col gap-2">
          <Panneau libelle="Inscrire une résolution" titre="Inscrire une résolution" variante="secondaire">
            <FormulaireAction action={inscrireResolution} libelle="Inscrire">
              <Champ nom="code" libelle="Code" aide="Une lettre et un numéro : S9, R6. Un code déjà inscrit est remplacé." />
              <Champ nom="date" libelle="Date de la décision" type="date" valeur={new Date().toISOString().slice(0, 10)} />
              <Champ nom="titre" libelle="Titre" />
              <Champ nom="detail" libelle="Ce qui est décidé" requis={false} />
              <Champ nom="vote" libelle="Vote" requis={false} aide="Par exemple : Pour 7 · Contre 0 · Abstention 1." />
              <Champ nom="articles" libelle="Articles concernés" requis={false} aide="Les numéros, séparés par des virgules : 9, 20." />
              <Selection
                nom="statut"
                libelle="Statut"
                options={[
                  { valeur: STATUT_RESOLUTION.adoptee, libelle: "Adoptée" },
                  { valeur: STATUT_RESOLUTION.aConfirmer, libelle: "À confirmer" },
                  { valeur: STATUT_RESOLUTION.remplacee, libelle: "Remplacée" },
                ]}
              />
              <Champ nom="precision" libelle="Précision (facultatif)" requis={false} />
            </FormulaireAction>
          </Panneau>
          <Panneau libelle="Importer un fichier de résolutions" titre="Importer un fichier de résolutions" variante="secondaire">
            <FormulaireAction action={importerResolutions} libelle="Importer">
              <Champ
                nom="recensement"
                libelle="Fichier Markdown (.md)"
                type="file"
                accept=".md,text/markdown,text/plain"
                aide="Un tableau dont chaque ligne commence par un code (S9, R4), puis la date, la résolution, le vote, les articles et le statut. Un code déjà inscrit est remplacé."
              />
            </FormulaireAction>
          </Panneau>
        </section>
      )}
    </>
  );
}
