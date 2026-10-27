"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Icone } from "@/components/icones";
import { CLE_VOILE } from "@/lib/voile";

/**
 * LE VOILE DES MONTANTS.
 *
 * Un membre montre son telephone en reunion, ou ouvre le site dans un taxi :
 * la valeur du club, sa part et les versements de chacun s'affichent en grand.
 * Comme dans les applications bancaires, un oeil les voile, et le choix reste
 * sur l'appareil -- c'est une preference de l'ecran, non du compte.
 *
 * Deux mecanismes, parce que les montants vivent sous deux formes. Les chiffres
 * poses comme tels (heros, tuiles, bandeaux) portent `data-montant` : une
 * feuille de style les floute. Ceux qui courent dans une phrase -- « il manque
 * 2 500 FCFA » -- sont reperes dans le texte et surlignes par l'API CSS Custom
 * Highlight, sans toucher au DOM : React garde la main sur ses noeuds, et rien
 * ne se casse au rendu suivant. Un navigateur sans cette API voile les
 * chiffres, mais laisse lire les phrases.
 */

const EVENEMENT = "ip12-voile";

function voileActif(): boolean {
  return document.documentElement.classList.contains("voile");
}

function abonner(rappel: () => void): () => void {
  window.addEventListener(EVENEMENT, rappel);
  return () => window.removeEventListener(EVENEMENT, rappel);
}

/** Le meme etat, lu par le bouton et par le surligneur. */
function useVoile(): boolean {
  return useSyncExternalStore(abonner, voileActif, () => false);
}

export function basculerVoile(): void {
  const actif = !voileActif();
  document.documentElement.classList.toggle("voile", actif);
  try {
    localStorage.setItem(CLE_VOILE, actif ? "1" : "0");
  } catch {
    // Navigation privee : le voile vaut pour cette page, sans etre retenu.
  }
  window.dispatchEvent(new Event(EVENEMENT));
}

export function BoutonVoile({ encre = "var(--ink-2)", taille = 20 }: { encre?: string; taille?: number }) {
  const actif = useVoile();
  const I = actif ? Icone.oeilBarre : Icone.oeil;
  const libelle = actif ? "Afficher les montants" : "Masquer les montants";
  return (
    <button
      type="button"
      onClick={basculerVoile}
      aria-pressed={actif}
      aria-label={libelle}
      title={libelle}
      className="tapable grid h-11 w-11 flex-none place-items-center rounded-lg lg:h-9 lg:w-9"
      style={{ color: encre }}
    >
      <I taille={taille} trait={1.6} />
    </button>
  );
}

/*
 * Un montant dans le texte : des chiffres groupes par milliers, une virgule
 * eventuelle, puis « FCFA ». Le signe qui le precede est pris avec lui.
 */
const MONTANT = /[+−-]?\s?\d{1,3}(?:[\s  .]\d{3})*(?:,\d+)?[\s  ]?FCFA/g;

function surligner(): void {
  const registre = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Surlignage = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!registre || !Surlignage) return;

  const plages: Range[] = [];
  const parcours = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = parcours.nextNode(); n; n = parcours.nextNode()) {
    const texte = n.nodeValue ?? "";
    if (!texte.includes("FCFA")) continue;
    // Deja floute en entier par la feuille de style : inutile de le surligner.
    if (n.parentElement?.closest("[data-montant], script, style")) continue;
    for (const m of texte.matchAll(MONTANT)) {
      const plage = document.createRange();
      plage.setStart(n, m.index ?? 0);
      plage.setEnd(n, (m.index ?? 0) + m[0].length);
      plages.push(plage);
    }
  }
  registre.set("montant", new Surlignage(...plages));
}

function effacer(): void {
  (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete("montant");
}

/** Monte une fois dans la coque : suit le voile, et le texte qui change sous lui. */
export function SurligneurMontants() {
  const actif = useVoile();

  useEffect(() => {
    if (!actif) {
      effacer();
      return;
    }
    surligner();
    /*
     * Le texte change sans recharger la page : une navigation, un formulaire
     * envoye, un chiffre qui monte jusqu'a sa valeur. On resurligne apres coup,
     * une fois l'agitation retombee, plutot qu'a chaque caractere.
     */
    let attente: number | undefined;
    const observateur = new MutationObserver(() => {
      window.clearTimeout(attente);
      attente = window.setTimeout(surligner, 120);
    });
    observateur.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observateur.disconnect();
      window.clearTimeout(attente);
    };
  }, [actif]);

  return null;
}
