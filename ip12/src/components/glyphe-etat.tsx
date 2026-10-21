import type { CSSProperties } from "react";
import type { CelluleMois, StatutMois } from "@/lib/penalites";
import { LIBELLE_STATUT, STATUTS_LEGENDE, resumeFrise } from "@/lib/etats";
import { moisLong } from "@/lib/settings";

export { LIBELLE_STATUT, STATUTS_LEGENDE, initialeMois, moisCourt, resumeFrise, statutLigne } from "@/lib/etats";

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
          <rect x="1" y="1" width="18" height="18" rx="4.5" style={{ fill: "var(--etat-paye)" }} />
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
            style={{ fill: "var(--etat-paye)" }}
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
          title={`${moisLong(c.mois)} : ${LIBELLE_STATUT[c.statut]}`}
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
