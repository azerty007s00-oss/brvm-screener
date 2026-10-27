import type { ReactNode } from "react";

/**
 * Un montant qui se voile en points, comme le solde d'une application de paiement.
 *
 * Le flou se lisait en forçant les yeux : le montant restait ecrit, seulement
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

/*
 * Un montant tel que `fcfa()` l'ecrit : des chiffres groupes par milliers, une
 * virgule eventuelle, puis « FCFA ». Le signe qui le precede est pris avec lui.
 */
const MONTANT = /([+−-]?\d{1,3}(?:[\s  .]\d{3})*(?:,\d+)?)([\s  ]?FCFA)/g;

/**
 * Une phrase dont les montants se voilent comme les chiffres : les memes points.
 *
 * Les montants pris dans une phrase -- « il manque 2 500 FCFA avant le 10 » --
 * etaient couverts apres coup par le navigateur, au moyen d'une API que tous
 * les telephones ne rendent pas de la meme facon : gris ici, visibles la, et
 * parfois poses sur le nom d'a cote. La phrase est maintenant decoupee au
 * rendu, et chaque montant passe par `Voilable` : le meme dessin sur tous les
 * appareils, sans rien a rattraper ensuite. « FCFA » reste lisible, comme a
 * cote d'un grand chiffre voile.
 */
export function avecMontants(texte: ReactNode): ReactNode {
  if (typeof texte !== "string" || !texte.includes("FCFA")) return texte;
  const morceaux: ReactNode[] = [];
  let suite = 0;
  for (const m of texte.matchAll(MONTANT)) {
    const debut = m.index ?? 0;
    if (debut > suite) morceaux.push(texte.slice(suite, debut));
    morceaux.push(<Voilable key={debut}>{m[1]}</Voilable>, m[2]);
    suite = debut + m[0].length;
  }
  if (suite < texte.length) morceaux.push(texte.slice(suite));
  return <>{morceaux}</>;
}
