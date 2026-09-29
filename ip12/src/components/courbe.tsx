"use client";

import { useEffect, useRef, useState } from "react";
import { dateCourte, fcfa, nombre } from "@/lib/settings";
import { Selecteur } from "@/components/selecteur";
import { retenus, tracable, type Horizon } from "@/lib/horizons";
import { decomposer, gainConcorde, type Trace } from "@/lib/placement";

/** La gouttiere des ordonnees, a droite du trace. En HTML, hors du SVG. */
const GOUTTIERE = 52;

/** Le jour, compte depuis l'epoque : la seule unite comparable entre releves. */
function enJours(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000;
}

/** Un montant signe, avec le moins typographique : « +683 720 », « −12 000 ». */
function signe(v: number): string {
  return `${v >= 0 ? "+" : "−"}${nombre(Math.abs(v))}`;
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
 * DEUX COURBES, ET LA BANDE ENTRE ELLES. La valeur relevee, et le net place en
 * bourse. Ce qui les separe est le gain de gestion : on le voit, et on le lit
 * sous le graphique. Sans la seconde courbe, la premiere raconte surtout les
 * cotisations du club.
 *
 * LA BOITE SUIT LA LARGEUR DISPONIBLE, et non un rapport fixe. Avec un viewBox
 * de 586 par 200, un telephone de 390 px rendait un graphique de 102 px de
 * haut : la courbe s'y ecrasait, et le trait de 2 px devenait un cheveu. Sur un
 * ecran de 1 440, le meme trait passait a 3,4 px. Le composant mesure donc sa
 * place et pose un viewBox a l'echelle 1:1 -- un pixel du dessin vaut un pixel
 * a l'ecran, quel que soit l'ecran.
 */
export function CourbePortefeuille({
  points,
  gainExercice,
}: {
  points: Trace[];
  /**
   * Le gain de gestion de l'exercice tel que la synthese le calcule (Dietz
   * modifie). Sert de controle : voir `gainConcorde`.
   */
  gainExercice: number | null;
}) {
  const boite = useRef<HTMLDivElement>(null);
  /*
   * L'exercice par defaut : c'est la periode dont le club rend compte en
   * assemblee. « Depuis le debut » ecrase les mois recents contre le bord
   * droit, et « 3 mois » ne dit rien de l'annee.
   */
  const [horizon, setHorizon] = useState<Horizon>("exercice");
  /*
   * 586 au premier rendu, celui du serveur, ou aucune largeur n'est connue :
   * c'est la mesure d'une colonne d'ordinateur, et le dessin reste juste --
   * seule sa hauteur s'ajustera au montage.
   */
  const [largeur, setLargeur] = useState(586);

  useEffect(() => {
    const el = boite.current;
    if (!el) return;
    /*
     * ON MESURE LE TRACE, NON LE BLOC QUI LE PORTE.
     *
     * `clientWidth` du bloc comprend les 52 px de gouttiere reserves aux
     * ordonnees. Le viewBox valait donc 52 px de plus que la surface ou le SVG
     * s'etire, et `preserveAspectRatio="none"` compressait le dessin d'autant :
     * 1 016 unites pour 964 pixels a 1 440, 350 pour 298 sur un telephone. Les
     * points, cercles dans le dessin, sortaient en ovales.
     */
    const suivre = () =>
      setLargeur(Math.max(240, Math.round(el.clientWidth - GOUTTIERE)));
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

  const fin = points[points.length - 1].date;

  /*
   * Une periode qui ne porte qu'un releve ne se trace pas. Plutot que de la
   * cacher -- la largeur des autres varierait d'une page a l'autre -- on la
   * laisse, desactivee, en disant pourquoi.
   */
  const horizons: { cle: Horizon; libelle: string }[] = [
    { cle: "trimestre", libelle: "3 mois" },
    { cle: "exercice", libelle: `Exercice ${fin.slice(0, 4)}` },
    { cle: "origine", libelle: `Depuis ${points[0].date.slice(0, 4)}` },
  ];
  const choix = horizons.map((h) => ({
    ...h,
    possible: tracable(points, h.cle),
    raison: "Moins de deux releves sur cette periode.",
  }));
  const actif = choix.find((h) => h.cle === horizon)?.possible
    ? horizon
    : (choix.find((h) => h.possible)?.cle ?? "origine");
  const traces = retenus(points, actif);

  const L = largeur;
  /* 200 px sur un telephone, 300 des qu'il y a la place : les proportions du document. */
  const H = largeur < 520 ? 200 : 300;
  const marge = { haut: 10, bas: 10, gauche: 6, droite: 6 };

  const jours = traces.map((p) => enJours(p.date));
  const t0 = Math.min(...jours);
  const t1 = Math.max(...jours);
  const duree = t1 - t0 || 1;

  /*
   * L'echelle couvre les DEUX series : une bande de gain sortie du cadre par le
   * bas serait pire qu'absente.
   */
  const valeurs = traces.flatMap((p) => [p.valeur, p.netPlace]);
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);

  /* Au plus six intervalles, quatre sur un telephone : au-dela, la grille bavarde. */
  const maxIntervalles = H < 250 ? 4 : 6;
  const PAS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
  const pas =
    PAS.find((p) => Math.ceil(max / p) - Math.floor(min / p) <= maxIntervalles) ??
    PAS[PAS.length - 1];
  /* Depuis l'origine, l'echelle part de zero : c'est tout le chemin qu'on montre. */
  const y0 = actif === "origine" ? 0 : Math.floor(min / pas) * pas;
  const y1 = Math.max(Math.ceil(max / pas) * pas, y0 + pas);

  const x = (iso: string) =>
    marge.gauche + ((enJours(iso) - t0) / duree) * (L - marge.gauche - marge.droite);
  const y = (v: number) =>
    marge.haut + (1 - (v - y0) / (y1 - y0)) * (H - marge.haut - marge.bas);

  const paliers: number[] = [];
  for (let v = y0; v <= y1 + 1; v += pas) paliers.push(v);

  const chemin = (lire: (p: Trace) => number) =>
    traces
      .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.date).toFixed(1)} ${y(lire(p)).toFixed(1)}`)
      .join(" ");

  const ligneValeur = chemin((p) => p.valeur);
  const lignePlace = chemin((p) => p.netPlace);
  /* La bande : la valeur a l'aller, le net place au retour. */
  const bande = `${ligneValeur} ${[...traces]
    .reverse()
    .map((p) => `L ${x(p.date).toFixed(1)} ${y(p.netPlace).toFixed(1)}`)
    .join(" ")} Z`;

  /** « 1,5 M » plutot que « 1 500 000 » : la gouttiere ne fait que 52 px. */
  const enMillions = (v: number) =>
    v === 0
      ? "0"
      : `${(v / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",")} M`;

  const dernier = traces[traces.length - 1];
  const premier = traces[0];

  /*
   * LA DECOMPOSITION, ET SON CONTROLE.
   *
   * Sur l'exercice, le gain calcule ici doit retomber sur celui que la synthese
   * annonce par Dietz modifie. Les deux chemins sont independants ; s'ils
   * divergent, on n'affiche pas le gain -- seulement la variation de la valeur,
   * en disant qu'elle comprend les apports. Mieux vaut une phrase modeste et
   * vraie qu'un troisieme chiffre de performance que personne ne peut
   * rapprocher des deux autres.
   */
  const part = decomposer(traces);
  const concorde =
    part !== null && (actif !== "exercice" || gainConcorde(part.gain, gainExercice));

  const nomPeriode =
    actif === "trimestre"
      ? "Sur trois mois"
      : actif === "exercice"
        ? `Sur l'exercice ${fin.slice(0, 4)}`
        : `Depuis ${dateCourte(premier.date)}`;

  return (
    <figure>
      <div className="sans-impression mb-4 flex flex-wrap items-center justify-between gap-3">
        <Legende />
        <Selecteur
          etiquette="Periode du graphique"
          options={choix}
          valeur={actif}
          surChoix={setHorizon}
        />
      </div>
      {/*
       * Les etiquettes sont en HTML, non dans le SVG.
       *
       * Un texte pose dans un SVG subit son echelle : le meme « 11 px »
       * devenait 19 px sur un ecran de 1 440 et 6 px sur un telephone, ou il
       * n'etait plus lisible. En HTML il garde sa taille, et se place en
       * pourcentage de la hauteur du trace.
       */}
      <div ref={boite} className="relative" style={{ paddingRight: GOUTTIERE }}>
        {/*
         * La hauteur est posee sur le SVG lui-meme, a la valeur qui a servi au
         * calcul.
         *
         * Elle venait de classes de rupture -- 200 px, 300 a partir de 1 024 --
         * quand `H` se decide, lui, a 520 px de trace. Entre les deux, un
         * dessin haut de 300 unites entrait dans une boite de 200 pixels : la
         * courbe s'y ecrasait d'un tiers et les points sortaient en ovales de
         * 4,6 sur 3,3. Une seule source pour la hauteur, et le rapport reste
         * 1:1. `vector-effect` garde alors le trait a 2 px, quelle que soit
         * l'echelle.
         */}
        <svg
          viewBox={`0 0 ${L} ${H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height: H }}
          role="img"
          aria-label={`Valeur du compte-titres et net place en bourse, ${traces.length} releves du ${dateCourte(premier.date)} au ${dateCourte(dernier.date)} : de ${nombre(min)} a ${nombre(max)} FCFA`}
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

          {/* Ce qui separe les deux courbes est le gain de gestion. */}
          <path d={bande} fill="var(--c-bande)" stroke="none" />

          {/*
           * Le net place : en tirets, parce que ce n'est pas une mesure de
           * marche mais la somme de ce que le club a verse -- un escalier, que
           * l'on relie faute de connaitre sa marche entre deux releves.
           */}
          <path
            d={lignePlace}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth="1.25"
            strokeDasharray="1.5 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Des segments droits : entre deux releves, on ne sait rien. */}
          <path
            d={ligneValeur}
            fill="none"
            stroke="var(--gold)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {traces.map((p, i) => (
            <circle
              key={p.date}
              cx={x(p.date)}
              cy={y(p.valeur)}
              r={i === traces.length - 1 ? 4 : 2.5}
              fill={i === traces.length - 1 ? "var(--gold)" : "var(--page)"}
              stroke="var(--gold)"
              strokeWidth={i === traces.length - 1 ? 2 : 1.5}
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
        style={{ color: "var(--ink-3)", paddingRight: GOUTTIERE }}
      >
        <span>{dateCourte(premier.date)}</span>
        <span>{dateCourte(dernier.date)}</span>
      </div>

      <figcaption
        className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px]"
        style={{ color: "var(--ink-2)" }}
      >
        <span style={{ color: "var(--ink-3)" }}>{nomPeriode}</span>
        {part === null ? (
          <span>
            Plus bas {fcfa(min)} &middot; plus haut {fcfa(max)}
          </span>
        ) : concorde ? (
          <>
            <Poste libelle="Valeur" montant={part.ecartValeur} />
            <Poste libelle="Apports nets" montant={part.apportsNets} />
            <Poste libelle="Gain de gestion" montant={part.gain} />
          </>
        ) : (
          <span>
            Variation de la valeur{" "}
            <span className="font-medium tabular-nums" style={{ color: "var(--ink)" }}>
              {signe(part.ecartValeur)} FCFA
            </span>
            , apports compris.
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** Un poste de la decomposition : son nom, puis son montant a l'encre. */
function Poste({ libelle, montant }: { libelle: string; montant: number }) {
  return (
    <span>
      {libelle}{" "}
      <span className="font-medium tabular-nums" style={{ color: "var(--ink)" }}>
        {signe(montant)}
      </span>
    </span>
  );
}

/**
 * La legende. Elle nomme les deux courbes et la bande : sans elle, la seconde
 * ligne en tirets n'est qu'une ligne en tirets.
 */
function Legende() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]" style={{ color: "var(--ink-2)" }}>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="block flex-none"
          style={{ width: 16, height: 2, background: "var(--gold)", borderRadius: 2 }}
        />
        Valeur relevee
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="16" height="2" viewBox="0 0 16 2" aria-hidden="true" className="flex-none">
          <line
            x1="0"
            y1="1"
            x2="16"
            y2="1"
            stroke="var(--ink-3)"
            strokeWidth="1.5"
            strokeDasharray="1.5 3"
            strokeLinecap="round"
          />
        </svg>
        Net place en bourse
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="block flex-none"
          style={{
            width: 12,
            height: 12,
            background: "var(--c-bande)",
            border: "1px solid var(--line-2)",
            borderRadius: 3,
          }}
        />
        Gain de gestion
      </span>
    </div>
  );
}
