"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";

type Action = (etat: EtatFormulaire, donnees: FormData) => Promise<EtatFormulaire>;

const ETAT_INITIAL: EtatFormulaire = { ok: false };

/**
 * Enveloppe commune a tous les formulaires : etat de soumission, message de retour,
 * bouton desactive pendant l'envoi. Evite de dupliquer useActionState partout.
 */
export function FormulaireAction({
  action,
  libelle,
  children,
  variante = "principal",
  compact = false,
  confirmation,
  className = "",
}: {
  action: Action;
  libelle: string;
  children?: ReactNode;
  variante?: "principal" | "discret" | "danger";
  compact?: boolean;
  confirmation?: string;
  className?: string;
}) {
  const [etat, envoyer, enCours] = useActionState(action, ETAT_INITIAL);

  /*
   * Trois variantes, deux styles, aucune couleur de fond hors l'encre.
   *
   * « discret » rendait un texte couleur --sunk sur un fond --sunk : invisible.
   * La faute vient de la refonte des jetons, qui a fait converger deux bruns
   * distincts vers le meme role ; elle ne se voyait qu'a l'ecran.
   */
  const styles =
    variante === "principal"
      ? { background: "var(--ink)", color: "var(--page)" }
      : variante === "danger"
        ? { background: "var(--page)", color: "var(--etat-manque)", border: "1px solid var(--line-2)" }
        : { background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" };

  return (
    <form
      action={envoyer}
      className={className}
      onSubmit={(e) => {
        if (confirmation && !window.confirm(confirmation)) e.preventDefault();
      }}
    >
      {children}
      <button
        type="submit"
        disabled={enCours}
        style={styles}
        className={`tapable ${compact ? "h-11 px-3.5 text-[13px] lg:h-8" : "mt-4 h-13 w-full text-[15px] lg:h-10 lg:text-[14px]"} inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:opacity-60 lg:rounded-lg`}
      >
        {/*
          * Pendant l'envoi, un anneau qui tourne plutot que trois points fixes :
          * sur une connexion lente, l'attente dure assez longtemps pour qu'un
          * libelle immobile passe pour un bouton casse.
          */}
        {enCours && <span className="rouet" aria-hidden="true" />}
        {enCours ? "Envoi en cours" : libelle}
      </button>
      {etat.erreur && (
        <p className="mt-2 text-xs" style={{ color: "var(--etat-manque)" }}>
          {etat.erreur}
        </p>
      )}
      {etat.ok && etat.message && (
        <p className="mt-2 text-xs" style={{ color: "var(--etat-ok)" }}>
          {etat.message}
        </p>
      )}
    </form>
  );
}

/*
 * 16 px de texte sur telephone : en dessous, iOS agrandit la page a la mise au
 * point du champ, et l'on se retrouve a faire defiler un formulaire zoome.
 */
const styleChamp =
  "mt-1.5 h-12 w-full rounded-[10px] border px-3.5 text-[16px] tabular-nums outline-none " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--gold)] focus:border-transparent " +
  "lg:h-10 lg:rounded-lg lg:px-3 lg:text-[14px]";

export function Champ({
  nom,
  libelle,
  type = "text",
  valeur,
  requis = true,
  aide,
  ...reste
}: {
  nom: string;
  libelle: string;
  type?: string;
  valeur?: string | number;
  requis?: boolean;
  aide?: string;
} & Record<string, unknown>) {
  return (
    <label className="mt-3 block first:mt-0">
      <span className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>
        {libelle}
      </span>
      <input
        name={nom}
        type={type}
        defaultValue={valeur}
        required={requis}
        className={styleChamp}
        style={{ background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" }}
        {...reste}
      />
      {aide && (
        <span className="mt-1.5 block text-[12px]" style={{ color: "var(--ink-3)" }}>
          {aide}
        </span>
      )}
    </label>
  );
}

export function Selection({
  nom,
  libelle,
  options,
  valeur,
}: {
  nom: string;
  libelle: string;
  options: { valeur: string; libelle: string }[];
  valeur?: string;
}) {
  return (
    <label className="mt-3 block first:mt-0">
      <span className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>
        {libelle}
      </span>
      <select
        name={nom}
        defaultValue={valeur}
        className={styleChamp}
        style={{ background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" }}
      >
        {options.map((o) => (
          <option key={o.valeur} value={o.valeur}>
            {o.libelle}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ChampCache({ nom, valeur }: { nom: string; valeur: string | number }) {
  return <input type="hidden" name={nom} value={valeur} />;
}

/** Bloc depliable : garde les formulaires hors du chemin sur petit ecran. */
export function Depliant({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary
        className="tapable flex h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 text-[13px] lg:h-11"
        style={{ color: "var(--ink-2)" }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="chevron flex-none">
          <path d="M9.5 6 L15.5 12 L9.5 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {titre}
      </summary>
      <div className="contenu-depliant pt-1 pb-2 pl-8">{children}</div>
    </details>
  );
}
