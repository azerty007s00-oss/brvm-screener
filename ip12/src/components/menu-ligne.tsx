"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";
import { styleBouton } from "@/components/boutons";

type Action = (etat: EtatFormulaire, donnees: FormData) => Promise<EtatFormulaire>;

export type ActionLigne = {
  libelle: string;
  action: Action;
  /** Les champs caches que l'action attend : l'identifiant de la ligne, un motif. */
  champs?: ReactNode;
  /** Phrase de confirmation. Sans elle, l'action part au premier clic. */
  confirmation?: string;
  /** Le mot du bouton qui confirme : « Supprimer », « Annuler la penalite ». */
  confirmer?: string;
};

/**
 * Les commandes d'une ligne, rangees derriere trois points.
 *
 * Elles etaient posees a meme la ligne, une par action : « Supprimer »,
 * « Annuler », « Reglee », « Remettre en du ». Vingt ecritures de caisse
 * donnaient vingt boutons roses, qui pesaient plus que les montants et
 * exposaient la suppression au premier doigt qui passe.
 *
 * Le menu les rassemble, et la confirmation se joue dans la meme bulle : la
 * question remplace la liste, on repond la ou l'on vient de cliquer. Le texte
 * reste a l'encre, y compris pour supprimer -- c'est la question qui protege,
 * pas la couleur.
 */
export function MenuLigne({ etiquette, actions }: { etiquette: string; actions: ActionLigne[] }) {
  const [ouvert, setOuvert] = useState(false);
  const [aConfirmer, setAConfirmer] = useState<ActionLigne | null>(null);
  const boite = useRef<HTMLDivElement>(null);
  const declencheur = useRef<HTMLButtonElement>(null);

  /* Fermer, c'est aussi oublier la question posee : on ne la retrouve pas ouverte. */
  const fermer = () => {
    setOuvert(false);
    setAConfirmer(null);
  };

  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: MouseEvent) => {
      if (!boite.current?.contains(e.target as Node)) fermer();
    };
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        fermer();
        declencheur.current?.focus();
      }
    };
    document.addEventListener("mousedown", dehors);
    document.addEventListener("keydown", touche);
    return () => {
      document.removeEventListener("mousedown", dehors);
      document.removeEventListener("keydown", touche);
    };
  }, [ouvert]);

  if (actions.length === 0) return null;

  return (
    <div ref={boite} className="relative flex-none">
      <button
        ref={declencheur}
        type="button"
        aria-label={etiquette}
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => {
          setAConfirmer(null);
          setOuvert((o) => !o);
        }}
        className="tapable grid h-11 w-11 place-items-center rounded-lg lg:h-8 lg:w-8 lg:rounded-md"
        style={{ color: "var(--ink-2)", background: ouvert ? "var(--sunk)" : undefined }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>

      {ouvert && (
        <div
          role="menu"
          className="menu-ligne absolute top-11 right-0 z-10 w-[270px] p-1.5 lg:top-10 lg:w-[260px]"
          style={{ background: "var(--page)", borderRadius: 12, boxShadow: "var(--pop)" }}
        >
          {aConfirmer ? (
            <Confirmation
              action={aConfirmer}
              surAnnuler={() => setAConfirmer(null)}
              surFin={fermer}
            />
          ) : (
            actions.map((a) => (
              <Element
                key={a.libelle}
                action={a}
                surChoix={() => (a.confirmation ? setAConfirmer(a) : undefined)}
                surFin={fermer}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Une entree du menu : un bouton si elle demande confirmation, sinon un envoi. */
function Element({
  action,
  surChoix,
  surFin,
}: {
  action: ActionLigne;
  surChoix: () => void;
  surFin: () => void;
}) {
  const classe =
    "tapable flex h-11 w-full items-center rounded-lg px-3 text-left text-[14px] lg:h-9 lg:text-[13px]";

  if (action.confirmation) {
    return (
      <button type="button" onClick={surChoix} className={classe} style={{ color: "var(--ink)" }}>
        {action.libelle}
      </button>
    );
  }
  return (
    <FormulaireMenu action={action} surFin={surFin}>
      <button type="submit" className={classe} style={{ color: "var(--ink)" }}>
        {action.libelle}
      </button>
    </FormulaireMenu>
  );
}

function Confirmation({
  action,
  surAnnuler,
  surFin,
}: {
  action: ActionLigne;
  surAnnuler: () => void;
  surFin: () => void;
}) {
  return (
    <div className="p-1.5">
      <p className="mb-3 text-[13px] leading-snug">{action.confirmation}</p>
      <FormulaireMenu action={action} surFin={surFin}>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={surAnnuler}
            className="tapable h-11 rounded-lg text-[14px] font-medium lg:h-8 lg:text-[13px]"
            style={styleBouton("secondaire")}
          >
            Annuler
          </button>
          <button
            type="submit"
            className="tapable h-11 rounded-lg text-[14px] font-medium lg:h-8 lg:text-[13px]"
            style={styleBouton("principal")}
          >
            {action.confirmer ?? "Confirmer"}
          </button>
        </div>
      </FormulaireMenu>
    </div>
  );
}

function FormulaireMenu({
  action,
  surFin,
  children,
}: {
  action: ActionLigne;
  surFin: () => void;
  children: ReactNode;
}) {
  const [etat, envoyer] = useActionState(action.action, { ok: false } as EtatFormulaire);

  /* La ligne disparait ou change : le menu n'a plus lieu d'etre ouvert. */
  useEffect(() => {
    if (etat.ok) surFin();
  }, [etat.ok, surFin]);

  return (
    <form action={envoyer}>
      {action.champs}
      {children}
      {etat.erreur && (
        <p className="px-3 pt-2 text-[12px]" style={{ color: "var(--etat-manque)" }}>
          {etat.erreur}
        </p>
      )}
    </form>
  );
}
