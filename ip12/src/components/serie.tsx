import { frise, phraseSerie, record, serieEnCours, type MoisSerie } from "@/lib/serie";
import type { StatutMois } from "@/lib/penalites";

const INITIALES = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** La flamme de la serie : orange tant qu'elle brule, grise a zero. */
function Flamme({ allumee }: { allumee: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" style={{ fill: allumee ? "#e07a1f" : "var(--line-2)", stroke: allumee ? "#b4580c" : "var(--ink-3)", strokeWidth: 1.2, strokeLinejoin: "round" }}>
      <path d="M12 2.5 C13.5 6 17.5 8 17.5 13.5 A5.5 5.5 0 0 1 6.5 13.5 C6.5 10.5 8.3 9 9.2 7.2 C9.8 9 10.6 9.9 11.6 10.3 C11.4 7.6 11.2 5 12 2.5 Z" />
      {allumee && <path d="M12 13 C13.4 14.3 14.2 15.4 14.2 16.6 A2.2 2.2 0 0 1 9.8 16.6 C9.8 15.4 10.7 14.2 12 13 Z" style={{ fill: "#fbd38d", stroke: "none" }} />}
    </svg>
  );
}

/**
 * La serie de ponctualite sur l'accueil : les mois payes a l'heure d'affilee,
 * le record, les douze derniers mois, et ce qui la fera monter. Du club, on
 * ne dit que combien de membres ont une serie en cours.
 */
export function TuileSerie({
  cellules,
  moisCourant,
  jourEcheance,
  enSerie,
  membres,
}: {
  cellules: MoisSerie[];
  moisCourant: string;
  jourEcheance: number;
  enSerie: number;
  membres: number;
}) {
  const n = serieEnCours(cellules, moisCourant);
  const meilleur = Math.max(record(cellules, moisCourant), n);
  const cases = frise(cellules, moisCourant);
  const statutCourant: StatutMois | null = cellules.find((c) => c.mois === moisCourant)?.statut ?? null;
  const recent = new Set(cases.slice(-n).filter((c) => c.etat === "ok").map((c) => c.mois));

  return (
    <section className="revele rounded-xl border p-4" style={{ borderColor: "var(--line-2)" }}>
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 flex-none place-items-center rounded-[14px]" style={{ background: n > 0 ? "#fbeedd" : "var(--sunk)" }}>
          <Flamme allumee={n > 0} />
        </span>
        <div className="flex-1">
          <p className="text-[26px] font-semibold leading-none tabular-nums">{n} mois</p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            payés à l&apos;heure, d&apos;affilée
          </p>
        </div>
        <p className="flex-none text-right text-[12px]" style={{ color: "var(--ink-3)" }}>
          Record
          <br />
          <b className="text-[15px]" style={{ color: "var(--ink)" }}>
            {meilleur} mois
          </b>
        </p>
      </div>
      <div
        role="img"
        aria-label={`Les douze derniers mois : ${cases.filter((c) => c.etat === "ok").length} payés à l'heure`}
        className="mt-3 grid grid-cols-12 gap-1"
      >
        {cases.map((c) => (
          <span key={c.mois} className="flex flex-col items-center gap-1">
            <span
              className="h-5 w-full max-w-5 rounded-md"
              style={
                c.etat === "ok"
                  ? { background: recent.has(c.mois) ? "#e07a1f" : "#f3c48f" }
                  : c.etat === "retard"
                    ? { border: "1.5px dashed var(--etat-manque)" }
                    : c.etat === "attente"
                      ? { border: "1.5px solid var(--line-2)" }
                      : { background: "var(--sunk)" }
              }
            />
            <span className="text-[10.5px]" style={{ color: "var(--ink-3)" }}>
              {INITIALES[Number(c.mois.slice(5, 7)) - 1]}
            </span>
          </span>
        ))}
      </div>
      <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
        {phraseSerie(n, moisCourant, statutCourant, jourEcheance)}
      </p>
      <p className="mt-3 border-t pt-2.5 text-[12.5px]" style={{ borderColor: "var(--line)", color: "var(--ink-3)" }}>
        Dans le club : {enSerie} {enSerie > 1 ? "membres" : "membre"} sur {membres} {enSerie > 1 ? "ont" : "a"} une série en cours.
      </p>
    </section>
  );
}
