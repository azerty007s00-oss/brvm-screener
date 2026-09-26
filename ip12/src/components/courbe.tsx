import { dateCourte, fcfa } from "@/lib/settings";

type Point = { date: string; valeur: number };

/**
 * Courbe d'evolution du portefeuille, en SVG inline : pas de librairie de graphes
 * pour trois points tous les deux mois, et le rendu reste net a l'impression.
 */
export function CourbePortefeuille({ points }: { points: Point[] }) {
  if (points.length < 2) {
    return (
      <p className="py-6 text-center text-sm" style={{ color: "var(--discret)" }}>
        Au moins deux releves sont necessaires pour tracer l&apos;evolution.
      </p>
    );
  }

  const L = 640;
  const H = 200;
  const marge = { haut: 16, bas: 28, gauche: 8, droite: 8 };
  const valeurs = points.map((p) => p.valeur);
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);
  const amplitude = max - min || 1;

  const x = (i: number) =>
    marge.gauche + (i * (L - marge.gauche - marge.droite)) / (points.length - 1);
  const y = (v: number) =>
    marge.haut + (1 - (v - min) / amplitude) * (H - marge.haut - marge.bas);

  const ligne = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.valeur).toFixed(1)}`).join(" ");
  const aire = `${ligne} L ${x(points.length - 1).toFixed(1)} ${H - marge.bas} L ${x(0).toFixed(1)} ${H - marge.bas} Z`;

  return (
    <figure>
      <svg viewBox={`0 0 ${L} ${H}`} className="w-full" role="img" aria-label="Evolution du portefeuille">
        <path d={aire} fill="var(--color-or-500)" opacity="0.14" />
        <path d={ligne} fill="none" stroke="var(--color-or-500)" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.valeur)} r="3.5" fill="var(--color-or-600)" />
        ))}
        {points.map((p, i) =>
          i === 0 || i === points.length - 1 ? (
            <text
              key={`t-${p.date}`}
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : "end"}
              fontSize="11"
              fill="currentColor"
              opacity="0.6"
            >
              {dateCourte(p.date)}
            </text>
          ) : null,
        )}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs" style={{ color: "var(--discret)" }}>
        <span>Plus bas {fcfa(min)}</span>
        <span>Plus haut {fcfa(max)}</span>
      </figcaption>
    </figure>
  );
}
