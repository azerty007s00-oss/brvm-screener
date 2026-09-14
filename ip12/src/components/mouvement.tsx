"use client";

import { useEffect, useState } from "react";

/*
 * Un chiffre qui monte depuis zero. C'est le seul endroit de l'application ou
 * une animation demande du JavaScript : le compteur CSS ne sait pas inserer
 * l'espace des milliers, et un montant en FCFA sans separateur se lit mal.
 *
 * La valeur finale est rendue des le serveur, donc avant toute hydratation et
 * sans JavaScript : ce qui est anime, c'est le trajet, jamais le resultat. Un
 * navigateur qui n'execute pas le script, ou un systeme regle sur moins
 * d'animation, affiche directement le bon chiffre — et la place qu'il occupe ne
 * change pas, donc rien ne saute autour.
 */
export function Compteur({
  valeur,
  format,
  duree = 900,
}: {
  valeur: number;
  format?: (n: number) => string;
  duree?: number;
}) {
  const [affiche, setAffiche] = useState(valeur);

  useEffect(() => {
    if (valeur === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let image = 0;
    let depart = 0;
    const avance = (maintenant: number) => {
      if (depart === 0) depart = maintenant;
      const t = Math.min(1, (maintenant - depart) / duree);
      /* Sortie en douceur : vif au depart, pose a l'arrivee. */
      setAffiche(Math.round(valeur * (1 - Math.pow(1 - t, 3))));
      if (t < 1) image = requestAnimationFrame(avance);
    };
    image = requestAnimationFrame(avance);
    return () => cancelAnimationFrame(image);
  }, [valeur, duree]);

  return <>{format ? format(affiche) : affiche}</>;
}
