import type { ReactNode } from "react";

export function Carte({
  titre,
  action,
  children,
  className = "",
}: {
  titre?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`revele relief rounded-xl border p-4 sm:p-5 ${className}`}
      style={{ background: "var(--carte)", borderColor: "var(--bordure)" }}
    >
      {(titre || action) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {titre && <h2 className="text-sm font-semibold tracking-wide uppercase opacity-80">{titre}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Statistique({
  libelle,
  valeur,
  detail,
  accent,
}: {
  libelle: string;
  valeur: ReactNode;
  detail?: ReactNode;
  accent?: "or" | "vert" | "rouge" | "neutre";
}) {
  const couleur =
    accent === "vert"
      ? "var(--color-vert-600)"
      : accent === "rouge"
        ? "var(--color-rouge-600)"
        : accent === "or"
          ? "var(--color-or-600)"
          : "inherit";
  return (
    <div
      className="revele relief rounded-xl border p-4"
      style={{ background: "var(--carte)", borderColor: "var(--bordure)" }}
    >
      <p className="text-xs uppercase tracking-wide" style={{ color: "var(--discret)" }}>
        {libelle}
      </p>
      <p className="mt-1 text-xl font-semibold sm:text-2xl" style={{ color: couleur }}>
        {valeur}
      </p>
      {detail && (
        <p className="mt-1 text-xs" style={{ color: "var(--discret)" }}>
          {detail}
        </p>
      )}
    </div>
  );
}

type Ton = "vert" | "rouge" | "ambre" | "neutre" | "or";

export function Badge({ ton = "neutre", children }: { ton?: Ton; children: ReactNode }) {
  const styles: Record<Ton, { background: string; color: string }> = {
    vert: { background: "var(--color-vert-100)", color: "var(--color-vert-600)" },
    rouge: { background: "var(--color-rouge-100)", color: "var(--color-rouge-600)" },
    ambre: { background: "var(--color-ambre-100)", color: "var(--color-ambre-600)" },
    or: { background: "var(--color-or-200)", color: "var(--color-or-600)" },
    neutre: { background: "var(--color-brun-100)", color: "var(--color-brun-700)" },
  };
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={styles[ton]}
    >
      {children}
    </span>
  );
}

export function Alerte({
  ton = "ambre",
  titre,
  children,
}: {
  ton?: "ambre" | "rouge" | "vert";
  titre?: string;
  children: ReactNode;
}) {
  const fond =
    ton === "rouge" ? "var(--color-rouge-100)" : ton === "vert" ? "var(--color-vert-100)" : "var(--color-ambre-100)";
  const texte =
    ton === "rouge" ? "var(--color-rouge-600)" : ton === "vert" ? "var(--color-vert-600)" : "var(--color-ambre-600)";
  return (
    <div className="rounded-lg p-3 text-sm" style={{ background: fond, color: texte }}>
      {titre && <p className="font-semibold">{titre}</p>}
      <div className={titre ? "mt-1" : ""}>{children}</div>
    </div>
  );
}

export function Vide({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center text-sm" style={{ color: "var(--discret)" }}>
      {children}
    </p>
  );
}

/*
 * Bandeau de titre d'ecran.
 *
 * Il deborde des marges de <main> pour occuper toute la largeur du telephone,
 * prolonge le brun de l'en-tete, et laisse 40 px sous le texte : la carte d'etat
 * qui suit vient s'y poser a cheval.
 */
export function EnTeteEcran({
  titre,
  sous,
  marque,
}: {
  titre: string;
  sous?: ReactNode;
  marque?: ReactNode;
}) {
  return (
    <div
      className="apparait sans-impression -mx-4 -mt-5 rounded-b-[26px] px-5 pt-4 pb-11"
      style={{ background: "var(--color-brun-900)" }}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div>
          <h1
            className="text-base font-semibold tracking-tight"
            style={{ color: "var(--color-brun-50)" }}
          >
            {titre}
          </h1>
          {sous && (
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-brun-300)" }}>
              {sous}
            </p>
          )}
        </div>
        {marque}
      </div>
    </div>
  );
}

/*
 * La carte d'etat : deux ou trois chiffres, rien d'autre. C'est ce qu'on lit en
 * ouvrant la page, avant de decider quoi faire.
 */
export function CarteEtat({
  chiffres,
}: {
  chiffres: { libelle: string; valeur: ReactNode; accent?: "or" | "vert" | "rouge" }[];
}) {
  const teinte = (a?: string) =>
    a === "vert"
      ? "var(--color-vert-600)"
      : a === "rouge"
        ? "var(--color-rouge-600)"
        : a === "or"
          ? "var(--color-or-600)"
          : "inherit";
  return (
    <div
      className="apparait relief-fort -mt-8 grid rounded-2xl border px-1 py-3.5"
      style={{
        background: "var(--carte)",
        borderColor: "var(--bordure)",
        gridTemplateColumns: `repeat(${chiffres.length}, minmax(0, 1fr))`,
        ["--rang" as string]: 1,
      }}
    >
      {chiffres.map((c, i) => (
        <div
          key={c.libelle}
          className="px-1 text-center"
          style={
            i > 0 ? { borderLeft: "1px solid var(--bordure)" } : undefined
          }
        >
          <p
            className="text-[22px] leading-tight font-bold tabular-nums tracking-tight"
            style={{ color: teinte(c.accent) }}
          >
            {c.valeur}
          </p>
          <p className="mt-0.5 text-[10.5px]" style={{ color: "var(--discret)" }}>
            {c.libelle}
          </p>
        </div>
      ))}
    </div>
  );
}

/* Intertitre de section : il decoupe la page en trois intentions. */
export function Rubrique({ children }: { children: ReactNode }) {
  return (
    <h2
      className="revele mt-1 mb-2 text-[11px] font-semibold tracking-[0.1em] uppercase"
      style={{ color: "var(--color-brun-600)" }}
    >
      {children}
    </h2>
  );
}

/*
 * Une tuile : l'icone dit de quoi il s'agit avant la lecture, le resume dit ce
 * que le geste produit, et le contenu ne se deploie qu'a la demande. Rien ne
 * quitte la page, donc rien a recharger.
 */
export function Tuile({
  icone,
  titre,
  resume,
  marque,
  ouvert = false,
  children,
}: {
  icone?: ReactNode;
  titre: ReactNode;
  resume?: ReactNode;
  marque?: ReactNode;
  ouvert?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={ouvert}
      className="revele relief group rounded-2xl border"
      style={{ background: "var(--carte)", borderColor: "var(--bordure)" }}
    >
      <summary className="tapable flex cursor-pointer list-none items-start gap-3 rounded-2xl p-3.5">
        {icone && (
          <span
            className="grid h-[38px] w-[38px] flex-none place-items-center rounded-xl"
            style={{ background: "var(--color-or-200)", color: "var(--color-or-600)" }}
          >
            {icone}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold tracking-tight">{titre}</span>
          {resume && (
            <span className="mt-0.5 block text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
              {resume}
            </span>
          )}
        </span>
        {marque && <span className="flex-none self-center">{marque}</span>}
        <span className="chevron flex-none self-center" style={{ color: "var(--color-brun-300)" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </span>
      </summary>
      <div className="contenu-depliant border-t px-3.5 py-3.5" style={{ borderColor: "var(--bordure)" }}>
        {children}
      </div>
    </details>
  );
}
