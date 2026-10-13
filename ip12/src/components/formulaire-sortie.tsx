"use client";

import { useActionState, useState } from "react";
import { enregistrerSortie, type EtatSortie } from "@/app/actions/administration";
import { Champ, Selection } from "@/components/formulaires";
import { Alerte } from "@/components/ui";
import { dateCourte } from "@/lib/settings";

const ETAT_INITIAL: EtatSortie = { ok: false };

/**
 * La sortie d'un membre, en deux temps : verifier, puis enregistrer.
 *
 * Le premier envoi ne fait que montrer ce que le calcul utilisera a la date de
 * sortie : releve, versements et caisse en attente, penalites. Le bureau
 * confirme que c'est a jour, ou saisit ce qui manque et revient. Changer de
 * membre ou de date apres la verification la fait oublier : ce qui a ete verifie
 * ne vaut que pour ce membre et ce jour.
 *
 * Les champs sont rendus par le serveur a chaque etape (`valeurs`) et le
 * formulaire est remonte avec eux : sans quoi React le viderait apres chaque
 * envoi, et le motif tape serait a ressaisir pour confirmer.
 */
export function FormulaireSortie({
  membres,
  aujourdhui,
}: {
  membres: { valeur: string; libelle: string }[];
  aujourdhui: string;
}) {
  const [etat, envoyer, enCours] = useActionState(enregistrerSortie, ETAT_INITIAL);
  const [suivi, setSuivi] = useState({ etat, tour: 0, modifie: false });
  if (suivi.etat !== etat) setSuivi({ etat, tour: suivi.tour + 1, modifie: false });

  const v = etat.ok ? undefined : etat.valeurs;
  const verif = !suivi.modifie && !etat.ok ? (etat.aVerifier ?? null) : null;

  return (
    <form
      key={suivi.tour}
      action={envoyer}
      onChange={(e) => {
        const nom = (e.target as unknown as { name?: string }).name;
        if ((nom === "membre" || nom === "date") && !suivi.modifie) setSuivi({ ...suivi, modifie: true });
      }}
      onSubmit={(e) => {
        if (
          verif &&
          !window.confirm(
            `Enregistrer la sortie de ${verif.nom} ? Le décompte part aussitôt par courriel à tous les membres.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <Selection nom="membre" libelle="Membre sortant" options={membres} valeur={v?.membre} />
      <Champ nom="date" libelle="Date de sortie" type="date" valeur={v?.date ?? aujourdhui} max={aujourdhui} />
      <Champ
        nom="motif"
        libelle="Motif"
        valeur={v?.motif}
        aide="Démission, exclusion prononcée au vote, exclusion de plein droit (R5)… Le sortant et tous les membres le liront."
      />
      <Champ nom="note" libelle="Référence de la décision" requis={false} valeur={v?.note} />

      {verif && (
        <div className="mt-4">
          <Alerte ton="ambre" titre={`À vérifier avant la sortie de ${verif.nom} au ${dateCourte(verif.date)}`}>
            <p className="text-[13px]">
              Le calcul utilisera ces données. Si l&apos;une n&apos;est pas à jour, saisissez-la
              d&apos;abord, puis déclarez à nouveau la sortie.
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px]">
              {verif.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alerte>
          <input type="hidden" name="confirme" value={verif.empreinte} />
        </div>
      )}

      <button
        type="submit"
        disabled={enCours}
        style={{ background: "var(--ink)", color: "var(--page)" }}
        className="tapable mt-4 inline-flex h-13 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-medium transition disabled:opacity-60 lg:h-10 lg:rounded-lg lg:text-[14px]"
      >
        {enCours && <span className="rouet" aria-hidden="true" />}
        {enCours
          ? "Envoi en cours"
          : verif
            ? "Tout est à jour : enregistrer la sortie"
            : "Vérifier les données avant d'enregistrer"}
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
