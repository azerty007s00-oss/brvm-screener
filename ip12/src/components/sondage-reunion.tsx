"use client";

import { useActionState, useState } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";
import { repondreSondage, validerDateReunion } from "@/app/actions/sondage";

const ETAT_INITIAL: EtatFormulaire = { ok: false };

export type JourSondage = { iso: string; court: string; clair: string; n: number };

function Retour({ etat }: { etat: EtatFormulaire }) {
  if (etat.erreur) {
    return (
      <p className="mt-2 text-[13px]" style={{ color: "var(--etat-manque)" }}>
        {etat.erreur}
      </p>
    );
  }
  if (etat.ok && etat.message) {
    return (
      <p className="mt-2 text-[13px]" role="status" style={{ color: "var(--etat-paye)" }}>
        {etat.message}
      </p>
    );
  }
  return null;
}

/** La barre d'un jour : combien de membres sur combien. */
function Barre({ n, total, fort }: { n: number; total: number; fort: boolean }) {
  return (
    <span className="relative h-2 flex-1 overflow-hidden rounded-full" style={{ background: "var(--sunk)" }}>
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${total > 0 ? Math.round((n / total) * 100) : 0}%`, background: fort ? "var(--accent)" : "var(--ink-3)" }}
      />
    </span>
  );
}

/**
 * Les jours du sondage, a cocher.
 *
 * Les compteurs bougent pendant qu'on coche : le membre voit tout de suite que
 * son « oui » au dimanche fait passer ce jour devant le samedi. Ce qu'il avait
 * deja repondu est retire des compteurs recus, puis rajoute selon ses cases.
 */
export function ReponseSondage({
  sondageId,
  jours,
  miens,
  total,
}: {
  sondageId: string;
  jours: JourSondage[];
  /** Les jours deja coches (quantiemes), ou null s'il n'a pas encore repondu. */
  miens: number[] | null;
  total: number;
}) {
  const [etat, envoyer, enCours] = useActionState(repondreSondage, ETAT_INITIAL);
  const [coches, majCoches] = useState<Set<number>>(new Set(miens ?? []));
  const nb = coches.size;

  return (
    <form action={envoyer}>
      <input type="hidden" name="sondageId" value={sondageId} />
      <ul className="flex flex-col gap-2">
        {jours.map((j) => {
          const quantieme = Number(j.iso.slice(8, 10));
          const coche = coches.has(quantieme);
          const n = j.n - (miens?.includes(quantieme) ? 1 : 0) + (coche ? 1 : 0);
          return (
            <li key={j.iso}>
              <label
                className="tapable flex min-h-13 cursor-pointer items-center gap-3 rounded-[10px] px-3"
                style={
                  coche
                    ? { border: "2px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 9%, var(--page))" }
                    : { border: "1px solid var(--line-2)", background: "var(--page)" }
                }
              >
                <input
                  type="checkbox"
                  name="jour"
                  value={quantieme}
                  checked={coche}
                  onChange={() => {
                    const suite = new Set(coches);
                    if (coche) suite.delete(quantieme);
                    else suite.add(quantieme);
                    majCoches(suite);
                  }}
                  className="h-5 w-5 flex-none"
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="w-[92px] flex-none text-[15px] font-semibold">{j.court}</span>
                <Barre n={n} total={total} fort={coche} />
                <span className="w-10 flex-none text-right text-[13px] tabular-nums" style={{ color: "var(--ink-2)" }}>
                  {n} / {total}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        type="submit"
        disabled={enCours || nb === 0}
        className="tapable mt-4 inline-flex h-13 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-medium transition disabled:opacity-60 lg:h-10 lg:rounded-lg lg:text-[14px]"
        style={{ background: "var(--ink)", color: "var(--page)" }}
      >
        {enCours && <span className="rouet" aria-hidden="true" />}
        {enCours ? "Envoi en cours" : nb === 0 ? "Cochez au moins un jour" : `Enregistrer ${nb > 1 ? `mes ${nb} jours` : "mon jour"}`}
      </button>
      <button
        type="submit"
        name="aucun"
        value="1"
        disabled={enCours}
        className="tapable mt-2 inline-flex h-11 w-full items-center justify-center rounded-xl text-[14px] font-medium disabled:opacity-60 lg:h-9 lg:rounded-lg lg:text-[13px]"
        style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
      >
        Aucun jour ne me va
      </button>
      <Retour etat={etat} />
    </form>
  );
}

/** Les jours du sondage en lecture : apres la cloture, ou pour le president. */
export function DecompteSondage({ jours, total, retenu }: { jours: JourSondage[]; total: number; retenu: string | null }) {
  return (
    <ul>
      {jours.map((j) => (
        <li key={j.iso} className="flex items-center gap-3 border-t py-2.5" style={{ borderColor: "var(--line)" }}>
          <span
            className="w-[92px] flex-none text-[14.5px]"
            style={j.iso === retenu ? { fontWeight: 700, color: "var(--accent)" } : undefined}
          >
            {j.court}
          </span>
          <Barre n={j.n} total={total} fort={j.iso === retenu} />
          <span className="w-10 flex-none text-right text-[13px] tabular-nums" style={{ color: "var(--ink-2)" }}>
            {j.n} / {total}
          </span>
        </li>
      ))}
    </ul>
  );
}

const styleChamp =
  "mt-1.5 h-12 w-full rounded-[10px] border px-3.5 text-[16px] outline-none " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--gold)] focus:border-transparent " +
  "lg:h-10 lg:rounded-lg lg:px-3 lg:text-[14px]";
const couleursChamp = { background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" };

/** Le president fixe le jour, l'heure et le lieu. */
export function ValidationDate({
  sondageId,
  jours,
  defaut,
  heure,
  lieu,
  correction,
}: {
  sondageId: string;
  jours: JourSondage[];
  defaut: string;
  heure: string;
  lieu: string;
  /** La date est deja fixee : le bouton dit qu'on la change. */
  correction: boolean;
}) {
  const [etat, envoyer, enCours] = useActionState(validerDateReunion, ETAT_INITIAL);
  const [jour, majJour] = useState(defaut);
  const choisi = jours.find((j) => j.iso === jour);

  return (
    <form action={envoyer}>
      <input type="hidden" name="sondageId" value={sondageId} />
      <label className="block">
        <span className="text-[13px] font-medium">Jour</span>
        <select name="jour" value={jour} onChange={(e) => majJour(e.target.value)} className={styleChamp} style={couleursChamp}>
          {jours.map((j) => (
            <option key={j.iso} value={j.iso}>
              {j.clair} ({j.n} {j.n > 1 ? "disponibles" : "disponible"})
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <label className="block">
          <span className="text-[13px] font-medium">Heure GMT (Abidjan)</span>
          <input name="heure" required maxLength={20} defaultValue={heure} placeholder="21 h" className={styleChamp} style={couleursChamp} />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium">Lieu ou lien</span>
          <input name="lieu" maxLength={160} defaultValue={lieu} placeholder="Cocody, chez…" className={styleChamp} style={couleursChamp} />
        </label>
      </div>
      <button
        type="submit"
        disabled={enCours}
        className="tapable mt-4 inline-flex h-13 w-full items-center justify-center gap-2 rounded-xl px-3 text-[15px] font-medium transition disabled:opacity-60 lg:h-10 lg:rounded-lg lg:text-[14px]"
        style={{ background: "var(--ink)", color: "var(--page)" }}
      >
        {enCours && <span className="rouet" aria-hidden="true" />}
        {enCours
          ? "Envoi en cours"
          : `${correction ? "Déplacer au" : "Valider le"} ${choisi?.clair ?? "jour choisi"} et prévenir tout le monde`}
      </button>
      <Retour etat={etat} />
    </form>
  );
}
