"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icone, type NomIcone } from "@/components/icones";
import { seDeconnecter } from "@/app/actions/auth";

export type Page = { href: string; libelle: string; icone: NomIcone };
export type Rubrique = {
  cle: string;
  libelle: string;
  icone: NomIcone;
  pages: Page[];
};

export type Personne = { nom: string; email: string; role: string };

/**
 * La coque : barre laterale sur ordinateur, navigation basse sur telephone.
 *
 * Le site etait une colonne de telephone, centree et large de 1 000 px, quelle
 * que soit la taille de l'ecran -- et le menu restait cache derriere un bouton
 * a 1 440 px, ou la place ne manquait pourtant pas. La meme page sert desormais
 * deux mises en page : une barre laterale permanente des 1 024 px, une
 * navigation basse a cinq entrees en deca.
 *
 * Les dix pages se rangent en cinq rubriques. Deux d'entre elles en contiennent
 * plusieurs : sur telephone, un bandeau d'onglets s'intercale sous l'en-tete ;
 * sur ordinateur, la barre laterale les montre toutes, groupees et nommees --
 * la largeur n'y est disputee par rien.
 */

/** Les initiales, a l'ivoirienne : NOM d'abord, prenoms ensuite. */
function initiales(nom: string): string {
  const mots = nom.trim().split(/\s+/);
  if (mots.length === 1) return mots[0].slice(0, 2).toUpperCase();
  return (mots[0][0] + mots[1][0]).toUpperCase();
}

/**
 * La rubrique dont une page est ouverte.
 *
 * « / » ne se compare qu'a l'identique : sans cela l'accueil serait actif sur
 * toutes les pages du site, son href etant prefixe de tous les autres.
 */
function rubriqueActive(rubriques: Rubrique[], chemin: string): Rubrique | undefined {
  let meilleure: { r: Rubrique; longueur: number } | undefined;
  for (const r of rubriques) {
    for (const p of r.pages) {
      const correspond = p.href === "/" ? chemin === "/" : chemin.startsWith(p.href);
      if (correspond && (!meilleure || p.href.length > meilleure.longueur)) {
        meilleure = { r, longueur: p.href.length };
      }
    }
  }
  return meilleure?.r;
}

function pageActive(rubriques: Rubrique[], chemin: string): Page | undefined {
  const pages = rubriques.flatMap((r) => r.pages);
  return pages
    .filter((p) => (p.href === "/" ? chemin === "/" : chemin.startsWith(p.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

const CHEMIN_MARQUE = (
  <>
    <path
      d="M7 17.5 L11.4 13 L14.4 15.4 L19 9.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="19" cy="9.6" r="1.7" fill="currentColor" />
  </>
);

function Marque({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="grid flex-none place-items-center rounded-[7px]"
        style={{
          background: "var(--brand)",
          color: "var(--brand-mark)",
          width: compact ? 24 : 26,
          height: compact ? 24 : 26,
        }}
      >
        <svg viewBox="0 0 26 26" width="18" height="18" aria-hidden="true">
          {CHEMIN_MARQUE}
        </svg>
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
            IP12
          </span>
          <span className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
            Investment Pioneers
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * La marque sur la colonne bleu nuit.
 *
 * DEUX COMPOSANTS, ET NON UN AVEC UN TERNAIRE. La marque sert a deux endroits
 * desormais opposes -- l'en-tete du telephone sur fond clair, la colonne sur
 * fond bleu nuit -- et les memes encres aux deux places rendaient l'une des
 * deux illisible, c'est-a-dire le nom du club.
 *
 * Un seul composant portant `barre ? A : B` aurait marche, et rendu le controle
 * de contraste aveugle : il ne sait pas quelle branche s'applique, mesure les
 * quatre croisements possibles et signale des couples qui n'existent jamais.
 * Deux composants, un jeu de jetons chacun, tous mesures.
 *
 * Le fond est redeclare ici bien qu'il soit deja celui de l'aside : sans lui, le
 * controle mesurerait ces encres claires contre le fond de la page.
 */
function MarqueBarre() {
  return (
    <span className="flex items-center gap-2.5" style={{ background: "var(--side)" }}>
      <span
        className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px]"
        style={{ background: "var(--side-marque)", color: "var(--side-sur-marque)" }}
      >
        <svg viewBox="0 0 26 26" width="18" height="18" aria-hidden="true">
          {CHEMIN_MARQUE}
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-[14px] font-semibold" style={{ color: "var(--side-ink)" }}>
          IP12
        </span>
        <span className="block text-[12px]" style={{ color: "var(--side-ink-2)" }}>
          Investment Pioneers
        </span>
      </span>
    </span>
  );
}

/* ------------------------------------------------------------- ordinateur */

function BarreLaterale({
  rubriques,
  personne,
  version,
}: {
  rubriques: Rubrique[];
  personne: Personne;
  version: { revision: string | null; titre: string | null };
}) {
  const chemin = usePathname();
  const actif = (href: string) => (href === "/" ? chemin === "/" : chemin.startsWith(href));

  /* Accueil et Versements n'ont qu'une page : ils restent seuls en tete. */
  const seules = rubriques.filter((r) => r.pages.length === 1 && r.cle !== "moi");
  const groupes = rubriques.filter((r) => r.pages.length > 1 && r.cle !== "moi");
  const moi = rubriques.find((r) => r.cle === "moi");
  const administration = moi?.pages.find((p) => p.href === "/administration");

  const lien = (p: Page, icone: NomIcone) => {
    const ici = actif(p.href);
    const I = Icone[icone];
    return (
      <Link
        key={p.href}
        href={p.href}
        aria-current={ici ? "page" : undefined}
        className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px]"
        style={
          ici
            ? {
                background: "var(--side-actif)",
                color: "var(--side-ink)",
                fontWeight: 500,
                boxShadow: "var(--side-raise)",
              }
            : { color: "var(--side-ink-2)" }
        }
      >
        {/*
          * SEULE L'ICONE PREND LA COULEUR, pas le libelle. Le texte courant se
          * distingue deja par son fond, son relief et sa graisse ; le colorer
          * en plus le rendrait moins lisible que les autres, ce qui serait
          * l'inverse du but.
          */}
        <I taille={17} trait={1.5} couleur={ici ? "var(--side-accent)" : undefined} />
        <span className="truncate">{p.libelle}</span>
      </Link>
    );
  };

  return (
    <aside
      className="sans-impression sticky top-0 hidden h-dvh w-[232px] flex-none flex-col px-3 pt-[18px] pb-4 lg:flex"
      style={{ background: "var(--side)", borderRight: "1px solid var(--side-line)" }}
    >
      <Link href="/" className="flex h-10 items-center px-2">
        <MarqueBarre />
      </Link>

      <nav className="mt-[22px] flex flex-col gap-0.5">
        {seules.map((r) => lien(r.pages[0], r.icone))}
        {groupes.map((r) => (
          <div key={r.cle}>
            <p
              className="mt-[18px] mb-1.5 px-2.5 text-[12px] font-medium"
              style={{ color: "var(--side-ink-3)" }}
            >
              {r.libelle}
            </p>
            <div className="flex flex-col gap-0.5">
              {r.pages.map((p) => lien(p, p.icone))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        {administration && (
          <nav className="flex flex-col gap-0.5">{lien(administration, administration.icone)}</nav>
        )}
        <div style={{ borderTop: "1px solid var(--side-line)" }} />
        <div className="flex items-center gap-2.5">
          <Link href="/mon-compte" className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full text-[11.5px] font-semibold"
              style={{
                background: "var(--side-actif)",
                border: "1px solid var(--side-line-2)",
                color: "var(--side-ink-2)",
              }}
            >
              {initiales(personne.nom)}
            </span>
            <span className="min-w-0 leading-tight">
              <span
                className="block truncate text-[13px] font-medium"
                style={{ color: "var(--side-ink)" }}
              >
                {personne.nom}
              </span>
              <span className="block text-[12px]" style={{ color: "var(--side-ink-2)" }}>
                {personne.role}
              </span>
            </span>
          </Link>
          {/*
            * LA SORTIE.
            *
            * La refonte a remplace le tiroir par cette coque, et le seul
            * formulaire de deconnexion du site est parti avec lui : pendant
            * quelques jours, on ne pouvait plus quitter sa session -- sur un
            * telephone prete, ou depuis l'ordinateur d'un cybercafe d'Abidjan,
            * c'est une porte laissee ouverte.
            *
            * Un formulaire, non un lien : la deconnexion change l'etat du
            * serveur, et un lien se fait suivre par un prefetch.
            */}
          <form action={seDeconnecter} className="flex-none">
            <button
              type="submit"
              aria-label="Quitter la session"
              title="Quitter la session"
              className="tapable grid h-9 w-9 place-items-center rounded-lg"
              style={{ color: "var(--side-ink-2)" }}
            >
              <Icone.sortie taille={17} trait={1.5} />
            </button>
          </form>
        </div>
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--side-ink-3)" }}>
          Investment Pioneers &middot; Abidjan
          {version.revision && (
            <>
              <br />
              <span className="font-mono text-[10.5px]" title={version.titre ?? undefined}>
                {version.revision}
              </span>
            </>
          )}
        </p>
      </div>
    </aside>
  );
}

function BarreSuperieure({
  rubriques,
  actions,
}: {
  rubriques: Rubrique[];
  actions?: React.ReactNode;
}) {
  const chemin = usePathname();
  const rubrique = rubriqueActive(rubriques, chemin);
  const page = pageActive(rubriques, chemin);
  const plusieurs = (rubrique?.pages.length ?? 0) > 1;

  return (
    <div
      className="sans-impression sticky top-0 z-10 hidden h-15 items-center gap-3 px-12 lg:flex"
      style={{ background: "var(--page)", borderBottom: "1px solid var(--line)" }}
    >
      <p className="flex min-w-0 items-center gap-2 text-[13px]">
        {plusieurs && rubrique && (
          <>
            <Link href={rubrique.pages[0].href} style={{ color: "var(--ink-2)" }}>
              {rubrique.libelle}
            </Link>
            <span style={{ color: "var(--ink-3)" }}>/</span>
          </>
        )}
        <span className="truncate font-medium" style={{ color: "var(--ink)" }}>
          {page?.libelle ?? rubrique?.libelle}
        </span>
      </p>
      <div className="ml-auto flex items-center gap-3">{actions}</div>
    </div>
  );
}

/* --------------------------------------------------------------- telephone */

function EnTeteTelephone({ rubriques, personne }: { rubriques: Rubrique[]; personne: Personne }) {
  const chemin = usePathname();
  const rubrique = rubriqueActive(rubriques, chemin);

  return (
    <div className="sans-impression flex h-15 items-center gap-3 pt-2 pr-2 pl-5 lg:hidden">
      <Link href="/" aria-label="Accueil">
        <Marque compact />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-[20px] font-semibold" style={{ color: "var(--ink)" }}>
        {rubrique?.libelle ?? "IP12"}
      </h1>
      <Link
        href="/mon-compte"
        aria-label="Mon compte"
        className="grid h-11 w-11 flex-none place-items-center"
      >
        <span
          className="grid h-8 w-8 place-items-center rounded-full text-[11.5px] font-semibold"
          style={{
            background: "var(--sunk)",
            border: "1px solid var(--line-2)",
            color: "var(--ink-2)",
          }}
        >
          {initiales(personne.nom)}
        </span>
      </Link>
    </div>
  );
}

function OngletsRubrique({ rubriques }: { rubriques: Rubrique[] }) {
  const chemin = usePathname();
  const rubrique = rubriqueActive(rubriques, chemin);
  if (!rubrique || rubrique.pages.length < 2) return null;

  return (
    <div
      className="sans-impression defilement-x flex h-11 items-stretch gap-6 px-5 lg:hidden"
      style={{ borderBottom: "1px solid var(--line)" }}
    >
      {rubrique.pages.map((p) => {
        const ici = p.href === "/" ? chemin === "/" : chemin.startsWith(p.href);
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={ici ? "page" : undefined}
            className="relative flex items-center text-[14px] whitespace-nowrap"
            style={{ color: ici ? "var(--ink)" : "var(--ink-2)", fontWeight: ici ? 500 : 400 }}
          >
            {p.libelle}
            {ici && (
              <span
                className="absolute right-0 -bottom-px left-0 h-0.5 rounded-sm"
                style={{ background: "var(--accent)" }}
              />
            )}
          </Link>
        );
      })}
    </div>
  );
}

function NavigationBasse({ rubriques, alerte }: { rubriques: Rubrique[]; alerte: boolean }) {
  const chemin = usePathname();
  const active = rubriqueActive(rubriques, chemin);

  return (
    <nav
      className="sans-impression fixed right-0 bottom-0 left-0 z-20 grid lg:hidden"
      style={{
        background: "var(--page)",
        borderTop: "1px solid var(--line)",
        gridTemplateColumns: `repeat(${rubriques.length}, minmax(0, 1fr))`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {rubriques.map((r) => {
        const ici = active?.cle === r.cle;
        const I = Icone[r.icone];
        return (
          <Link
            key={r.cle}
            href={r.pages[0].href}
            aria-current={ici ? "page" : undefined}
            className="tapable relative flex h-16 flex-col items-center justify-center gap-1"
            style={{ color: ici ? "var(--accent)" : "var(--ink-3)" }}
          >
            {ici && (
              <span
                className="absolute top-0 h-0.5 w-5 rounded-sm"
                style={{ background: "var(--accent)" }}
              />
            )}
            <span className="relative">
              <I taille={22} trait={1.4} />
              {/*
                * Un point, non une pastille chiffree : le compte est sur la
                * page, et un chiffre colle a une icone de 22 px ne se lit pas.
                */}
              {r.cle === "versements" && alerte && (
                <>
                  <span
                    className="absolute -top-px -right-[3px] h-[7px] w-[7px] rounded-full"
                    style={{ background: "var(--ink)", border: "2px solid var(--page)" }}
                  />
                  <span className="sr-only">, des versements demandent votre attention</span>
                </>
              )}
            </span>
            <span className="text-[11px]" style={{ fontWeight: ici ? 600 : 500 }}>
              {r.libelle}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ coque */

export function Coque({
  rubriques,
  personne,
  version,
  alerte = false,
  children,
}: {
  rubriques: Rubrique[];
  personne: Personne;
  version: { revision: string | null; titre: string | null };
  /** Vrai s'il y a quelque chose a traiter sur Versements, pour ce profil. */
  alerte?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <BarreLaterale rubriques={rubriques} personne={personne} version={version} />
      <div className="flex min-w-0 flex-1 flex-col">
        <BarreSuperieure rubriques={rubriques} />
        <EnTeteTelephone rubriques={rubriques} personne={personne} />
        <OngletsRubrique rubriques={rubriques} />
        <main className="w-full max-w-[1112px] flex-1 px-5 pt-5 pb-28 lg:px-12 lg:pt-9 lg:pb-12">
          <div className="flex flex-col gap-7">{children}</div>
        </main>
      </div>
      <NavigationBasse rubriques={rubriques} alerte={alerte} />
    </div>
  );
}
