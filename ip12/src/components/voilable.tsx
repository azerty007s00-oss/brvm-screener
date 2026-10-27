import type { ReactNode } from "react";

/**
 * Un montant qui se voile en points, comme le solde d'une application de paiement.
 *
 * Le flou se lisait en forçant les yeux : le montant reste ecrit, seulement
 * brouille. Ici, voile, il n'est plus dans ce qu'on voit -- six points prennent
 * sa place, de la meme taille et de la meme encre. Les deux formes sont dans la
 * page ; la feuille de style montre l'une ou l'autre selon le voile (voir
 * components/voile.tsx). Rien a executer : le rendu du serveur suffit, et le
 * script de la tete de page pose le voile avant la premiere peinture.
 */
export function Voilable({ children }: { children: ReactNode }) {
  return (
    <span data-montant="">
      <span className="montant-clair">{children}</span>
      <span className="montant-voile" role="img" aria-label="Montant masqué">
        ••••••
      </span>
    </span>
  );
}
