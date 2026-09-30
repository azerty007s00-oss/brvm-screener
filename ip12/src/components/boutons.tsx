import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Les boutons, en trois formes et aucune couleur.
 *
 * Le site en comptait de toutes les teintes : or plein pour les actions, rose
 * pale pour les suppressions, beige pour le reste, sur chaque ligne de chaque
 * liste. Une page de caisse portait ainsi vingt boutons colores pour vingt
 * ecritures, et le rouge n'y signalait plus rien.
 *
 * Il en reste un principal par ecran, plein bleu nuit ; les autres sont un
 * simple contour. La couleur ne dit plus QUELLE action c'est -- le mot s'en
 * charge -- mais laquelle compte sur cet ecran, ce que la place seule disait
 * mal. Le bleu est celui de la marque, le meme que la tuile du logo : c'est le
 * club qui demande, pas une alerte.
 */

type Variante = "principal" | "secondaire";

const base =
  "tapable inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition disabled:opacity-60";

/** Ordinateur 32 px, doigt 44 : la meme commande, deux tailles de cible. */
const mesures = "h-11 px-4 text-[14px] lg:h-8 lg:px-3.5 lg:text-[13px]";

export function styleBouton(variante: Variante = "principal") {
  return variante === "principal"
    ? { background: "var(--accent)", color: "var(--sur-accent)" }
    : { background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" };
}

export function Bouton({
  variante = "principal",
  type = "button",
  children,
  ...reste
}: {
  variante?: Variante;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={`${base} ${mesures}`} style={styleBouton(variante)} {...reste}>
      {children}
    </button>
  );
}

export function LienBouton({
  href,
  variante = "principal",
  children,
}: {
  href: string;
  variante?: Variante;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`${base} ${mesures}`} style={styleBouton(variante)}>
      {children}
    </Link>
  );
}

/**
 * Le bouton d'icone : une cible, un dessin, et un nom pour qui ne le voit pas.
 *
 * L'etiquette n'est pas facultative -- un bouton sans texte visible est muet
 * pour un lecteur d'ecran, et c'est souvent celui qui supprime.
 */
export function BoutonIcone({
  etiquette,
  children,
  ...reste
}: {
  etiquette: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={etiquette}
      className="tapable grid h-11 w-11 flex-none place-items-center rounded-lg lg:h-8 lg:w-8 lg:rounded-md"
      style={{ color: "var(--ink-2)" }}
      {...reste}
    >
      {children}
    </button>
  );
}

/** Un lien d'action : du texte et une fleche, sans cadre. */
export function LienAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-12 items-center gap-1.5 text-[13px] lg:h-auto"
      style={{ color: "var(--ink-2)" }}
    >
      {children} <span aria-hidden="true">&rarr;</span>
    </Link>
  );
}
