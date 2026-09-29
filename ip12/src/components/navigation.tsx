"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icone, type NomIcone } from "@/components/icones";

export type Lien = { href: string; libelle: string; icone: NomIcone };

/**
 * Les initiales, a l'ivoirienne : NOM d'abord, prenoms ensuite. « SORO Tielina
 * Aboudramane » donne « ST », non « SA » -- c'est le prenom d'usage qui compte,
 * et c'est le deuxieme mot.
 */
function initiales(nom: string): string {
  const mots = nom.trim().split(/\s+/);
  if (mots.length === 1) return mots[0].slice(0, 2).toUpperCase();
  return (mots[0][0] + mots[1][0]).toUpperCase();
}

/**
 * Navigation du site, en tiroir.
 *
 * Dix onglets ont d'abord tenu dans une barre qui defilait : on ne voyait pas
 * qu'elle defilait, et l'on cherchait longtemps une page qui etait la. Deux
 * rangees ont corrige cela, mais au prix des libelles de groupe -- sur un ecran
 * de 360 px ils mangeaient la largeur au point de couper « Administration »,
 * c'est-a-dire la page meme qu'on cherchait a rendre trouvable. La hierarchie
 * ne passait donc que par la couleur.
 *
 * Le tiroir leve cette contrainte : la largeur n'est plus disputee, les groupes
 * reprennent leur nom, et le haut des dix ecrans se libere de deux rangees.
 *
 * Il repose sur un <details> : sans JavaScript, le menu s'ouvre et se ferme
 * quand meme, et chaque navigation recharge la page, ce qui le referme. Avec
 * JavaScript, il se ferme au changement de page et a la touche d'echappement.
 */
export function Navigation({
  suivi,
  club,
  membre,
}: {
  suivi: Lien[];
  club: Lien[];
  membre: { nom: string; email: string; role: string };
}) {
  const chemin = usePathname();
  const tiroir = useRef<HTMLDetailsElement>(null);

  /*
   * « Actif » se decide sur le prefixe pour les pages a sous-chemin -- un releve
   * vit sous /releve/<id> --, mais l'accueil exige l'egalite, faute de quoi il
   * serait actif partout.
   */
  const actif = (href: string) => (href === "/" ? chemin === "/" : chemin.startsWith(href));

  /* Changer de page referme le tiroir : le laisser ouvert masquerait l'arrivee. */
  useEffect(() => {
    if (tiroir.current) tiroir.current.open = false;
  }, [chemin]);

  useEffect(() => {
    const surTouche = (e: KeyboardEvent) => {
      if (e.key === "Escape" && tiroir.current?.open) tiroir.current.open = false;
    };
    document.addEventListener("keydown", surTouche);
    return () => document.removeEventListener("keydown", surTouche);
  }, []);

  const fermer = () => {
    if (tiroir.current) tiroir.current.open = false;
  };

  const groupe = (titre: string, liens: Lien[], teinte: string) => (
    <div className="mb-5">
      <p className="mb-1.5 flex items-center gap-2 px-3 text-[10.5px] font-semibold tracking-[0.14em]">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: teinte }}
        />
        <span style={{ color: "var(--discret)" }}>{titre}</span>
      </p>
      <ul>
        {liens.map((l) => {
          const ici = actif(l.href);
          const Dessin = Icone[l.icone];
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                onClick={fermer}
                aria-current={ici ? "page" : undefined}
                className="tapable my-0.5 flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium"
                /*
                  * L'or sur brun marquait deja l'onglet actif dans l'ancienne
                  * barre : la convention est gardee. Elle a l'avantage de tenir
                  * dans les deux themes, ce qu'un brun plein ne fait pas -- en
                  * sombre, le fond des cartes est ce meme brun, et la pastille
                  * s'y effacait entierement.
                  */
                style={
                  ici
                    ? { background: "var(--ink)", color: "var(--page)" }
                    : { color: "var(--texte)" }
                }
              >
                <span
                  className="flex-none"
                  style={{ color: ici ? "var(--page)" : teinte }}
                >
                  <Dessin taille={18} />
                </span>
                {l.libelle}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <details ref={tiroir} className="tiroir sans-impression">
      <summary
        className="tapable flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-xl"
        style={{ color: "var(--sunk)" }}
        aria-label="Ouvrir le menu"
      >
        <span className="bouton-menu">
          <Icone.menu taille={22} />
        </span>
        <span className="bouton-fermer">
          <Icone.croix taille={22} />
        </span>
      </summary>

      {/* Le voile : il assombrit la page et se ferme au doigt. */}
      <button type="button" className="voile" onClick={fermer} tabIndex={-1} aria-hidden />

      <nav
        className="panneau"
        aria-label="Menu principal"
        style={{ background: "var(--carte)" }}
      >
        <div className="px-3 pt-4 pb-5">
          <span className="flex items-center gap-2.5 px-3">
            <span
              className="grid h-9 w-9 flex-none place-items-center rounded-xl text-xs font-bold"
              style={{ background: "var(--ink)", color: "var(--page)" }}
            >
              IP
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">Investment Pioneers</span>
              <span className="block text-[11px]" style={{ color: "var(--discret)" }}>
                Club d&apos;investissement
              </span>
            </span>
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-3">
          {groupe("Mon suivi", suivi, "var(--gold)")}
          {groupe("La vie du club", club, "var(--discret)")}
        </div>

        {/*
          * Qui suis-je, et sous quel titre. L'adresse y figure en clair : c'est
          * a elle que partent les relances, et c'est le seul endroit ou un
          * membre s'apercevra qu'elle est fausse.
          */}
        <div className="border-t px-4 py-3.5" style={{ borderColor: "var(--bordure)" }}>
          <span className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 flex-none place-items-center rounded-full text-xs font-semibold"
              style={{ background: "var(--sunk)", color: "var(--line-2)" }}
            >
              {initiales(membre.nom)}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13px] font-semibold">{membre.nom}</span>
              <span className="block truncate text-[11px]" style={{ color: "var(--discret)" }}>
                {membre.email}
              </span>
              <span
                className="mt-0.5 block text-[10.5px] font-semibold"
                style={{ color: "var(--gold-ink)" }}
              >
                {membre.role}
              </span>
            </span>
          </span>
        </div>
      </nav>
    </details>
  );
}
