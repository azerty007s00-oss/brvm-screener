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
      className="tapable sans-impression inline-flex h-11 items-center rounded-lg px-3.5 text-[14px] font-medium lg:h-8 lg:text-[13px]"
      style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
    >
      {libelle}
    </button>
  );
}
