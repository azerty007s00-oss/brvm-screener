/**
 * L'ecran d'attente, entre le toucher d'un lien et la page.
 *
 * Sans lui, un membre qui touchait « Versements » sur un reseau mobile lent
 * voyait l'ancienne page rester en place une a deux secondes, sans signe que
 * le toucher avait ete pris : il touchait une deuxieme fois, ou croyait le site
 * en panne. Next le precharge avec chaque lien du menu ; il s'affiche donc a
 * l'instant, et la page le remplace des qu'elle arrive.
 *
 * Il reprend la silhouette d'une page -- le titre, le grand chiffre, le bandeau
 * de chiffres, quelques lignes -- pour que rien ne saute a l'arrivee.
 */
export default function Chargement() {
  return (
    <div data-squelette className="squelette flex flex-col gap-7" role="status" aria-label="Chargement de la page">
      <div>
        <span className="block h-3.5 w-32 rounded" />
        <span className="mt-3 block h-10 w-56 rounded-md sm:h-14 sm:w-72" />
        <span className="mt-3 block h-3.5 w-64 max-w-full rounded" />
      </div>
      <div className="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4" style={{ borderColor: "var(--line)" }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={i > 1 ? "hidden sm:block" : undefined}>
            <span className="block h-6 w-24 rounded" />
            <span className="mt-2 block h-3 w-20 rounded" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="block h-12 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
