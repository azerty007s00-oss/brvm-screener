"use client";

import { useEffect, useRef, useState } from "react";
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
 *
 * LA BOITE SUIT LA LARGEUR DISPONIBLE, et non un rapport fixe. Avec un viewBox
 * de 586 par 200, un telephone de 390 px rendait un graphique de 102 px de
 * haut : la courbe s'y ecrasait, et le trait de 2 px devenait un cheveu. Sur un
 * ecran de 1 440, le meme trait passait a 3,4 px. Le composant mesure donc sa
 * place et pose un viewBox a l'echelle 1:1 -- un pixel du dessin vaut un pixel
 * a l'ecran, quel que soit l'ecran.
 */
export function CourbePortefeuille({ points }: { points: Point[] }) {
  const boite = useRef<HTMLDivElement>(null);
  /*
   * 586 au premier rendu, celui du serveur, ou aucune largeur n'est connue :
   * c'est la mesure d'une colonne d'ordinateur, et le dessin reste juste --
   * seule sa hauteur s'ajustera au montage.
   */
  const [largeur, setLargeur] = useState(586);

  useEffect(() => {
    const el = boite.current;
    if (!el) return;
    const suivre = () => setLargeur(Math.max(240, Math.round(el.clientWidth)));
    suivre();
    const observateur = new ResizeObserver(suivre);
    observateur.observe(el);
    return () => observateur.disconnect();
  }, []);

  if (points.length < 2) {
    return (
      <p className="py-6 text-center text-sm" style={{ color: "var(--ink-2)" }}>
        Au moins deux releves sont necessaires pour tracer l&apos;evolution.
      </p>
    );
  }

  const L = largeur;
  /* 200 px sur un telephone, 300 des qu'il y a la place : les proportions du document. */
  const H = largeur < 520 ? 200 : 300;
  const marge = { haut: 10, bas: 10, gauche: 6, droite: 6 };

  const jours = points.map((p) => enJours(p.date));
  const t0 = Math.min(...jours);
  const t1 = Math.max(...jours);
  const duree = t1 - t0 || 1;

  const valeurs = points.map((p) => p.valeur);
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);

  /* Au plus six intervalles, quatre sur un telephone : au-dela, la grille bavarde. */
  const maxIntervalles = H < 250 ? 4 : 6;
  const PAS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
  const pas =
    PAS.find((p) => Math.ceil(max / p) - Math.floor(min / p) <= maxIntervalles) ??
    PAS[PAS.length - 1];
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
      {/*
       * Les etiquettes sont en HTML, non dans le SVG.
       *
       * Un texte pose dans un SVG subit son echelle : le meme « 11 px »
       * devenait 19 px sur un ecran de 1 440 et 6 px sur un telephone, ou il
       * n'etait plus lisible. En HTML il garde sa taille, et se place en
       * pourcentage de la hauteur du trace.
       */}
      <div ref={boite} className="relative" style={{ paddingRight: 52 }}>
        {/*
         * La hauteur est posee en CSS et le dessin s'y etire : avant que le
         * composant ait mesure sa place -- au premier rendu, et toujours si le
         * navigateur n'execute rien -- un rapport fixe laissait deux bandes
         * vides au-dessus et au-dessous. `vector-effect` garde alors le trait a
         * 2 px, quelle que soit l'echelle.
         */}
        <svg
          viewBox={`0 0 ${L} ${H}`}
          preserveAspectRatio="none"
          className="block h-[200px] w-full lg:h-[300px]"
          role="img"
          aria-label={`Valeur du compte-titres, ${points.length} releves du ${dateCourte(points[0].date)} au ${dateCourte(dernier.date)} : de ${nombre(min)} a ${nombre(max)} FCFA`}
        >
          {paliers.map((v) => (
            <line
              key={v}
              x1={marge.gauche}
              x2={L - marge.droite}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Des segments droits : entre deux releves, on ne sait rien. */}
          <path
            d={ligne}
            fill="none"
            stroke="var(--gold)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
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
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {paliers.map((v) => (
          <span
            key={v}
            className="absolute text-[12px] tabular-nums"
            style={{ right: 0, top: `calc(${(y(v) / H) * 100}% - 0.5em)`, color: "var(--ink-3)" }}
          >
            {enMillions(v)}
          </span>
        ))}
      </div>

      <div
        className="mt-1 flex justify-between text-[12px] tabular-nums"
        style={{ color: "var(--ink-3)", paddingRight: 52 }}
      >
        <span>{dateCourte(points[0].date)}</span>
        <span>{dateCourte(dernier.date)}</span>
      </div>

      <figcaption className="mt-2 flex justify-between text-[12.5px]" style={{ color: "var(--ink-2)" }}>
        <span>Plus bas {fcfa(min)}</span>
        <span>Plus haut {fcfa(max)}</span>
      </figcaption>
    </figure>
  );
}
