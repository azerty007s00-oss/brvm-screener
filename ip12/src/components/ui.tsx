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
      className={`rounded-xl border p-4 sm:p-5 ${className}`}
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
      className="rounded-xl border p-4"
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
