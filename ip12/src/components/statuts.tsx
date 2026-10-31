"use client";

import { useEffect, useState } from "react";
import { correspond } from "@/lib/statuts";

export type ArticleAffiche = {
  numero: number;
  titre: string;
  texte: string;
  note: string | null;
  resolutions: { code: string; titre: string; aConfirmer: boolean }[];
};
export type ChapitreAffiche = { nom: string; articles: ArticleAffiche[] };

/**
 * Le sommaire des statuts : un article par ligne, ouvert d'un toucher sur son
 * texte exact. La recherche filtre sans accents ni casse ; un numero seul
 * (« 9 ») va droit a l'article. Un lien /statuts#art-9 l'ouvre directement.
 */
export function ListeStatuts({ chapitres }: { chapitres: ChapitreAffiche[] }) {
  const [recherche, setRecherche] = useState("");

  useEffect(() => {
    const ouvrir = () => {
      const cible = window.location.hash.slice(1);
      if (!cible.startsWith("art-")) return;
      const el = document.getElementById(cible);
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView({ block: "start" });
      }
    };
    ouvrir();
    window.addEventListener("hashchange", ouvrir);
    return () => window.removeEventListener("hashchange", ouvrir);
  }, []);

  const filtres = chapitres
    .map((c) => ({ ...c, articles: c.articles.filter((a) => correspond(a, recherche)) }))
    .filter((c) => c.articles.length > 0);
  const nb = filtres.reduce((t, c) => t + c.articles.length, 0);

  return (
    <div className="flex flex-col gap-5">
      <label className="flex h-11 items-center gap-2 rounded-[10px] border px-3" style={{ borderColor: "var(--line-2)", background: "var(--page)" }}>
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15 L20 20" />
        </svg>
        <span className="sr-only">Chercher dans les statuts</span>
        <input
          type="search"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          placeholder="Chercher : pénalité, sortie, vote…"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none lg:text-[14px]"
          style={{ color: "var(--ink)" }}
        />
      </label>
      {recherche.trim() && (
        <p className="-mt-3 text-[13px]" role="status" style={{ color: "var(--ink-3)" }}>
          {nb === 0 ? "Aucun article ne parle de cela." : `${nb} article${nb > 1 ? "s" : ""}`}
        </p>
      )}

      {filtres.map((c) => (
        <section key={c.nom}>
          <h3 className="mb-1.5 text-[12px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--ink-2)" }}>
            {c.nom} · art. {c.articles[0].numero}
            {c.articles.length > 1 ? ` à ${c.articles.at(-1)!.numero}` : ""}
          </h3>
          <ul>
            {c.articles.map((a) => (
              <li key={a.numero} style={{ borderTop: "1px solid var(--line)" }}>
                <details id={`art-${a.numero}`} className="group scroll-mt-20" open={recherche.trim().length > 2 || undefined}>
                  <summary className="tapable flex min-h-12 cursor-pointer list-none items-center gap-3 py-2.5 text-[14px]">
                    <b className="w-[52px] flex-none" style={{ color: "var(--accent)" }}>
                      Art. {a.numero}
                    </b>
                    <span className="min-w-0 flex-1 group-open:font-semibold">{a.titre}</span>
                    {a.resolutions.length > 0 && (
                      <span className="flex-none text-[12px] font-semibold" style={{ color: "var(--gold-ink)" }}>
                        {a.resolutions.map((r) => r.code).join(", ")}
                      </span>
                    )}
                  </summary>
                  <div className="pb-4 pl-[64px]">
                    <p className="text-[14px] leading-[1.55] whitespace-pre-line">{a.texte}</p>
                    {a.note && (
                      <p className="mt-2 text-[12.5px] leading-snug" style={{ color: "var(--ink-3)" }}>
                        Note : {a.note} Le texte signé sera corrigé.
                      </p>
                    )}
                    {a.resolutions.length > 0 && (
                      <div className="mt-2.5 rounded-lg px-3 py-2.5" style={{ background: "var(--sunk)" }}>
                        <p className="mb-1.5 text-[12.5px] font-semibold">Précisé par</p>
                        <p className="flex flex-wrap gap-1.5">
                          {a.resolutions.map((r) => (
                            <a
                              key={r.code}
                              href={`/statuts/resolutions#${r.code}`}
                              className="rounded-full border px-2.5 py-1 text-[12.5px] no-underline"
                              style={{ background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" }}
                            >
                              <b>{r.code}</b> {r.titre}
                              {r.aConfirmer ? " (à confirmer)" : ""}
                            </a>
                          ))}
                        </p>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
