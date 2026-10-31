"use client";

import { useActionState, useState } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";

type Action = (etat: EtatFormulaire, donnees: FormData) => Promise<EtatFormulaire>;

const ETAT_INITIAL: EtatFormulaire = { ok: false };

const principal = { background: "var(--accent)", color: "var(--sur-accent)" };
const secondaire = { background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" };
const bouton =
  "tapable inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg text-[14px] font-medium transition disabled:opacity-60";

/**
 * Valider ou rejeter, cote a cote : la decision d'une ligne de la boite « A valider ».
 *
 * Les deux gestes n'ont pas le meme poids. Valider se fait d'un toucher : le
 * tresorier a le reçu sous les yeux, et c'est le geste de tous les jours.
 * Rejeter demande un motif, qui part chez le membre : le champ ne parait qu'au
 * moment de rejeter, ou l'on sait quoi y ecrire, et non a demeure sur chaque
 * ligne d'une page qu'on ouvre pour valider.
 */
export function Decision({
  valider,
  rejeter,
  champs,
  motifAuMembre = true,
}: {
  valider: Action;
  rejeter: Action;
  /** Ce qui designe la ligne : `lot` ou `id`, selon l'action. */
  champs: Record<string, string>;
  /** Le motif part chez le membre : le dire avant qu'il l'ecrive. Faux pour la caisse. */
  motifAuMembre?: boolean;
}) {
  const [etatValide, envoyerValide, valideEnCours] = useActionState(valider, ETAT_INITIAL);
  const [etatRejet, envoyerRejet, rejetEnCours] = useActionState(rejeter, ETAT_INITIAL);
  const [rejetOuvert, ouvrirRejet] = useState(false);
  const enCours = valideEnCours || rejetEnCours;
  const caches = Object.entries(champs).map(([nom, valeur]) => (
    <input key={nom} type="hidden" name={nom} value={valeur} />
  ));

  const message = etatValide.erreur ?? etatRejet.erreur ?? null;
  const reussite = (etatValide.ok && etatValide.message) || (etatRejet.ok && etatRejet.message) || null;

  return (
    <div className="mt-1">
      {!rejetOuvert ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={bouton}
            style={secondaire}
            disabled={enCours}
            onClick={() => ouvrirRejet(true)}
          >
            Rejeter
          </button>
          <form action={envoyerValide}>
            {caches}
            <button type="submit" className={bouton} style={principal} disabled={enCours}>
              {valideEnCours && <span className="rouet" aria-hidden="true" />}
              {valideEnCours ? "Validation" : "Valider"}
            </button>
          </form>
        </div>
      ) : (
        <form action={envoyerRejet} className="flex flex-col gap-2">
          {caches}
          <label className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            Motif du rejet{motifAuMembre ? ", envoyé au membre" : ""}
            <textarea
              name="motif"
              required
              rows={2}
              autoFocus
              placeholder="Montant introuvable sur le compte, reçu illisible…"
              className="mt-1.5 w-full rounded-[10px] border px-3 py-2 text-[16px] outline-none lg:text-[14px]"
              style={{ background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" }}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={bouton}
              style={secondaire}
              disabled={rejetEnCours}
              onClick={() => ouvrirRejet(false)}
            >
              Annuler
            </button>
            <button
              type="submit"
              className={bouton}
              style={{ ...secondaire, color: "var(--etat-manque)" }}
              disabled={rejetEnCours}
            >
              {rejetEnCours && <span className="rouet" aria-hidden="true" />}
              {rejetEnCours ? "Rejet" : "Confirmer le rejet"}
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className="mt-2 text-[12.5px]" style={{ color: "var(--etat-manque)" }} role="alert">
          {message}
        </p>
      )}
      {reussite && !message && (
        <p className="mt-2 text-[12.5px]" style={{ color: "var(--etat-ok)" }} role="status">
          {reussite}
        </p>
      )}
    </div>
  );
}
