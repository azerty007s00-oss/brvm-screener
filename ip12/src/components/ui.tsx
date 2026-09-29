import type { ReactNode } from "react";

/**
 * Une section : un titre, et ce qu'il annonce.
 *
 * C'etait une carte -- fond propre, bord arrondi, ombre douce -- et la page
 * finissait en pile de boites posees sur une autre boite. Le nom reste, parce
 * qu'il est appele partout, mais il ne dessine plus de contenant : un filet
 * au-dessus, de l'espace autour, et le titre suffisent a separer deux sujets.
 */
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
      className={`revele border-t pt-5 ${className}`}
      style={{ borderColor: "var(--line)" }}
    >
      {(titre || action) && (
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          {titre && (
            <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
              {titre}
            </h2>
          )}
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
  /*
   * L'accent ne teinte plus le montant.
   *
   * Un chiffre rouge parce qu'il est negatif, un chiffre or parce qu'il est
   * important : a force, la couleur ne signalait plus rien. Le signe dit le
   * sens, le libelle dit l'importance, et le rouge est rendu a ce qui manque.
   * Le parametre reste accepte -- il est passe en vingt endroits -- et ne fait
   * plus rien.
   */
  void accent;
  return (
    <div className="revele border-t pt-4" style={{ borderColor: "var(--line)" }}>
      <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
        {libelle}
      </p>
      <p
        className="mt-1 text-[18px] leading-tight font-medium tabular-nums sm:text-[22px]"
        style={{ color: "var(--ink)", letterSpacing: "-0.015em" }}
      >
        {valeur}
      </p>
      {detail && (
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
          {detail}
        </p>
      )}
    </div>
  );
}

type Ton = "vert" | "rouge" | "ambre" | "neutre" | "or";

export function Badge({ ton = "neutre", children }: { ton?: Ton; children: ReactNode }) {
  const styles: Record<Ton, { background: string; color: string }> = {
    vert: { background: "var(--etat-ok-fond)", color: "var(--etat-ok)" },
    rouge: { background: "var(--etat-manque-fond)", color: "var(--etat-manque)" },
    ambre: { background: "var(--etat-attente-fond)", color: "var(--etat-attente)" },
    or: { background: "var(--sunk)", color: "var(--ink-2)" },
    neutre: { background: "var(--sunk)", color: "var(--line-2)" },
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
    ton === "rouge" ? "var(--etat-manque-fond)" : ton === "vert" ? "var(--etat-ok-fond)" : "var(--etat-attente-fond)";
  const texte =
    ton === "rouge" ? "var(--etat-manque)" : ton === "vert" ? "var(--etat-ok)" : "var(--etat-attente)";
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

/**
 * Le haut d'un ecran : ce qu'il montre, et le chiffre pour lequel on l'ouvre.
 *
 * C'etait un bandeau brun a coins arrondis, avec le montant en or. Deux fautes
 * dans la meme image : l'or, qui ne se lit que sur fond sombre et obligeait
 * donc a peindre le bandeau ; et le bandeau, qui faisait de chaque page une
 * carte posee sur une autre. Ici le chiffre est a l'encre, pose sur la page --
 * il n'a besoin d'aucun decor pour etre le plus gros element de l'ecran.
 */
export function EnTeteEcran({
  titre,
  sous,
  marque,
  chiffre,
  unite,
  detail,
}: {
  titre: string;
  sous?: ReactNode;
  marque?: ReactNode;
  /** Le chiffre que la page existe pour donner, s'il y en a un. */
  chiffre?: ReactNode;
  /** Son unite, posee plus petite et plus claire a cote : « FCFA ». */
  unite?: string;
  detail?: ReactNode;
}) {
  return (
    <div className="apparait">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
            {titre}
            {sous ? <span style={{ color: "var(--ink-3)" }}> {sous}</span> : null}
          </p>
        </div>
        {marque}
      </div>
      {chiffre && (
        <p className="mt-1.5 flex items-baseline whitespace-nowrap">
          <span
            className="text-[44px] leading-none font-medium tabular-nums sm:text-[60px]"
            style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}
          >
            {chiffre}
          </span>
          {unite && (
            <span
              className="ml-2.5 text-[16px] sm:ml-3.5 sm:text-[20px]"
              style={{ color: "var(--ink-3)" }}
            >
              {unite}
            </span>
          )}
        </p>
      )}
      {detail && (
        <p className="mt-2 text-[14px] leading-snug" style={{ color: "var(--ink-2)" }}>
          {detail}
        </p>
      )}
    </div>
  );
}

/**
 * Le bandeau de chiffres cles : ce qu'on lit en ouvrant la page.
 *
 * C'etait une carte posee a cheval sur le bandeau brun. Sans bandeau brun, elle
 * n'a plus a chevaucher quoi que ce soit : deux filets, des cellules separees
 * par un trait, et aucun fond. Le libelle vient sous le chiffre parce que c'est
 * le chiffre qu'on cherche.
 *
 * L'accent n'est plus une couleur. Un montant reste a l'encre : ce qui doit
 * alerter le fait par son signe et par le mot qui l'accompagne, non par une
 * teinte que la moitie des ecrans rend mal.
 */
export function CarteEtat({
  chiffres,
}: {
  chiffres: {
    libelle: string;
    valeur: ReactNode;
    unite?: string;
    contexte?: ReactNode;
    /** Conserve pour les appels existants ; sans effet sur la couleur. */
    accent?: "or" | "vert" | "rouge";
  }[];
}) {
  return (
    <div
      className="apparait grid border-t border-b"
      style={{
        borderColor: "var(--line)",
        gridTemplateColumns: `repeat(${Math.min(chiffres.length, 2)}, minmax(0, 1fr))`,
        ["--rang" as string]: 1,
      }}
    >
      {chiffres.map((c, i) => (
        <div
          key={c.libelle}
          className="flex flex-col gap-1.5 py-4"
          style={{
            paddingLeft: i % 2 === 0 ? 0 : 16,
            paddingRight: i % 2 === 0 ? 14 : 0,
            borderLeft: i % 2 === 0 ? undefined : "1px solid var(--line)",
            borderTop: i > 1 ? "1px solid var(--line)" : undefined,
          }}
        >
          <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {c.libelle}
          </p>
          <p className="flex items-baseline whitespace-nowrap">
            <span
              className="text-[18px] leading-tight font-medium tabular-nums sm:text-[22px]"
              style={{ color: "var(--ink)", letterSpacing: "-0.015em" }}
            >
              {c.valeur}
            </span>
            {c.unite && (
              <span className="ml-1.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                {c.unite}
              </span>
            )}
          </p>
          {c.contexte && (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              {c.contexte}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/* Intertitre de section : il decoupe la page en trois intentions. */
export function Rubrique({ children }: { children: ReactNode }) {
  return (
    <h2
      className="revele mt-5 mb-2 text-[12px] font-medium"
      style={{ color: "var(--ink-3)" }}
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
            style={{ background: "var(--sunk)", color: "var(--ink-2)" }}
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
        <span className="chevron flex-none self-center" style={{ color: "var(--ink-3)" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </span>
      </summary>
      <div className="contenu-depliant border-t px-3.5 py-3.5" style={{ borderColor: "var(--bordure)" }}>
        {children}
      </div>
    </details>
  );
}

/*
 * Un groupe de lignes repliees.
 *
 * Un journal ou dix-huit frais bancaires de quelques centaines de francs noient
 * deux ecritures importantes n'est pas un journal : c'est une liste. Les lignes
 * de meme nature se rassemblent donc sous une ligne de total, ouvrable d'un
 * doigt. Rien n'est masque -- le detail est a un geste, et le total est visible
 * sans le geste.
 *
 * Un groupe d'une seule ligne ne se replie pas : demander d'ouvrir pour trouver
 * ce qu'on voyait deja serait une facon compliquee de cacher.
 */
export function GroupeReplie({
  libelle,
  nombre,
  total,
  detail,
  children,
}: {
  libelle: ReactNode;
  nombre: number;
  total: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}) {
  if (nombre <= 1) return <>{children}</>;
  return (
    <details className="group">
      <summary className="tapable -mx-2 flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-2.5">
        <span
          className="chevron flex-none"
          style={{ color: "var(--ink-3)" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{libelle}</span>
          <span className="block text-xs" style={{ color: "var(--discret)" }}>
            {nombre} lignes{detail ? ` · ${detail}` : ""}
          </span>
        </span>
        <span className="flex-none text-sm font-semibold tabular-nums whitespace-nowrap">{total}</span>
      </summary>
      <div
        className="contenu-depliant ml-2 border-l pl-3"
        style={{ borderColor: "var(--bordure)" }}
      >
        {children}
      </div>
    </details>
  );
}
