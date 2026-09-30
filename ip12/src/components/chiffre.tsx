"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { nombre } from "@/lib/settings";

/**
 * Un montant qui monte jusqu'a sa valeur.
 *
 * LE RENDU DU SERVEUR PORTE DEJA LE CHIFFRE JUSTE. C'est la regle qui commande
 * tout le reste : la page doit etre vraie avant que le navigateur execute quoi
 * que ce soit. Sans JavaScript, ou si le script echoue, « 3 857 845 » est la,
 * ecrit. L'animation ne fait que remplacer ce texte pendant six dixiemes de
 * seconde.
 *
 * ELLE ECRIT DANS LE DOM, ET NON DANS UN ETAT REACT. Deux raisons. La premiere
 * est que trente images par seconde sur cinq cellules feraient cent cinquante
 * rendus par seconde d'un bandeau qui n'a pas change : le compteur est un
 * systeme exterieur, qu'un effet pilote, ce pour quoi les effets sont faits.
 * La seconde est qu'un etat remis a zero apres le premier rendu ferait
 * clignoter la valeur finale avant de repartir de zero -- on lirait un chiffre
 * qui se corrige. `useLayoutEffect` s'execute avant que le navigateur peigne :
 * le zero est pose a temps, et personne ne voit le montant deux fois.
 *
 * L'interpolation est cubique sortante : le chiffre part vite et s'installe,
 * plutot que de defiler a vitesse constante comme un compteur kilometrique. A
 * la derniere image on pose exactement le montant recu, sans arrondi
 * intermediaire -- c'est celui-la qu'on lira ensuite pendant des minutes.
 */
/*
 * `useLayoutEffect` n'existe pas au rendu du serveur, et React le dit a chaque
 * page rendue : « useLayoutEffect does nothing on the server ». L'avertissement
 * est juste -- il n'y a rien a mesurer avant peinture quand personne ne peint --
 * et l'effet, ici, n'a de travail que dans le navigateur. On prend donc l'un ou
 * l'autre selon l'endroit ou l'on se trouve, plutot que de laisser un
 * avertissement s'imprimer dix fois par page dans les journaux de production.
 */
const useEffetAvantPeinture = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Chiffre({
  valeur,
  duree = 640,
  retard = 0,
  format = nombre,
}: {
  valeur: number;
  duree?: number;
  /** Le rang du chiffre dans son bandeau : 22 ms le separent du precedent. */
  retard?: number;
  format?: (n: number) => string;
}) {
  const el = useRef<HTMLSpanElement>(null);
  /*
   * On ne roule qu'une fois, a l'arrivee sur la page. Un montant qui repart de
   * zero a chaque re-rendu -- apres la validation d'un versement, par exemple --
   * se lirait comme une remise a zero du compte.
   */
  const dejaRoule = useRef(false);

  useEffetAvantPeinture(() => {
    const noeud = el.current;
    if (!noeud || dejaRoule.current) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    dejaRoule.current = true;

    let image = 0;
    const debut = performance.now() + retard;
    noeud.textContent = format(0);

    const pas = (maintenant: number) => {
      const t = (maintenant - debut) / duree;
      if (t >= 1) {
        noeud.textContent = format(valeur);
        return;
      }
      /* Avant le depart, on attend sans rien ecrire : le zero est deja pose. */
      if (t >= 0) noeud.textContent = format(valeur * (1 - (1 - t) ** 3));
      image = requestAnimationFrame(pas);
    };

    image = requestAnimationFrame(pas);
    return () => cancelAnimationFrame(image);
  }, [valeur, duree, retard, format]);

  return (
    <span ref={el} className="tabular-nums">
      {format(valeur)}
    </span>
  );
}
