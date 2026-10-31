"use client";

import { useActionState, useState } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";
import { voter } from "@/app/actions/votes";
import { CHOIX, type Choix } from "@/lib/scrutin";

const ETAT_INITIAL: EtatFormulaire = { ok: false };

/** Pour, contre ou abstention : trois grands boutons, puis la validation. */
export function BulletinVote({ voteId, actuel }: { voteId: string; actuel: Choix | null }) {
  const [etat, envoyer, enCours] = useActionState(voter, ETAT_INITIAL);
  const [choix, majChoix] = useState<Choix | null>(actuel);
  const libelle = CHOIX.find((c) => c.cle === choix)?.libelle.toLowerCase();

  return (
    <form action={envoyer}>
      <input type="hidden" name="voteId" value={voteId} />
      <div role="radiogroup" aria-label="Votre choix" className="grid grid-cols-3 gap-2">
        {CHOIX.map((c) => {
          const pris = choix === c.cle;
          return (
            <label
              key={c.cle}
              className="tapable flex min-h-13 cursor-pointer items-center justify-center rounded-[10px] text-[15px] font-semibold"
              style={
                pris
                  ? { border: "2px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 9%, var(--page))", color: "var(--accent)" }
                  : { border: "1px solid var(--line-2)", background: "var(--page)", color: "var(--ink)" }
              }
            >
              <input type="radio" name="choix" value={c.cle} checked={pris} onChange={() => majChoix(c.cle)} className="sr-only" />
              {c.libelle}
            </label>
          );
        })}
      </div>
      <button
        type="submit"
        disabled={enCours || choix === null || choix === actuel}
        className="tapable mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-medium disabled:opacity-60 lg:h-10 lg:rounded-lg lg:text-[14px]"
        style={{ background: "var(--accent)", color: "var(--sur-accent)" }}
      >
        {enCours && <span className="rouet" aria-hidden="true" />}
        {enCours
          ? "Envoi en cours"
          : choix === null
            ? "Choisissez votre réponse"
            : choix === actuel
              ? `Vous avez voté : ${libelle}`
              : `${actuel ? "Changer mon vote" : "Valider mon vote"} : ${libelle}`}
      </button>
      {etat.erreur && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--etat-manque)" }}>
          {etat.erreur}
        </p>
      )}
      {etat.ok && etat.message && (
        <p className="mt-2 text-[13px]" role="status" style={{ color: "var(--etat-paye)" }}>
          {etat.message}
        </p>
      )}
    </form>
  );
}
