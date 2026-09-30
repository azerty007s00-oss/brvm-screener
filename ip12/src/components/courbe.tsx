"use client";

import { useEffect, useRef, useState } from "react";
import { dateCourte, fcfa, nombre } from "@/lib/settings";
import { couleurSigne } from "@/lib/perf";
import { Selecteur } from "@/components/selecteur";
import { reperesTemps, retenus, tracable, type Horizon } from "@/lib/horizons";
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
  surVise,
}: {
  points: Trace[];
  /**
   * Le gain de gestion de l'exercice tel que la synthese le calcule (Dietz
   * modifie). Sert de controle : voir `gainConcorde`.
   */
  gainExercice: number | null;
  /**
   * Appele au survol, avec le releve vise -- ou `null` quand on quitte le
   * graphique. Sert au heros de la page a suivre ce qu'on regarde.
   */
  surVise?: (t: Trace | null) => void;
}) {
  const boite = useRef<HTMLDivElement>(null);
  /*
   * L'exercice par defaut : c'est la periode dont le club rend compte en
   * assemblee. « Depuis le debut » ecrase les mois recents contre le bord
   * droit, et « 3 mois » ne dit rien de l'annee.
   */
  const [horizon, setHorizon] = useState<Horizon>("exercice");
  /*
   * Combien de fois la periode a change depuis l'ouverture de la page.
   *
   * Sert a deux choses : remonter le trace (la cle du chemin change, donc
   * l'animation repart) et raccourcir le second passage -- au changement de
   * periode on sait deja ce qu'on regarde, et l'attente se remarquerait.
   */
  const [passages, setPassages] = useState(0);
  /*
   * 586 au premier rendu, celui du serveur, ou aucune largeur n'est connue :
   * c'est la mesure d'une colonne d'ordinateur, et le dessin reste juste --
   * seule sa hauteur s'ajustera au montage.
   */
  const [largeur, setLargeur] = useState(586);
  /*
   * Le releve sous le doigt ou sous la souris, par son rang dans `traces`.
   * `null` quand on ne survole rien : la page revient alors a l'etat courant.
   */
  const [vise, setVise] = useState<number | null>(null);
  /*
   * Tant que la largeur n'est pas mesuree, l'axe s'en tient a ses deux dates.
   *
   * La regle d'espacement des reperes se calcule en pixels : calculee pour les
   * 586 px supposes puis rendue dans les 298 d'un telephone, elle laissait
   * « janv. 2026 » et « fevr. » l'un sur l'autre. Une etiquette illisible vaut
   * moins qu'aucune -- y compris ici, ou il suffit d'attendre une trame.
   */
  const [mesure, setMesure] = useState(false);

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
    const suivre = () => {
      setLargeur(Math.max(240, Math.round(el.clientWidth - GOUTTIERE)));
      setMesure(true);
    };
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

  /* Premier trace : on laisse le temps de voir. Rejeu : on va droit au but. */
  const rejeu = passages > 0;
  const tempo = {
    ["--duree-trace" as string]: rejeu ? "900ms" : "1150ms",
    ["--retard-trace" as string]: rejeu ? "0ms" : "180ms",
    ["--duree-bande" as string]: rejeu ? "600ms" : "800ms",
    ["--retard-bande" as string]: rejeu ? "320ms" : "650ms",
    ["--retard-point" as string]: rejeu ? "880ms" : "1250ms",
  };

  /*
   * ON S'AIMANTE AU RELEVE LE PLUS PROCHE, on n'interpole pas.
   *
   * Entre deux releves il ne s'est rien passe qu'on sache : afficher une valeur
   * au 12 septembre parce que le doigt y est passe reviendrait a inventer un
   * chiffre. Le trait se pose donc sur un releve, toujours.
   */
  const viser = (e: React.PointerEvent<SVGRectElement>) => {
    const cadre = e.currentTarget.getBoundingClientRect();
    if (cadre.width === 0) return;
    const enUnites = ((e.clientX - cadre.left) * L) / cadre.width;
    let proche = 0;
    for (let i = 1; i < traces.length; i++) {
      if (Math.abs(x(traces[i].date) - enUnites) < Math.abs(x(traces[proche].date) - enUnites)) {
        proche = i;
      }
    }
    if (proche !== vise) {
      setVise(proche);
      surVise?.(traces[proche]);
    }
  };
  const quitter = () => {
    setVise(null);
    surVise?.(null);
  };

  const point = vise === null ? null : traces[vise];

  const reperes = mesure
    ? reperesTemps(premier.date, dernier.date, L - marge.gauche - marge.droite)
    : [{ iso: premier.date, libelle: dateCourte(premier.date) }];

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
          surChoix={(h) => {
            setHorizon(h);
            setPassages((n) => n + 1);
          }}
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
         * L'ECHELLE EST 1:1, ET LE RESTE MEME AVANT LA MESURE.
         *
         * La hauteur venait de classes de rupture -- 200 px, 300 a partir de
         * 1 024 -- quand `H` se decide, lui, a 520 px de trace. Entre les deux,
         * un dessin haut de 300 unites entrait dans une boite de 200 pixels :
         * la courbe s'y ecrasait d'un tiers et les points sortaient en ovales
         * de 4,6 sur 3,3. Elle vient desormais du meme `H` qui a servi au
         * calcul, et la largeur du meme `L` : les deux axes sont a l'echelle 1,
         * par construction.
         *
         * Reste le premier rendu, celui du serveur, ou la largeur n'est pas
         * encore connue. `preserveAspectRatio="none"` etirait alors un dessin
         * de 586 sur 1 088 pixels, et les memes points sortaient en ovales de
         * 9,3 sur 5 -- une image fausse, le temps d'une trame, et pour toujours
         * si le navigateur n'execute rien. Le reglage par defaut,
         * `xMidYMid meet`, ne deforme jamais. Et la boite prend le RAPPORT du
         * dessin au lieu d'une hauteur fixe : une fois la largeur mesuree,
         * `L / H` redonne exactement `H` pixels de haut, et avant la mesure le
         * dessin remplit sa boite au lieu d'y flotter entre deux bandes vides.
         * Les etiquettes d'ordonnee, posees en pourcentage de cette hauteur,
         * tombent alors sur leur ligne dans les deux cas. `max-height` borne ce
         * rapport a la hauteur visee : sans elle, un ecran large rendrait un
         * graphique de 557 px avant la mesure, qui retomberait a 300 en
         * sautant sous les yeux. `vector-effect` garde
         * le trait a 2 px quelle que soit l'echelle.
         */}
        <svg
          viewBox={`0 0 ${L} ${H}`}
          className="block w-full"
          style={{ aspectRatio: `${L} / ${H}`, maxHeight: H }}
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
          <path
            key={`bande-${actif}`}
            className="bande"
            style={tempo}
            d={bande}
            fill="var(--c-bande)"
            stroke="none"
          />

          {/*
           * Le net place : en tirets, parce que ce n'est pas une mesure de
           * marche mais la somme de ce que le club a verse -- un escalier, que
           * l'on relie faute de connaitre sa marche entre deux releves.
           */}
          <path
            key={`place-${actif}`}
            className="bande"
            style={tempo}
            d={lignePlace}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth="1.25"
            strokeDasharray="1.5 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/*
           * Des segments droits : entre deux releves, on ne sait rien.
           *
           * `pathLength="1"` normalise la longueur : le tirete vaut 1 et son
           * decalage glisse de 1 a 0, quelle que soit la longueur reelle du
           * chemin -- qui change avec la periode et avec la largeur de l'ecran.
           * La cle remonte le trace a chaque changement de periode.
           */}
          <path
            key={`valeur-${actif}`}
            className="trace"
            style={tempo}
            pathLength={1}
            d={ligneValeur}
            fill="none"
            stroke="var(--gold)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/*
           * Le halo du dernier releve : il bat pour dire « c'est ici qu'on en
           * est ». Il vient sous le point, et disparait entierement quand le
           * systeme demande moins d'animation -- une pulsation sans fin est
           * precisement ce qu'on demande alors d'eteindre.
           */}
          <circle
            key={`halo-${actif}`}
            className="halo"
            cx={x(dernier.date)}
            cy={y(dernier.valeur)}
            r={4}
            fill="var(--gold)"
            opacity={0}
          />

          {traces.map((p, i) => (
            <circle
              key={`${actif}-${p.date}`}
              className="point"
              style={tempo}
              cx={x(p.date)}
              cy={y(p.valeur)}
              r={i === traces.length - 1 ? 4 : 2.5}
              fill={i === traces.length - 1 ? "var(--gold)" : "var(--page)"}
              stroke="var(--gold)"
              strokeWidth={i === traces.length - 1 ? 2 : 1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/*
           * LE SURVOL.
           *
           * Un rectangle transparent capte la souris et le doigt sur toute la
           * zone tracee : viser un cercle de 2,5 px demanderait une precision
           * que personne n'a, et aucune sur un telephone. `touch-action: pan-y`
           * laisse le defilement vertical passer -- sans lui, la page se
           * bloquerait des qu'un doigt effleure le graphique.
           */}
          <rect
            x={0}
            y={0}
            width={L}
            height={H}
            fill="transparent"
            style={{ cursor: "crosshair", touchAction: "pan-y" }}
            onPointerMove={viser}
            onPointerDown={viser}
            onPointerLeave={quitter}
            onPointerCancel={quitter}
          />

          {point && (
            /*
             * Le groupe glisse d'un releve a l'autre en 120 ms plutot que de
             * sauter : le deplacement dit lequel on quitte et lequel on prend.
             * Il ne capte rien -- le rectangle est au-dessus.
             */
            <g className="vise" style={{ transform: `translateX(${x(point.date)}px)` }}>
              <line
                x1={0}
                x2={0}
                y1={marge.haut - 2}
                y2={H - marge.bas}
                stroke="var(--ink-2)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                className="vise"
                cx={0}
                style={{ transform: `translateY(${y(point.netPlace)}px)` }}
                r={3.5}
                fill="var(--page)"
                stroke="var(--ink-3)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                className="vise"
                cx={0}
                style={{ transform: `translateY(${y(point.valeur)}px)` }}
                r={4.5}
                fill="var(--gold)"
                stroke="var(--page)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
        </svg>

        {/*
         * La date, en HTML : dans le SVG elle subirait l'echelle du dessin. On
         * la colle au bord quand le releve vise en approche a moins de 40 px,
         * sinon la moitie du texte sortirait de la carte.
         */}
        {point && (
          <span
            className="vise absolute top-0 rounded px-1.5 text-[12px] font-medium tabular-nums"
            style={{
              color: "var(--ink)",
              background: "var(--page)",
              left: `${(Math.min(Math.max(x(point.date), 40), L - 40) / L) * 100}%`,
              transform: "translateX(-50%)",
            }}
          >
            {dateCourte(point.date)}
          </span>
        )}

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

      {/*
       * L'ABSCISSE PORTE DES REPERES DE TEMPS, non ses deux bouts.
       *
       * Avec la seule date de depart et la seule date de fin, rien ne disait ou
       * tombait le milieu : cinq releves serres dans le seul mois de septembre
       * se lisaient comme une progression etalee sur l'annee. Les mois -- ou
       * les annees, quand la periode en couvre plus de deux -- donnent l'echelle
       * du temps, et la derniere date reste a droite : c'est la date du releve
       * dont on affiche la valeur.
       */}
      <div className="mt-1 text-[12px]" style={{ color: "var(--ink-3)", paddingRight: GOUTTIERE }}>
        {/*
         * Le bloc interieur porte les reperes, et non celui qui reserve la
         * gouttiere : un `left` en pourcentage se mesure sur la boite de
         * remplissage, gouttiere comprise, et decalerait chaque etiquette de
         * 52 px a droite de son jour.
         */}
        <div className="relative h-4">
          {reperes.map((r, i) => {
            /*
             * Le premier repere se cale a gauche au lieu de se centrer : centre
             * sur un point pose a 6 px du bord, la moitie de « janv. 2026 »
             * passait hors de la carte.
             */
            const aGauche = i === 0 && x(r.iso) < 40;
            return (
              <span
                key={r.iso}
                className="absolute top-0 whitespace-nowrap"
                style={
                  aGauche
                    ? { left: 0 }
                    : { left: `${(x(r.iso) / L) * 100}%`, transform: "translateX(-50%)" }
                }
              >
                {r.libelle}
              </span>
            );
          })}
          <span className="absolute top-0 right-0 tabular-nums">{dateCourte(dernier.date)}</span>
        </div>
      </div>

      <figcaption
        className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px]"
        style={{ color: "var(--ink-2)" }}
      >
        <span style={{ color: "var(--ink-3)" }}>
          {point ? `Au releve du ${dateCourte(point.date)}` : nomPeriode}
        </span>
        {point ? (
          /*
           * Sous le doigt, on ne montre plus la periode mais CE releve : sa
           * valeur, sa composition, et le gain de gestion acquis a cette date.
           * C'est la question qu'on se pose en pointant un creux ou une bosse.
           */
          <>
            <Poste libelle="Valeur" montant={point.valeur} signe={false} />
            {point.actions !== undefined && point.liquidites !== undefined && (
              <span>
                Actions{" "}
                <span className="font-medium tabular-nums" style={{ color: "var(--ink)" }}>
                  {nombre(point.actions)}
                </span>{" "}
                &middot; liquidites{" "}
                <span className="font-medium tabular-nums" style={{ color: "var(--ink)" }}>
                  {nombre(point.liquidites)}
                </span>
              </span>
            )}
            <Poste libelle="Gain de gestion" montant={point.valeur - point.netPlace} performance />
          </>
        ) : part === null ? (
          <span>
            Plus bas {fcfa(min)} &middot; plus haut {fcfa(max)}
          </span>
        ) : concorde ? (
          <>
            <Poste libelle="Valeur" montant={part.ecartValeur} />
            <Poste libelle="Apports nets" montant={part.apportsNets} />
            <Poste libelle="Gain de gestion" montant={part.gain} performance />
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

/**
 * Un poste de la decomposition : son nom, puis son montant a l'encre.
 *
 * `signe` vaut faux pour une valeur absolue -- la valeur d'un releve n'est pas
 * une variation, et « +3 857 845 » se lirait comme une hausse de ce montant.
 */
function Poste({
  libelle,
  montant,
  signe: avecSigne = true,
  performance = false,
}: {
  libelle: string;
  montant: number;
  signe?: boolean;
  /**
   * Vrai pour le gain de gestion, et lui seul : c'est le seul des trois postes
   * qui mesure une performance. « Valeur » et « Apports nets » restent a
   * l'encre -- un apport est de l'argent verse, pas un gain, et le peindre en
   * vert dirait le contraire.
   */
  performance?: boolean;
}) {
  return (
    <span>
      {libelle}{" "}
      <span
        className="font-medium tabular-nums"
        style={{ color: performance ? couleurSigne(montant) : "var(--ink)" }}
      >
        {avecSigne ? signe(montant) : nombre(montant)}
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
            border: "1px solid var(--gain)",
            borderRadius: 3,
          }}
        />
        Gain de gestion
      </span>
    </div>
  );
}
