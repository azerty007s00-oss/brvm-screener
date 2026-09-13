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

  const styles =
    variante === "principal"
      ? { background: "var(--color-brun-800)", color: "var(--color-or-200)" }
      : variante === "danger"
        ? { background: "var(--color-rouge-100)", color: "var(--color-rouge-600)" }
        : { background: "var(--color-brun-100)", color: "var(--color-brun-800)" };

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
        className={`${compact ? "px-3 py-1.5 text-xs" : "mt-3 w-full px-4 py-2.5 text-sm"} rounded-lg font-medium transition disabled:opacity-50`}
      >
        {enCours ? "..." : libelle}
      </button>
      {etat.erreur && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-rouge-600)" }}>
          {etat.erreur}
        </p>
      )}
      {etat.ok && etat.message && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-vert-600)" }}>
          {etat.message}
        </p>
      )}
    </form>
  );
}

const styleChamp =
  "mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--color-or-400)]";

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
      <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--discret)" }}>
        {libelle}
      </span>
      <input
        name={nom}
        type={type}
        defaultValue={valeur}
        required={requis}
        className={styleChamp}
        style={{ background: "var(--fond)", borderColor: "var(--bordure)", color: "var(--texte)" }}
        {...reste}
      />
      {aide && (
        <span className="mt-1 block text-xs" style={{ color: "var(--discret)" }}>
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
      <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--discret)" }}>
        {libelle}
      </span>
      <select
        name={nom}
        defaultValue={valeur}
        className={styleChamp}
        style={{ background: "var(--fond)", borderColor: "var(--bordure)", color: "var(--texte)" }}
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
        className="cursor-pointer list-none rounded-lg px-3 py-2 text-sm font-medium"
        style={{ background: "var(--color-brun-100)", color: "var(--color-brun-800)" }}
      >
        + {titre}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
