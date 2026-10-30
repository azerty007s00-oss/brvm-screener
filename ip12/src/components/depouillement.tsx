import { CHOIX, pourcent, seuil, type Bulletin, type Electeur, type Majorite, type Resultat } from "@/lib/scrutin";

/**
 * Les voix pour, contre et abstention, en barres, avec le seuil de la
 * majorite sur la barre « Pour ». Les pourcentages sont ceux de toutes les
 * voix qui peuvent voter : ce qui manque est le silence.
 */
export function Barres({ r, majorite }: { r: Resultat; majorite: Majorite }) {
  const s = seuil(majorite);
  const lignes = [
    { cle: "pour", libelle: "Pour", poids: r.pour, couleur: "var(--accent)" },
    { cle: "contre", libelle: "Contre", poids: r.contre, couleur: "var(--etat-attente)" },
    { cle: "abstention", libelle: "Abstention", poids: r.abstention, couleur: "var(--ink-3)" },
  ];
  return (
    <div className="flex flex-col gap-3.5">
      {lignes.map((l) => {
        const taux = r.base > 0 ? l.poids / r.base : 0;
        return (
          <div key={l.cle}>
            <div className="flex justify-between text-[14px]">
              <span className="font-semibold">{l.libelle}</span>
              <span className="font-semibold tabular-nums">{pourcent(taux)}</span>
            </div>
            <div
              className="relative mt-1.5 h-3 rounded-full"
              style={{ background: "var(--sunk)" }}
              role="img"
              aria-label={`${l.libelle} : ${pourcent(taux)}`}
            >
              <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, taux * 100)}%`, background: l.couleur }} />
              {l.cle === "pour" && majorite !== "unanimite" && (
                <span
                  aria-hidden="true"
                  className="absolute -top-1 h-5 w-0.5"
                  style={{ left: `calc(${s * 100}% - 1px)`, background: "var(--ink)" }}
                />
              )}
            </div>
            {l.cle === "pour" && majorite !== "unanimite" && (
              <p className="mt-1 text-right text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                seuil : {majorite === "simple" ? "plus de 50 %" : "75 %"}
              </p>
            )}
          </div>
        );
      })}
      {r.silence > 0.0005 && (
        <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
          Sans vote : {pourcent(r.silence)} des voix.
        </p>
      )}
    </div>
  );
}

/** Qui a vote quoi : le vote est public. */
export function Votants({ electeurs, bulletins, clos }: { electeurs: Electeur[]; bulletins: Bulletin[]; clos: boolean }) {
  const choixDe = new Map(bulletins.map((b) => [b.membreId, b.choix]));
  const ordre = [...electeurs].sort((a, b) => b.poids - a.poids || a.nom.localeCompare(b.nom, "fr"));
  return (
    <ul>
      {ordre.map((e) => {
        const c = choixDe.get(e.membreId);
        const etat =
          e.exclu === "vise"
            ? { texte: "concerné, ne vote pas", couleur: "var(--ink-2)" }
            : e.exclu === "suspendu"
              ? { texte: "suspendu (R2)", couleur: "var(--etat-attente)" }
              : c
                ? { texte: CHOIX.find((x) => x.cle === c)?.libelle ?? c, couleur: c === "pour" ? "var(--etat-paye)" : c === "contre" ? "var(--etat-attente)" : "var(--ink-2)" }
                : { texte: clos ? "n'a pas voté" : "pas encore voté", couleur: "var(--ink-2)" };
        return (
          <li key={e.membreId} className="flex items-center gap-2.5 border-t py-2.5 text-[14px]" style={{ borderColor: "var(--line)" }}>
            <span className="min-w-0 flex-1 truncate">{e.nom}</span>
            <span className="flex-none text-[12.5px] tabular-nums" style={{ color: "var(--ink-2)" }}>
              {pourcent(e.poids)}
            </span>
            <span className="w-32 flex-none text-right text-[12.5px] font-semibold" style={{ color: etat.couleur }}>
              {etat.texte}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
