"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { styleBouton } from "@/components/boutons";

/**
 * Le formulaire quitte la page.
 *
 * Chaque ecran s'ouvrait sur sa saisie : « Enregistrer un versement » occupait
 * le haut de /versements, « Saisir un releve » coupait /portefeuille en deux.
 * Or on ouvre ces pages dix fois pour lire, une fois pour ecrire -- et le
 * tresorier lui-meme doit faire defiler la saisie pour atteindre les chiffres
 * qu'il vient verifier.
 *
 * La saisie passe donc dans un panneau, lateral sur ordinateur, en feuille sur
 * telephone. Le formulaire, ses champs, leurs noms et son action serveur ne
 * changent pas : seul le contenant change.
 *
 * BATI SUR UN <details>, comme le tiroir qui l'a precede : sans JavaScript, le
 * panneau s'ouvre et se ferme quand meme, et le formulaire reste atteignable --
 * ce qu'un <dialog>, qui exige showModal(), ne permet pas. Le JavaScript
 * n'ajoute que le confort : echappement, clic sur le voile, focus porte au
 * premier champ, defilement du fond bloque.
 */
export function Panneau({
  libelle,
  titre,
  introduction,
  variante = "principal",
  icone,
  children,
}: {
  /** Le bouton qui l'ouvre. */
  libelle: string;
  titre: string;
  introduction?: ReactNode;
  variante?: "principal" | "secondaire";
  icone?: ReactNode;
  children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const corps = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = details.current;
    if (!el) return;

    const fermer = () => el.removeAttribute("open");

    /** Ce qui, dans la feuille, peut recevoir le focus, dans l'ordre du DOM. */
    const atteignables = () =>
      [
        ...el.querySelectorAll<HTMLElement>(
          ".feuille button, .feuille [href], .feuille input:not([type=hidden])," +
            " .feuille select, .feuille textarea, .feuille [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);

    const surTouche = (e: KeyboardEvent) => {
      if (!el.open) return;
      if (e.key === "Escape") {
        fermer();
        el.querySelector("summary")?.focus();
        return;
      }
      /*
       * LE FOCUS NE SORT PAS DE LA FEUILLE.
       *
       * Sept tabulations suffisaient a passer sous le voile, et l'on se
       * retrouvait a remplir la page cachee : les champs y repondaient, mais on
       * ne les voyait pas. Un panneau qui recouvre la page doit retenir le
       * clavier comme il retient la souris -- c'est la meme promesse.
       */
      if (e.key !== "Tab") return;
      const cibles = atteignables();
      if (cibles.length === 0) return;
      const premier = cibles[0];
      const dernier = cibles[cibles.length - 1];
      const ici = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (ici === premier || !ici || !el.contains(ici))) {
        e.preventDefault();
        dernier.focus();
      } else if (!e.shiftKey && ici === dernier) {
        e.preventDefault();
        premier.focus();
      }
    };
    /*
     * Le fond ne defile pas sous un panneau ouvert : sur telephone, un doigt
     * pose a cote de la feuille faisait glisser la page derriere elle, et l'on
     * perdait la ligne qu'on etait venu corriger.
     */
    const surBascule = () => {
      document.body.style.overflow = el.open ? "hidden" : "";
      if (el.open) {
        const premier = corps.current?.querySelector<HTMLElement>(
          "input:not([type=hidden]), select, textarea",
        );
        premier?.focus();
      } else {
        /*
         * A la fermeture, le focus revient au bouton qui a ouvert le panneau --
         * par la croix ou par le voile comme par Echap. Sans cela il retombe
         * sur le <body>, et la tabulation suivante repart du haut de la page.
         */
        el.querySelector("summary")?.focus();
      }
    };

    document.addEventListener("keydown", surTouche);
    el.addEventListener("toggle", surBascule);
    return () => {
      document.removeEventListener("keydown", surTouche);
      el.removeEventListener("toggle", surBascule);
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <details ref={details} className="panneau sans-impression">
      <summary
        className="tapable inline-flex h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-lg px-4 text-[14px] font-medium whitespace-nowrap lg:h-8 lg:px-3.5 lg:text-[13px]"
        style={styleBouton(variante)}
      >
        {icone}
        {libelle}
      </summary>

      {/* Le voile ferme au clic : c'est le geste qu'on tente d'abord. */}
      <span
        className="voile"
        aria-hidden="true"
        onClick={() => details.current?.removeAttribute("open")}
      />

      {/*
        * `aria-modal` va de pair avec le piege a focus ci-dessus : il dit au
        * lecteur d'ecran d'ignorer le reste de la page, ce qui ne serait pas
        * vrai si la tabulation pouvait en sortir.
        */}
      <div className="feuille" role="dialog" aria-modal="true" aria-label={titre}>
        <div
          className="flex h-15 flex-none items-center gap-3 px-5 lg:pr-4 lg:pl-7"
          style={{ borderBottom: "1px solid var(--line)" }}
        >
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold lg:text-[15px]">
            {titre}
          </h2>
          <button
            type="button"
            aria-label="Fermer"
            onClick={() => details.current?.removeAttribute("open")}
            className="tapable grid h-11 w-11 flex-none place-items-center rounded-lg lg:h-9 lg:w-9"
            style={{ color: "var(--ink-2)" }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6 L18 18 M18 6 L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div ref={corps} className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:px-7">
          {introduction && (
            <p className="mb-5 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              {introduction}
            </p>
          )}
          {children}
        </div>
      </div>
    </details>
  );
}
