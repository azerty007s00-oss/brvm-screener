"use client";

/**
 * Declenche l'impression du navigateur.
 *
 * Rien a telecharger, rien a installer : l'impression du telephone sait produire
 * un PDF, et c'est ce que le club envoie ou archive. Une bibliotheque de PDF
 * cote serveur donnerait un resultat plus rigide pour un poids bien superieur.
 */
export function BoutonImprimer({ libelle = "Imprimer" }: { libelle?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="sans-impression rounded-lg px-3 py-1.5 text-xs font-medium"
      style={{ background: "var(--color-brun-700)", color: "var(--color-brun-100)" }}
    >
      {libelle}
    </button>
  );
}
