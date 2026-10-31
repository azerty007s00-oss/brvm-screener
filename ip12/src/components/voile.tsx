"use client";

import { useSyncExternalStore } from "react";
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
 * Un seul mecanisme, le meme sur tous les appareils : chaque montant passe par
 * `Voilable` (les chiffres) ou `avecMontants` (les phrases), et six points
 * prennent sa place. Une premiere version couvrait les montants des phrases
 * apres coup, par l'API CSS Custom Highlight : gris sur un telephone, visibles
 * sur un autre, et parfois poses sur le nom d'a cote. Le decoupage au rendu ne
 * depend d'aucun navigateur.
 *
 * L'oeil se pose a cote du montant principal de la page (voir `EnTeteEcran`),
 * comme a cote d'un solde : on le trouve la ou l'on regarde.
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

/**
 * Le voile vaut aussi pour les alertes du telephone : un montant sur l'ecran
 * verrouille se lit par-dessus l'epaule aussi bien que sur le site. Le service
 * qui recoit les alertes (public/sw.js) ne voit pas `localStorage` ; il lit
 * cette copie, rangee la ou il a acces.
 */
export async function ecrireVoileAlertes(): Promise<void> {
  try {
    if (!("caches" in window)) return;
    const reserve = await caches.open("ip12-preferences");
    await reserve.put("/__voile", new Response(voileActif() ? "1" : "0"));
  } catch {
    // Sans cette copie, l'alerte montre le montant : le defaut d'avant le voile.
  }
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
  void ecrireVoileAlertes();
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
