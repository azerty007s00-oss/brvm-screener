import { dateCourte, fcfa, nombre } from "@/lib/settings";

type Point = { date: string; valeur: number };

/** Le jour, compte depuis l'epoque : la seule unite comparable entre releves. */
function enJours(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000;
}

/**
 * Courbe d'evolution du portefeuille, en SVG inline : pas de librairie de
 * graphes pour quatorze points, et le rendu reste net a l'impression.
 *
 * L'ABSCISSE EST LE TEMPS, et non le rang du releve.
 *
 * La premiere version espacait les points regulierement. Les releves du club ne
 * le sont pas : six mois separent les premiers, et cinq sont tombes dans le
 * seul mois de septembre 2026. Le dessin montrait donc une progression reguliere
 * la ou il y a eu une longue attente puis une rafale -- il ne se contentait pas
 * d'etre imprecis, il racontait autre chose que les chiffres.
 *
 * L'ordonnee se cale de meme sur des paliers ronds. Une echelle qui commence au
 * plus bas releve et finit au plus haut redresse n'importe quelle pente : elle
 * fait d'une hausse de 3 % une ascension.
 */
export function CourbePortefeuille({ points }: { points: Point[] }) {
  if (points.length < 2) {
    return (
      <p className="py-6 text-center text-sm" style={{ color: "var(--ink-2)" }}>
        Au moins deux releves sont necessaires pour tracer l&apos;evolution.
      </p>
    );
  }

  const L = 640;
  const H = 220;
  /*
   * La droite est une gouttiere, non de la zone tracee : une etiquette
   * d'ordonnee posee sur la courbe se lit mal et masque le dernier releve,
   * qui est justement celui qu'on regarde.
   */
  const marge = { haut: 14, bas: 30, gauche: 6, droite: 54 };

  const jours = points.map((p) => enJours(p.date));
  const t0 = Math.min(...jours);
  const t1 = Math.max(...jours);
  const duree = t1 - t0 || 1;

  const valeurs = points.map((p) => p.valeur);
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);

  const PAS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];
  const pas = PAS.find((p) => Math.ceil(max / p) - Math.floor(min / p) <= 6) ?? PAS[PAS.length - 1];
  const y0 = Math.floor(min / pas) * pas;
  const y1 = Math.max(Math.ceil(max / pas) * pas, y0 + pas);

  const x = (iso: string) =>
    marge.gauche + ((enJours(iso) - t0) / duree) * (L - marge.gauche - marge.droite);
  const y = (v: number) =>
    marge.haut + (1 - (v - y0) / (y1 - y0)) * (H - marge.haut - marge.bas);

  const paliers: number[] = [];
  for (let v = y0; v <= y1 + 1; v += pas) paliers.push(v);

  const ligne = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.date).toFixed(1)} ${y(p.valeur).toFixed(1)}`)
    .join(" ");

  /** « 1,5 M » plutot que « 1 500 000 » : la gouttiere ne fait que 52 px. */
  const enMillions = (v: number) =>
    v === 0
      ? "0"
      : `${(v / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",")} M`;

  const dernier = points[points.length - 1];

  return (
    <figure>
      <svg
        viewBox={`0 0 ${L} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Valeur du compte-titres, ${points.length} releves du ${dateCourte(points[0].date)} au ${dateCourte(dernier.date)} : de ${nombre(min)} a ${nombre(max)} FCFA`}
      >
        {paliers.map((v) => (
          <g key={v}>
            <line
              x1={marge.gauche}
              x2={L - marge.droite}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line)"
              strokeWidth="1"
            />
            <text
              x={L - marge.droite + 8}
              y={y(v) + 4}
              textAnchor="start"
              fontSize="11"
              fill="var(--ink-3)"
            >
              {enMillions(v)}
            </text>
          </g>
        ))}

        {/* Des segments droits : entre deux releves, on ne sait rien. */}
        <path
          d={ligne}
          fill="none"
          stroke="var(--gold)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((p, i) => (
          <circle
            key={p.date}
            cx={x(p.date)}
            cy={y(p.valeur)}
            r={i === points.length - 1 ? 4 : 2.5}
            fill={i === points.length - 1 ? "var(--gold)" : "var(--page)"}
            stroke="var(--gold)"
            strokeWidth={i === points.length - 1 ? 2 : 1.5}
          />
        ))}

        {[points[0], dernier].map((p, i) => (
          <text
            key={`t-${i}-${p.date}`}
            x={i === 0 ? marge.gauche : L - marge.droite}
            y={H - 9}
            textAnchor={i === 0 ? "start" : "end"}
            fontSize="11"
            fill="var(--ink-3)"
          >
            {dateCourte(p.date)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs" style={{ color: "var(--ink-3)" }}>
        <span>Plus bas {fcfa(min)}</span>
        <span>Plus haut {fcfa(max)}</span>
      </figcaption>
    </figure>
  );
}
