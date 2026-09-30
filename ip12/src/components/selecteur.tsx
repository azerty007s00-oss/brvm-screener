"use client";

/**
 * Selecteur segmente : quelques choix exclusifs, dans la largeur d'un bouton.
 *
 * Un pouce glisse sous l'option choisie plutot que de la colorer : le
 * deplacement dit lequel on quitte et lequel on prend, ce qu'un changement de
 * teinte ne dit pas. Il s'arrete net si le systeme demande moins d'animation.
 *
 * Une option qu'on ne peut pas prendre -- une periode ou le club n'a pas deux
 * releves -- reste visible et desactivee : la cacher ferait varier la largeur
 * des autres d'une page a l'autre, et laisserait croire qu'elle n'existe pas.
 */
export function Selecteur<T extends string>({
  etiquette,
  options,
  valeur,
  surChoix,
}: {
  etiquette: string;
  options: { cle: T; libelle: string; possible?: boolean; raison?: string }[];
  valeur: T;
  surChoix: (cle: T) => void;
}) {
  const n = options.length;
  const rang = Math.max(0, options.findIndex((o) => o.cle === valeur));

  return (
    <div
      role="group"
      aria-label={etiquette}
      className="relative grid h-11 flex-none p-1 lg:h-8 lg:p-[3px]"
      style={{
        background: "var(--sunk)",
        borderRadius: 12,
        gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
      }}
    >
      <span
        aria-hidden="true"
        className="pouce absolute top-1 bottom-1 left-1 lg:top-[3px] lg:bottom-[3px] lg:left-[3px]"
        style={{
          width: `calc((100% - 8px) / ${n})`,
          transform: `translateX(calc(${rang} * 100%))`,
          background: "var(--page)",
          borderRadius: 9,
          boxShadow: "var(--raise)",
        }}
      />
      {options.map((o) => {
        const possible = o.possible !== false;
        const ici = o.cle === valeur;
        return (
          <button
            key={o.cle}
            type="button"
            aria-pressed={ici}
            disabled={!possible}
            title={possible ? undefined : o.raison}
            onClick={() => surChoix(o.cle)}
            className="relative z-[1] rounded-lg px-2 text-[13px] font-medium whitespace-nowrap disabled:opacity-45"
            style={{ color: ici ? "var(--ink)" : "var(--ink-2)" }}
          >
            {o.libelle}
          </button>
        );
      })}
    </div>
  );
}
