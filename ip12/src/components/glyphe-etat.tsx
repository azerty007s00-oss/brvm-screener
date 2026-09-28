import type { CSSProperties } from "react";
import type { CelluleMois, StatutMois } from "@/lib/penalites";
import { moisLong } from "@/lib/settings";

/**
 * L'etat d'un mois, par sa forme avant sa couleur.
 *
 * Premiere version : une pastille teintee. Un homme sur douze distingue mal le
 * rouge du vert, et le club en compte dix -- un membre daltonien ne lisait pas
 * sa propre situation. Deuxieme version : un signe typographique dans la
 * pastille (coche, « ? », « ½ »). Mieux, mais le signe depend de la fonte, se
 * brouille a 15 px et disparait a la photocopie.
 *
 * Troisieme et derniere : un dessin. Chaque etat a une silhouette qui se
 * reconnait sans couleur, sans fonte et en noir et blanc -- le carre plein, le
 * carre corne, le pointille, la moitie pleine, le point d'exclamation,
 * l'anneau. La couleur ne fait plus que confirmer.
 */

export const LIBELLE_STATUT: Record<StatutMois, string> = {
  paye: "Paye",
  paye_en_retard: "Paye en retard",
  en_attente: "En attente",
  partiel: "Incomplet",
  retard: "En retard",
  a_venir: "A venir",
  hors_periode: "Hors periode",
};

/** Les six etats qui figurent en legende : « hors periode » n'est rien a montrer. */
export const STATUTS_LEGENDE: StatutMois[] = [
  "paye",
  "paye_en_retard",
  "en_attente",
  "partiel",
  "retard",
  "a_venir",
];

/*
 * La coche est creusee dans la pastille : son trait prend la couleur de la
 * carte, qui bascule avec le theme et devient blanche a l'impression -- ou la
 * pastille, elle, devient noire.
 */
const coche: CSSProperties = {
  fill: "none",
  stroke: "var(--carte)",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function GlypheEtat({
  statut,
  taille = 20,
}: {
  statut: StatutMois;
  taille?: number;
}) {
  const s: CSSProperties = {
    width: taille,
    height: taille,
    display: "block",
    flexShrink: 0,
  };

  switch (statut) {
    case "paye":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true" style={s}>
          <rect x="1" y="1" width="18" height="18" rx="4.5" style={{ fill: "var(--vert)" }} />
          <path d="M5.6 10.4 L8.6 13.3 L14.4 6.9" style={coche} />
        </svg>
      );

    /*
     * Le coin corne dit le retard sans changer la couleur du carre : le mois
     * est paye, c'est un fait acquis, seule la penalite reste due. Le triangle
     * est detache du corps par un trait de la couleur de la carte, sans quoi
     * les deux masses se confondraient une fois imprimees en noir.
     */
    case "paye_en_retard":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true" style={s}>
          <path
            d="M5.5 1 H12.2 L19 7.8 V14.5 A4.5 4.5 0 0 1 14.5 19 H5.5 A4.5 4.5 0 0 1 1 14.5 V5.5 A4.5 4.5 0 0 1 5.5 1 Z"
            style={{ fill: "var(--vert)" }}
          />
          <path
            d="M14.7 1 H17 A2 2 0 0 1 19 3 V5.3 Z"
            style={{ fill: "var(--ambre)", stroke: "var(--carte)", strokeWidth: 0.9 }}
          />
          <path d="M5.2 10.6 L8.2 13.5 L13.4 7.8" style={coche} />
        </svg>
      );

    case "en_attente":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true" style={s}>
          <rect
            x="2"
            y="2"
            width="16"
            height="16"
            rx="4"
            style={{
              fill: "var(--ambre-fond)",
              stroke: "var(--ambre)",
              strokeWidth: 1.8,
              strokeDasharray: "3.2 2.3",
            }}
          />
          <circle cx="6.6" cy="10" r="1.3" style={{ fill: "var(--ambre)" }} />
          <circle cx="10" cy="10" r="1.3" style={{ fill: "var(--ambre)" }} />
          <circle cx="13.4" cy="10" r="1.3" style={{ fill: "var(--ambre)" }} />
        </svg>
      );

    /* Moitie basse pleine : ce qui est verse, et ce qui manque au-dessus. */
    case "partiel":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true" style={s}>
          <rect
            x="2"
            y="2"
            width="16"
            height="16"
            rx="4"
            style={{ fill: "var(--carte)", stroke: "var(--rouge)", strokeWidth: 2 }}
          />
          <path
            d="M2 10.4 H18 V14 A4 4 0 0 1 14 18 H6 A4 4 0 0 1 2 14 Z"
            style={{ fill: "var(--rouge)" }}
          />
        </svg>
      );

    case "retard":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true" style={s}>
          <rect
            x="2"
            y="2"
            width="16"
            height="16"
            rx="4"
            style={{ fill: "var(--rouge-fond)", stroke: "var(--rouge)", strokeWidth: 2.2 }}
          />
          <path
            d="M10 5.7 V11.1"
            style={{
              fill: "none",
              stroke: "var(--rouge)",
              strokeWidth: 2.3,
              strokeLinecap: "round",
            }}
          />
          <circle cx="10" cy="14.3" r="1.35" style={{ fill: "var(--rouge)" }} />
        </svg>
      );

    case "a_venir":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true" style={s}>
          <circle
            cx="10"
            cy="10"
            r="3.2"
            style={{ fill: "none", stroke: "var(--discret)", strokeWidth: 1.5 }}
          />
        </svg>
      );

    /*
     * Avant l'entree du membre, ou apres sa sortie : rien a dire, mais la place
     * est tenue -- sans quoi les frises des membres ne s'alignent plus entre
     * elles, et la colonne d'un mois cesse de designer le meme mois.
     */
    case "hors_periode":
      return <span aria-hidden="true" style={{ ...s, display: "inline-block" }} />;
  }
}

/* --------------------------------------------------------------- vocabulaire */

const MOIS_COURTS = [
  "janv.", "fevr.", "mars", "avr.", "mai", "juin",
  "juil.", "aout", "sept.", "oct.", "nov.", "dec.",
];

/** « sept. » plutot que « septembre 2026 » : une frise n'a pas la place. */
export function moisCourt(iso: string): string {
  return MOIS_COURTS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(0, 7);
}

/** L'initiale du mois, pour l'echelle posee au-dessus des frises. */
export function initialeMois(iso: string): string {
  return moisCourt(iso).charAt(0).toUpperCase();
}

/**
 * L'etat d'une ligne, en toutes lettres.
 *
 * Douze glyphes cote a cote disent tout, mais seulement a qui les compte. La
 * phrase dit d'un coup ce qui reclame une action : « Retard : aout, sept. »
 *
 * Rien n'est recalcule ici : les etats sont ceux des cellules, l'ordre de
 * priorite est celui du reglement -- ce qui est du avant ce qui attend, et ce
 * qui attend avant ce qui est en regle.
 */
export function statutLigne(cellules: CelluleMois[]): {
  texte: string;
  encre: string;
} {
  const nomme = (s: StatutMois) =>
    cellules.filter((c) => c.statut === s).map((c) => moisCourt(c.mois));

  /*
   * Deux mois nommes, pas davantage.
   *
   * « Retard : mai, juin, juil., aout » ne tenait pas a cote du nom : le
   * navigateur coupait la phrase en « Retard : mai, jui... », et le nom du
   * membre avec. Deux mois et un compte disent la meme chose en tenant sur la
   * ligne -- le detail complet est a un doigt, dans le depliant.
   */
  const liste = (mois: string[]) =>
    mois.length <= 2 ? mois.join(", ") : `${mois.slice(0, 2).join(", ")} +${mois.length - 2}`;

  const du = [...nomme("retard"), ...nomme("partiel")];
  if (du.length > 0) {
    return { texte: `Retard : ${liste(du)}`, encre: "var(--rouge-encre)" };
  }

  const attente = nomme("en_attente");
  if (attente.length > 0) {
    return { texte: `En attente : ${liste(attente)}`, encre: "var(--ambre-encre)" };
  }

  /*
   * Une avance est un fait remarquable : elle n'ouvre aucun droit de plus sur
   * les benefices, mais son auteur merite de la voir portee a son credit.
   */
  const aujourdhui = new Date().toISOString().slice(0, 7);
  const avance = cellules
    .filter((c) => c.mois.slice(0, 7) > aujourdhui && (c.statut === "paye" || c.statut === "paye_en_retard"))
    .map((c) => moisCourt(c.mois));

  return {
    texte: avance.length > 0 ? `A jour, avance ${avance.at(-1)}` : "A jour",
    encre: "var(--vert-encre)",
  };
}

/** Le compte en toutes lettres, pour qui ecoute la page au lieu de la voir. */
export function resumeFrise(cellules: CelluleMois[], prefixe: string): string {
  const vus = cellules.filter((c) => c.statut !== "hors_periode");
  const parts = STATUTS_LEGENDE.map((s) => {
    const n = vus.filter((c) => c.statut === s).length;
    return n > 0 ? `${n} ${LIBELLE_STATUT[s].toLowerCase()}` : null;
  }).filter(Boolean);
  return `${prefixe}, ${vus.length} mois : ${parts.join(", ")}`;
}

/**
 * La frise des mois : un glyphe par mois, sur une grille fixe.
 *
 * La grille est en colonnes egales et non en ligne libre : les frises de dix
 * membres se superposent alors colonne par colonne, et l'echelle des mois
 * posee au-dessus vaut pour toutes.
 */
export function Frise({
  cellules,
  taille = 20,
  etiquette,
}: {
  cellules: CelluleMois[];
  taille?: number;
  etiquette: string;
}) {
  return (
    <div
      role="img"
      aria-label={resumeFrise(cellules, etiquette)}
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${cellules.length}, minmax(0, 1fr))` }}
    >
      {cellules.map((c) => (
        <span
          key={c.mois}
          className="flex justify-center"
          title={`${moisLong(c.mois)} — ${LIBELLE_STATUT[c.statut]}`}
        >
          <GlypheEtat statut={c.statut} taille={taille} />
        </span>
      ))}
    </div>
  );
}

/** La legende des six etats, sur deux colonnes. */
export function LegendeEtats() {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
      {STATUTS_LEGENDE.map((s) => (
        <li key={s} className="flex items-center gap-2">
          <GlypheEtat statut={s} taille={16} />
          <span style={{ color: "var(--discret)" }}>{LIBELLE_STATUT[s]}</span>
        </li>
      ))}
    </ul>
  );
}
