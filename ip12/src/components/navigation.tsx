"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type Lien = { href: string; libelle: string };

/**
 * Navigation du site, en deux rangees.
 *
 * Dix onglets dans une seule barre qui defile : on ne voyait pas qu'elle
 * defilait, et l'on cherchait longtemps une page qui etait la -- le president
 * lui-meme n'a pas trouve l'administration.
 *
 * La premiere rangee porte ce qu'on ouvre chaque mois, et l'administration pour
 * qui l'exerce : elle tient sans defiler sur un ecran de 360 px, ce qui etait
 * tout l'objet. La seconde porte la vie du club, en teinte secondaire et ouverte
 * a tous : les comptes sont transparents (art. 12), rien n'y est cache.
 *
 * Et la page courante se marque, ce qui manquait : on ignorait ou l'on etait.
 */
export function Navigation({ suivi, club }: { suivi: Lien[]; club: Lien[] }) {
  const chemin = usePathname();

  /*
   * « Actif » se decide sur le prefixe pour les pages a sous-chemin -- un releve
   * vit sous /releve/<id> --, mais l'accueil exige l'egalite, faute de quoi il
   * serait actif partout.
   */
  const actif = (href: string) => (href === "/" ? chemin === "/" : chemin.startsWith(href));

  /*
   * Les libelles de groupe ont ete essayes puis retires : sur un ecran de 360 px
   * ils mangeaient la largeur au point de couper « Administration », c'est-a-dire
   * la page meme qu'on cherchait a rendre trouvable. La hierarchie passe donc par
   * la couleur, non par des mots.
   */
  const rangee = (liens: Lien[], secondaire: boolean) => (
    <div className="relative">
      <ul className="defilement-x flex gap-0.5 whitespace-nowrap">
        {liens.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={actif(l.href) ? "page" : undefined}
              className="block rounded-lg px-2 py-1.5 text-xs font-medium transition"
              style={
                actif(l.href)
                  ? { background: "var(--color-or-500)", color: "var(--color-brun-900)" }
                  : { color: secondaire ? "var(--color-brun-300)" : "var(--color-brun-100)" }
              }
            >
              {l.libelle}
            </Link>
          </li>
        ))}
      </ul>
      {/* Le degrade dit qu'il reste des onglets a droite : sans lui, on ignore que la rangee defile. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-7"
        style={{ background: "linear-gradient(to right, transparent, var(--color-brun-900))" }}
      />
    </div>
  );

  return (
    <nav className="mx-auto max-w-5xl space-y-1 px-4 pb-2">
      {rangee(suivi, false)}
      {rangee(club, true)}
    </nav>
  );
}
