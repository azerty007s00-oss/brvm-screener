"use client";

import { useActionState, useRef, useState } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";

type Action = (etat: EtatFormulaire, donnees: FormData) => Promise<EtatFormulaire>;

const ETAT_INITIAL: EtatFormulaire = { ok: false };
const principal = { background: "var(--accent)", color: "var(--sur-accent)" };
const secondaire = { background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" };
const bouton =
  "tapable inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-3 text-[14px] font-medium transition disabled:opacity-60";

/**
 * Relancer un membre depuis sa ligne du registre : l'historique, puis le message.
 *
 * Le bureau voit d'abord ce qui est deja parti -- les courriers automatiques
 * et les siens, avec leur date -- pour ne pas envoyer un quatrieme rappel la ou
 * un appel s'impose. Les deux boutons ouvrent le meme panneau : le courrier tel
 * que le membre le recevra, a envoyer par courriel ou a copier pour WhatsApp,
 * ou le club se parle.
 */
export function RelanceMembre({
  membreId,
  nom,
  sujet,
  texte,
  historique,
  ceMois,
  du,
  relancer,
}: {
  membreId: string;
  nom: string;
  sujet: string;
  texte: string;
  historique: { date: string; libelle: string; echec: boolean }[];
  /** « 3 en octobre » : ce qui est parti ce mois-ci. */
  ceMois: string | null;
  du: string;
  relancer: Action;
}) {
  const panneau = useRef<HTMLDialogElement>(null);
  const [etat, envoyer, enCours] = useActionState(relancer, ETAT_INITIAL);
  const [copie, marquerCopie] = useState<"non" | "oui" | "refus">("non");
  const messageWhatsApp = `*${sujet}*\n\n${texte}`;

  const ouvrir = () => {
    marquerCopie("non");
    panneau.current?.showModal();
  };
  const fermer = () => panneau.current?.close();
  const copier = async () => {
    try {
      await navigator.clipboard.writeText(messageWhatsApp);
      marquerCopie("oui");
    } catch {
      marquerCopie("refus");
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: "var(--line)" }}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Relances</h3>
        {ceMois && (
          <span className="text-[12px]" style={{ color: "var(--ink-2)" }}>
            {ceMois}
          </span>
        )}
      </div>
      {historique.length === 0 ? (
        <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
          Aucune relance depuis deux mois.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
          {historique.map((h, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-12 flex-none tabular-nums" style={{ color: "var(--ink)" }}>
                {h.date}
              </span>
              <span style={h.echec ? { color: "var(--etat-manque)" } : undefined}>{h.libelle}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-0.5 grid grid-cols-2 gap-2">
        <button type="button" className={bouton} style={secondaire} onClick={ouvrir}>
          Pour WhatsApp
        </button>
        <button type="button" className={bouton} style={principal} onClick={ouvrir}>
          Relancer
        </button>
      </div>
      <p className="text-[12px]" style={{ color: "var(--ink-3)" }}>
        {du}
      </p>

      <dialog
        ref={panneau}
        aria-labelledby={`relance-${membreId}`}
        className="panneau-relance"
        onClick={(e) => {
          // Un toucher hors du panneau le ferme, comme partout ailleurs sur un telephone.
          if (e.target === panneau.current) fermer();
        }}
      >
        <div className="flex flex-col gap-3.5 px-5 pt-2.5 pb-6">
          <span aria-hidden="true" className="mx-auto h-1 w-10 rounded-full lg:hidden" style={{ background: "var(--line-2)" }} />
          <div>
            <h2 id={`relance-${membreId}`} className="text-[17px] font-semibold">
              Relancer {nom}
            </h2>
            <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
              Par courriel, à l&apos;adresse enregistrée. Le bureau en reçoit une copie.
            </p>
          </div>

          <div
            className="max-h-[38vh] overflow-y-auto rounded-xl border p-3.5 text-[13.5px] leading-relaxed"
            style={{ borderColor: "var(--line)", background: "var(--carte)" }}
          >
            <p className="mb-2 text-[12px]" style={{ color: "var(--ink-2)" }}>
              Objet : <span className="font-semibold" style={{ color: "var(--ink)" }}>{sujet}</span>
            </p>
            <p className="whitespace-pre-line">{texte}</p>
          </div>

          <form action={envoyer} className="flex flex-col gap-2">
            <input type="hidden" name="membreId" value={membreId} />
            <label className="flex min-h-11 items-start gap-2.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
              <input
                type="checkbox"
                name="releve"
                defaultChecked
                className="mt-0.5 h-5 w-5 flex-none"
                style={{ accentColor: "var(--accent)" }}
              />
              <span>Joindre le relevé de ses versements (PDF)</span>
            </label>
            {etat.ok && etat.message ? (
              <>
                <p className="text-[13px]" style={{ color: "var(--etat-ok)" }} role="status">
                  {etat.message}
                </p>
                <button type="button" className={bouton} style={secondaire} onClick={fermer}>
                  Fermer
                </button>
              </>
            ) : (
              <button type="submit" className={`${bouton} min-h-12 text-[15px]`} style={principal} disabled={enCours}>
                {enCours && <span className="rouet" aria-hidden="true" />}
                {enCours ? "Envoi en cours" : "Envoyer le courriel"}
              </button>
            )}
            {etat.erreur && (
              <p className="text-[13px]" style={{ color: "var(--etat-manque)" }} role="alert">
                {etat.erreur}
              </p>
            )}
          </form>

          <button type="button" className={`${bouton} min-h-12 text-[15px]`} style={secondaire} onClick={copier}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              aria-hidden="true"
              style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round" }}
            >
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8 V6 A2 2 0 0 0 14 4 H6 A2 2 0 0 0 4 6 V14 A2 2 0 0 0 6 16 H8" />
            </svg>
            {copie === "oui" ? "Message copié" : "Copier le message pour WhatsApp"}
          </button>
          {copie === "oui" && (
            <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
              Collez-le dans la conversation de {nom}, ou{" "}
              <a
                href={`https://wa.me/?text=${encodeURIComponent(messageWhatsApp)}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
                style={{ color: "var(--accent)" }}
              >
                ouvrez WhatsApp avec le message
              </a>
              .
            </p>
          )}
          {copie === "refus" && (
            <p className="text-[12.5px]" style={{ color: "var(--etat-manque)" }}>
              Le navigateur a refusé la copie : sélectionnez le message ci-dessus et copiez-le à la main.
            </p>
          )}
          <button type="button" className="tapable min-h-11 text-[14px]" style={{ color: "var(--ink-2)" }} onClick={fermer}>
            Annuler
          </button>
        </div>
      </dialog>
    </div>
  );
}
