"use client";

import { useActionState, useState } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";
import { enregistrerPointsAction } from "@/app/actions/rapport";

const ETAT_INITIAL: EtatFormulaire = { ok: false };

const styleChamp =
  "h-12 w-full rounded-[10px] border px-3.5 text-[16px] outline-none " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--gold)] focus:border-transparent lg:h-10 lg:rounded-lg lg:px-3 lg:text-[14px]";
const couleursChamp = { background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" };

/** Les points du bureau : une ligne par point, une ligne vide de plus pour ajouter. */
export function PointsOrdreDuJour({ reunionId, points }: { reunionId: string; points: string[] }) {
  const [etat, envoyer, enCours] = useActionState(enregistrerPointsAction, ETAT_INITIAL);
  const [lignes, majLignes] = useState<string[]>(points.length > 0 ? points : [""]);

  return (
    <form action={envoyer}>
      <input type="hidden" name="reunionId" value={reunionId} />
      <ol className="flex flex-col gap-2">
        {lignes.map((p, i) => (
          <li key={i} className="flex items-center gap-2.5">
            <span className="w-5 flex-none text-right text-[14px] tabular-nums" style={{ color: "var(--ink-2)" }}>
              {i + 1}.
            </span>
            <input
              name="point"
              value={p}
              maxLength={200}
              placeholder="Achats de titres : SNTS ou ORGT ?"
              onChange={(e) => majLignes(lignes.map((x, j) => (j === i ? e.target.value : x)))}
              className={styleChamp}
              style={couleursChamp}
            />
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => majLignes([...lignes, ""])}
          className="tapable inline-flex h-11 items-center rounded-lg px-4 text-[14px] font-medium lg:h-9"
          style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
        >
          Ajouter un point
        </button>
        <button
          type="submit"
          disabled={enCours}
          className="tapable inline-flex h-11 items-center gap-2 rounded-lg px-4 text-[14px] font-medium disabled:opacity-60 lg:h-9"
          style={{ background: "var(--accent)", color: "var(--sur-accent)" }}
        >
          {enCours && <span className="rouet" aria-hidden="true" />}
          {enCours ? "Envoi en cours" : "Enregistrer les points"}
        </button>
      </div>
      {etat.erreur && <p className="mt-2 text-[13px]" style={{ color: "var(--etat-manque)" }}>{etat.erreur}</p>}
      {etat.ok && etat.message && <p className="mt-2 text-[13px]" role="status" style={{ color: "var(--etat-paye)" }}>{etat.message}</p>}
    </form>
  );
}

/** Le rapport en texte, pour le groupe : ouvert dans WhatsApp, ou copie. */
export function PartageWhatsApp({ texte }: { texte: string }) {
  const [copie, majCopie] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={`https://wa.me/?text=${encodeURIComponent(texte)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="tapable inline-flex h-11 flex-1 items-center justify-center rounded-lg px-4 text-[14px] font-medium lg:h-9"
        style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
      >
        Pour WhatsApp
      </a>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(texte);
            majCopie(true);
          } catch {
            majCopie(false);
          }
        }}
        className="tapable inline-flex h-11 items-center justify-center rounded-lg px-4 text-[14px] font-medium lg:h-9"
        style={{ background: "var(--page)", color: copie ? "var(--etat-paye)" : "var(--ink)", border: "1px solid var(--line-2)" }}
      >
        {copie ? "Texte copié" : "Copier le texte"}
      </button>
    </div>
  );
}
