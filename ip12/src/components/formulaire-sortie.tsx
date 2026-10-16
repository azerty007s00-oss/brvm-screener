"use client";

import { useActionState, useState, type ReactNode } from "react";
import {
  enregistrerSortie,
  envoyerValorisation,
  type EtatSortie,
  type SaisieRachat,
} from "@/app/actions/administration";
import type { EtatFormulaire } from "@/app/actions/auth";
import { Champ, Depliant, Selection } from "@/components/formulaires";
import { Alerte } from "@/components/ui";
import { dateCourte } from "@/lib/settings";

const ETAT_INITIAL: EtatSortie = { ok: false };

/**
 * La sortie d'un membre, en deux temps : valoriser et verifier, puis enregistrer.
 *
 * Le premier envoi n'enregistre rien. Il montre la valeur de la part du sortant
 * et les reperes de prix pour un rachat, ce que le calcul utilisera a la date de
 * sortie (releve, versements et caisse en attente, penalites) et, si des membres
 * rachetent, qui paie quoi. Le bureau peut s'arreter la, en parler aux membres,
 * et revenir ; ou confirmer que tout est a jour et enregistrer. Changer de
 * membre, de date ou d'acheteurs apres la verification la fait oublier : ce qui
 * a ete verifie ne vaut que pour ce qui a ete montre.
 *
 * Les champs sont rendus par le serveur a chaque etape (`valeurs`) et le
 * formulaire est remonte avec eux : sans quoi React le viderait apres chaque
 * envoi, et le motif tape serait a ressaisir pour confirmer.
 */
export function FormulaireSortie({
  membres,
  personnes,
  aujourdhui,
  rachatsPossibles,
}: {
  /** Qui peut sortir : les personnes, et les parts rachetees. */
  membres: { valeur: string; libelle: string }[];
  /** Qui peut racheter : les personnes seulement. */
  personnes: { valeur: string; libelle: string }[];
  aujourdhui: string;
  /** Faux tant que la table des rachats n'existe pas en base. */
  rachatsPossibles: boolean;
}) {
  const [etat, envoyer, enCours] = useActionState(enregistrerSortie, ETAT_INITIAL);
  const [suivi, setSuivi] = useState({ etat, tour: 0, modifie: false });
  if (suivi.etat !== etat) setSuivi({ etat, tour: suivi.tour + 1, modifie: false });

  const v = etat.ok ? undefined : etat.valeurs;
  const verif = !suivi.modifie && !etat.ok ? (etat.aVerifier ?? null) : null;
  const invalider = () => {
    if (!suivi.modifie) setSuivi({ ...suivi, modifie: true });
  };

  return (
    <>
    <form
      key={suivi.tour}
      action={envoyer}
      onChange={(e) => {
        const nom = (e.target as unknown as { name?: string }).name;
        if (nom && ["membre", "date", "acheteur", "pourcentage", "prix"].includes(nom)) invalider();
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

      <Acheteurs
        membres={personnes}
        initiaux={v?.rachats ?? []}
        possibles={rachatsPossibles}
        onModifie={invalider}
      />

      {verif && (
        <div className="mt-4 space-y-3">
          <Encadre titre={`Valeur de la part de ${verif.nom} au ${dateCourte(verif.date)}`}>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px]">
              {verif.valorisation.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {/*
              * LE DETAIL DU CALCUL, dans les termes memes des courriers : le
              * sortant peut contester la valeur de sa part, et le bureau doit
              * pouvoir la lui expliquer ligne a ligne.
              */}
            <div className="mt-2 -ml-2.5">
              <Depliant titre="Voir le détail du calcul">
                <Detail lignes={verif.detail} />
              </Depliant>
            </div>
            <p className="mt-2 text-[12px]" style={{ color: "var(--ink-3)" }}>
              Rien n&apos;est enregistré à cette étape : vous pouvez vous arrêter ici, envoyer
              cette valorisation au sortant pour qu&apos;il la vérifie, en parler aux membres, et
              revenir déclarer la sortie avec ou sans acheteurs.
            </p>
          </Encadre>

          {verif.partage.length > 0 && (
            <Encadre titre="Qui paie quoi">
              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px]">
                {verif.partage.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </Encadre>
          )}

          <Alerte ton="ambre" titre="À vérifier avant d'enregistrer">
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
            : "Valoriser et vérifier, sans rien enregistrer"}
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
    {verif && <EnvoiValorisation key={`${verif.membre}|${verif.date}`} membre={verif.membre} date={verif.date} nom={verif.nom} />}
    </>
  );
}

function Encadre({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--line-2)", color: "var(--ink)" }}>
      <p className="font-semibold">{titre}</p>
      {children}
    </div>
  );
}

/**
 * Les membres qui rachetent les parts du sortant : aucun, un ou plusieurs.
 *
 * Chaque ligne porte trois champs de meme nom (`acheteur`, `pourcentage`,
 * `prix`) : l'action les relit dans l'ordre. Une ligne ajoutee ou retiree fait
 * oublier la verification, comme un champ modifie.
 */
function Acheteurs({
  membres,
  initiaux,
  possibles,
  onModifie,
}: {
  membres: { valeur: string; libelle: string }[];
  initiaux: SaisieRachat[];
  possibles: boolean;
  onModifie: () => void;
}) {
  const [lignes, setLignes] = useState(() => initiaux.map((r, i) => ({ cle: i, ...r })));
  const [suivante, setSuivante] = useState(initiaux.length);

  if (!possibles) {
    return (
      <p className="mt-4 text-[12px]" style={{ color: "var(--ink-3)" }}>
        Le rachat des parts par des membres sera possible après la mise à jour de la base
        (scripts/migration-rachats.sql, à exécuter une fois dans Neon). En attendant, le club
        rachète tout.
      </p>
    );
  }

  return (
    <fieldset className="mt-5">
      <legend className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>
        Rachat par des membres (facultatif)
      </legend>
      <p className="mt-1 text-[12px]" style={{ color: "var(--ink-3)" }}>
        Laissez vide si le club rachète tout. Chaque acheteur indique la part qu&apos;il rachète,
        en pourcentage, et le prix convenu avec le sortant ; le club rachète le reste. Ce
        qu&apos;il rachète devient chez lui une part distincte de la sienne, qui cotise à
        proportion de sa taille, avec ses propres retards et pénalités.
      </p>
      {lignes.map((l) => (
        <div
          key={l.cle}
          className="mt-3 rounded-lg border p-3"
          style={{ borderColor: "var(--line-2)" }}
        >
          <Selection
            nom="acheteur"
            libelle="Acheteur"
            options={[{ valeur: "", libelle: "Choisir un membre" }, ...membres]}
            valeur={l.membre}
          />
          <Champ
            nom="pourcentage"
            libelle="Part des parts rachetée (%)"
            valeur={l.pourcentage}
            inputMode="decimal"
            placeholder="100"
          />
          <Champ nom="prix" libelle="Prix convenu (FCFA)" valeur={l.prix} inputMode="numeric" />
          <button
            type="button"
            className="tapable mt-2 text-[13px] underline"
            style={{ color: "var(--ink-2)" }}
            onClick={() => {
              setLignes(lignes.filter((x) => x.cle !== l.cle));
              onModifie();
            }}
          >
            Retirer cet acheteur
          </button>
        </div>
      ))}
      <button
        type="button"
        className="tapable mt-3 inline-flex h-11 items-center rounded-lg border px-3.5 text-[13px] lg:h-9"
        style={{ borderColor: "var(--line-2)", color: "var(--ink)" }}
        onClick={() => {
          setLignes([...lignes, { cle: suivante, membre: "", pourcentage: "", prix: "" }]);
          setSuivante(suivante + 1);
          onModifie();
        }}
      >
        + Ajouter un acheteur
      </button>
    </fieldset>
  );
}

/** Le detail du calcul, rendu comme dans les courriers : titres, lignes, totaux. */
function Detail({ lignes }: { lignes: string[] }) {
  return (
    <div className="space-y-1.5 text-[13px]" style={{ color: "var(--ink)" }}>
      {lignes
        .filter((l) => l.trim() !== "")
        .map((l, i) =>
          /^\d+\. /.test(l) ? (
            <p key={i} className="pt-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>
              {l}
            </p>
          ) : l.startsWith("  - ") ? (
            <p key={i} className="pl-3">
              {"\u2022 "}
              {l.slice(4)}
            </p>
          ) : (
            <p key={i}>{l}</p>
          ),
        )}
    </div>
  );
}

const ENVOI_INITIAL: EtatFormulaire = { ok: false };

/**
 * Envoie la valorisation au sortant, tous les membres en copie, sans rien
 * enregistrer : il peut la verifier et la contester avant que sa sortie soit
 * actee. Un formulaire a part, hors de celui de la sortie : l'envoyer ne doit
 * jamais l'enregistrer.
 */
function EnvoiValorisation({ membre, date, nom }: { membre: string; date: string; nom: string }) {
  const [etat, envoyer, enCours] = useActionState(envoyerValorisation, ENVOI_INITIAL);
  return (
    <form
      action={envoyer}
      className="mt-3"
      onSubmit={(e) => {
        if (
          !window.confirm(
            `Envoyer à ${nom} la valeur de sa part et le détail du calcul ? Tous les membres sont en copie. Rien n'est enregistré.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="membre" value={membre} />
      <input type="hidden" name="date" value={date} />
      <button
        type="submit"
        disabled={enCours}
        className="tapable inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border px-3.5 text-[14px] font-medium transition disabled:opacity-60 lg:h-9 lg:rounded-lg lg:text-[13px]"
        style={{ background: "var(--page)", color: "var(--ink)", borderColor: "var(--line-2)" }}
      >
        {enCours && <span className="rouet" aria-hidden="true" />}
        {enCours ? "Envoi en cours" : `Envoyer cette valorisation à ${nom}, tous les membres en copie`}
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
