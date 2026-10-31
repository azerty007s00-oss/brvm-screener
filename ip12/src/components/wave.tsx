"use client";

import { useActionState, useState, useSyncExternalStore } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";
import { declarerPaiementWave, enregistrerMonNumeroWave } from "@/app/actions/wave";
import { appareilDe, lienOuvrirWave } from "@/lib/wave";
import { Voilable } from "@/components/voilable";

const ETAT_INITIAL: EtatFormulaire = { ok: false };

const styleChamp =
  "mt-1.5 h-12 w-full rounded-[10px] border px-3.5 text-[16px] tabular-nums tracking-wide outline-none " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--gold)] focus:border-transparent " +
  "lg:h-10 lg:rounded-lg lg:px-3 lg:text-[14px]";
const couleursChamp = { background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" };

/* Le bleu de Wave, pour que le bouton se reconnaisse ; l'encre sombre garde le contraste. */
const BLEU_WAVE = { fond: "#1dc8ff", encre: "#06283a", pastille: "#e1f2fb", pastilleEncre: "#0f5f86" };

function Retour({ etat }: { etat: EtatFormulaire }) {
  if (etat.erreur) {
    return (
      <p className="mt-2 text-[13px]" style={{ color: "var(--etat-manque)" }}>
        {etat.erreur}
      </p>
    );
  }
  if (etat.ok && etat.message) {
    return (
      <p className="mt-2 text-[13px]" role="status" style={{ color: "var(--etat-paye)" }}>
        {etat.message}
      </p>
    );
  }
  return null;
}

const sansAbonnement = () => () => {};

async function copier(texte: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texte);
    return true;
  } catch {
    return false;
  }
}

/**
 * Payer sa cotisation par Wave : le numero du club a copier, Wave a ouvrir,
 * puis « J'ai paye », deja rempli.
 */
export function PayerWave({
  montant,
  moisLibelle,
  deMoisLibelle,
  echeance,
  numeroClub,
  numeroCopie,
  titulaire,
  numeroMembre,
}: {
  montant: number;
  /** « novembre 2026 ». */
  moisLibelle: string;
  /** « de novembre 2026 », « d'octobre 2026 ». */
  deMoisLibelle: string;
  /** « À envoyer avant le 10/11, dans 11 jours. » */
  echeance: string;
  /** « +225 07 58 10 19 89 ». */
  numeroClub: string;
  /** Ce qui se colle dans Wave : « 0758101989 ». */
  numeroCopie: string;
  /** « au nom du trésorier, TRAORÉ Awa ». */
  titulaire: string;
  /** Le numero Wave du membre, en clair, ou "". */
  numeroMembre: string;
}) {
  const [etat, envoyer, enCours] = useActionState(declarerPaiementWave, ETAT_INITIAL);
  const [copie, majCopie] = useState<"non" | "oui" | "refus">("non");
  const [ouvert, majOuvert] = useState(false);
  /* L'appareil ne se connait qu'au navigateur : rien au serveur, le bouton s'y adapte apres l'hydratation. */
  const appareil = useSyncExternalStore(sansAbonnement, () => appareilDe(navigator.userAgent), () => "autre" as const);
  const lien = lienOuvrirWave(appareil);
  const montantTexte = montant.toLocaleString("fr-FR").replace(/ | /g, " ");

  const copierNumero = async () => majCopie((await copier(numeroCopie)) ? "oui" : "refus");

  return (
    <div>
      <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
        Ma cotisation {deMoisLibelle}
      </p>
      <p className="mt-1 flex items-baseline whitespace-nowrap">
        <span className="text-[40px] font-medium leading-none tracking-tight tabular-nums">
          <Voilable>{montantTexte}</Voilable>
        </span>
        <span className="ml-2.5 text-[16px]" style={{ color: "var(--ink-3)" }}>
          FCFA
        </span>
      </p>
      <p className="mt-1.5 text-[14px]" style={{ color: "var(--ink-2)" }}>
        {echeance}
      </p>

      <div className="mt-5 overflow-hidden rounded-xl border" style={{ borderColor: "var(--line-2)" }}>
        <div className="flex items-center gap-3 p-3.5">
          <span
            className="grid h-10 w-10 flex-none place-items-center rounded-[10px] text-[15px] font-bold"
            style={{ background: BLEU_WAVE.pastille, color: BLEU_WAVE.pastilleEncre }}
            aria-hidden="true"
          >
            W
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
              Le Wave du club
            </p>
            <p className="mt-0.5 whitespace-nowrap text-[16px] font-semibold tabular-nums">{numeroClub}</p>
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--ink-3)" }}>
              {titulaire}
            </p>
          </div>
          <button
            type="button"
            onClick={copierNumero}
            className="tapable h-10 flex-none rounded-lg px-3.5 text-[13.5px] font-semibold"
            style={
              copie === "oui"
                ? { border: "1px solid var(--etat-paye)", color: "var(--etat-paye)", background: "var(--page)" }
                : { border: "1px solid var(--line-2)", color: "var(--ink)", background: "var(--page)" }
            }
          >
            {copie === "oui" ? "Copié" : "Copier"}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-3.5 py-3" style={{ borderColor: "var(--line)", background: "var(--sunk)" }}>
          <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
            Montant exact
          </p>
          <p className="text-[17px] font-semibold tabular-nums">
            <Voilable>{`${montantTexte} F`}</Voilable>
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={async () => {
          await copierNumero();
          majOuvert(true);
          if (lien) window.location.href = lien;
        }}
        className="tapable mt-4 inline-flex h-13 w-full items-center justify-center gap-2.5 rounded-xl text-[15.5px] font-semibold"
        style={{ background: BLEU_WAVE.fond, color: BLEU_WAVE.encre }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4 H20 V10" />
          <path d="M20 4 L11 13" />
          <path d="M18 14 V19 A1 1 0 0 1 17 20 H5 A1 1 0 0 1 4 19 V7 A1 1 0 0 1 5 6 H10" />
        </svg>
        {lien ? "Copier le numéro et ouvrir Wave" : "Copier le numéro"}
      </button>
      {(ouvert || copie === "refus") && (
        <p role="status" className="mt-2 rounded-lg px-3 py-2.5 text-[13.5px] leading-relaxed" style={{ background: "var(--etat-ok-fond)", color: "var(--ink)" }}>
          {copie === "refus"
            ? `Le téléphone a refusé la copie : dans Wave, tapez ${numeroCopie}, puis ${montantTexte}.`
            : `Numéro copié. Dans Wave : Envoyer, collez le numéro, tapez ${montantTexte}.`}
          {appareil === "ios" && " Sur iPhone, Wave s'ouvre depuis sa page de l'App Store : touchez « Ouvrir »."}
        </p>
      )}

      <ol className="mt-5 flex flex-col gap-2.5">
        {[
          lien ? "Le bouton copie le numéro du club et ouvre Wave." : "Le bouton copie le numéro du club.",
          `Dans Wave, envoyez ${montantTexte} F depuis votre numéro habituel.`,
          "Revenez ici et touchez « J'ai payé ». C'est tout.",
        ].map((t, i) => (
          <li key={i} className="flex gap-3 text-[14px] leading-snug">
            <span
              className="grid h-6 w-6 flex-none place-items-center rounded-full text-[12.5px] font-bold"
              style={{ background: "color-mix(in srgb, var(--accent) 12%, var(--page))", color: "var(--accent)" }}
            >
              {i + 1}
            </span>
            <span>{t}</span>
          </li>
        ))}
      </ol>

      <form action={envoyer} className="mt-5 rounded-xl p-3.5" style={{ background: "var(--sunk)" }}>
        <input type="hidden" name="montant" value={montant} />
        <p className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-2)" }}>
          Déjà rempli pour vous
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[14px]">
          <dt style={{ color: "var(--ink-2)" }}>Montant</dt>
          <dd className="font-semibold tabular-nums">
            <Voilable>{`${montantTexte} FCFA`}</Voilable>
          </dd>
          <dt style={{ color: "var(--ink-2)" }}>Mois</dt>
          <dd className="font-semibold">{moisLibelle}</dd>
          <dt style={{ color: "var(--ink-2)" }}>Date</dt>
          <dd className="font-semibold">aujourd&apos;hui</dd>
        </dl>
        <label className="mt-3 block">
          <span className="text-[13px] font-medium">Envoyé depuis le numéro Wave</span>
          <input
            name="depuis"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            defaultValue={numeroMembre}
            placeholder="07 00 00 00 00"
            className={styleChamp}
            style={couleursChamp}
          />
        </label>
        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Pas besoin de capture : le trésorier retrouve votre envoi dans son Wave grâce à ce numéro.
        </p>
        <button
          type="submit"
          disabled={enCours}
          className="tapable mt-3 inline-flex h-13 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-medium disabled:opacity-60 lg:h-10 lg:rounded-lg lg:text-[14px]"
          style={{ background: "var(--ink)", color: "var(--page)" }}
        >
          {enCours && <span className="rouet" aria-hidden="true" />}
          {enCours ? "Envoi en cours" : "J'ai payé"}
        </button>
        <Retour etat={etat} />
      </form>
      <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
        Le versement part en attente chez le trésorier, qui le valide d&apos;un toucher. Vous êtes prévenu dès qu&apos;il est
        validé.
      </p>
    </div>
  );
}

/**
 * Le numero Wave du membre : sur l'accueil tant qu'il manque (avec « Plus
 * tard »), et dans Mon compte pour le corriger.
 */
export function NumeroWave({
  numero,
  repli,
  cleRepos,
}: {
  /** Le numero enregistre, en clair, ou "". */
  numero: string;
  /** A defaut, le telephone de la fiche, propose tel quel. */
  repli: string;
  /** Sur l'accueil : la cle qui retient « Plus tard » sur cet appareil. */
  cleRepos?: string;
}) {
  const [etat, envoyer, enCours] = useActionState(enregistrerMonNumeroWave, ETAT_INITIAL);
  const repose = useSyncExternalStore(
    sansAbonnement,
    () => {
      try {
        return cleRepos ? localStorage.getItem(cleRepos) === "1" : false;
      } catch {
        return false;
      }
    },
    () => false,
  );
  const [plusTard, majPlusTard] = useState(false);
  if (cleRepos && (repose || plusTard)) return null;

  const formulaire = (
    <form action={envoyer}>
      <div className="flex items-center gap-3">
        <span
          className="grid h-10 w-10 flex-none place-items-center rounded-[10px] text-[15px] font-bold"
          style={{ background: BLEU_WAVE.pastille, color: BLEU_WAVE.pastilleEncre }}
          aria-hidden="true"
        >
          W
        </span>
        <p className="text-[14px] leading-snug">
          {numero ? `Vos versements partent de ${numero}.` : "Le numéro d'où partent vos cotisations."}
        </p>
      </div>
      <label className="mt-3 block">
        <span className="text-[13px] font-medium">Votre numéro Wave</span>
        <input
          name="numero"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          defaultValue={numero || repli}
          placeholder="07 00 00 00 00"
          className={styleChamp}
          style={couleursChamp}
        />
      </label>
      {!numero && repli && (
        <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
          Repris de votre fiche. Corrigez-le s&apos;il est différent.
        </p>
      )}
      {!numero && (
        <ul className="mt-3 flex flex-col gap-1.5 text-[13.5px] leading-snug">
          {[
            "Le formulaire « J'ai payé » se remplit tout seul.",
            "Le trésorier reconnaît vos envois dans Wave, sans capture.",
            "Si le club vous reverse de l'argent, il part au bon numéro.",
          ].map((t) => (
            <li key={t} className="flex gap-2.5">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className="mt-px flex-none" fill="none" stroke="var(--etat-paye)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5 L10 17 L19 7" />
              </svg>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={enCours}
          className="tapable inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-xl text-[15px] font-medium disabled:opacity-60 lg:h-10 lg:rounded-lg lg:text-[14px]"
          style={{ background: "var(--accent)", color: "var(--sur-accent)" }}
        >
          {enCours && <span className="rouet" aria-hidden="true" />}
          {enCours ? "Envoi en cours" : "Enregistrer"}
        </button>
        {cleRepos && (
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem(cleRepos, "1");
              } catch {
                // Stockage bloque : la carte revient a la prochaine visite.
              }
              majPlusTard(true);
            }}
            className="tapable inline-flex h-12 items-center justify-center rounded-xl px-4 text-[14px] font-medium lg:h-10 lg:rounded-lg"
            style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
          >
            Plus tard
          </button>
        )}
      </div>
      <p className="mt-2 text-[12px]" style={{ color: "var(--ink-3)" }}>
        Visible du bureau seulement. Modifiable à tout moment dans Mon compte.
      </p>
      <Retour etat={etat} />
    </form>
  );
  if (!cleRepos) return formulaire;
  /* Sur l'accueil, la carte entiere disparait avec « Plus tard » : elle porte donc son propre cadre. */
  return (
    <section className="revele border-t pt-5" style={{ borderColor: "var(--line)" }}>
      <header className="mb-3">
        <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
          Votre numéro Wave
        </h2>
      </header>
      {formulaire}
    </section>
  );
}
