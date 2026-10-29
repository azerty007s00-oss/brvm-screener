"use client";

import { useState } from "react";
import { avancement, lireMontant } from "@/lib/objectif";
import { fcfa, moisLong, nombre } from "@/lib/settings";
import { Voilable, avecMontants } from "@/components/voilable";

const styleChamp =
  "mt-1.5 h-12 w-full rounded-[10px] border px-3.5 text-[16px] tabular-nums outline-none " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--gold)] focus:border-transparent " +
  "lg:h-10 lg:rounded-lg lg:px-3 lg:text-[14px]";
const couleursChamp = { background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" };

/**
 * Les champs de l'objectif, et ce qu'il demande, calcule pendant la saisie.
 *
 * Le president qui tape « 5 000 000 pour decembre 2027 » voit aussitot ce que
 * cela represente par mois, ce que les cotisations en couvrent, et le
 * rendement que la bourse devra fournir pour le reste -- avant d'afficher un
 * cap intenable sur l'accueil de chacun.
 */
export function ChampsObjectif({
  valeur,
  dateValeur,
  rythme,
  tri,
  aujourdhui,
  montant,
  echeance,
  intitule,
}: {
  valeur: number | null;
  dateValeur: string | null;
  rythme: number;
  tri: number | null;
  aujourdhui: string;
  montant: number | null;
  echeance: string | null;
  intitule: string | null;
}) {
  const [saisieMontant, majMontant] = useState(montant ? nombre(montant) : "");
  const [saisieEcheance, majEcheance] = useState(echeance ? echeance.slice(0, 7) : "");

  const cible = lireMontant(saisieMontant);
  const mois = /^\d{4}-\d{2}$/.test(saisieEcheance) ? `${saisieEcheance}-01` : null;
  const apercu =
    cible !== null && mois !== null && valeur !== null && dateValeur !== null && mois > `${aujourdhui.slice(0, 7)}-01` && cible > valeur
      ? avancement({ montant: cible, echeance: mois, intitule: null, fixeLe: aujourdhui, depart: valeur }, valeur, dateValeur, rythme, aujourdhui)
      : null;

  let conclusion = "";
  if (apercu) {
    if (apercu.partBourse === 0) {
      conclusion = `Les cotisations seules y mènent : ${fcfa(apercu.cotisationsSeules)} en ${moisLong(mois!)}.`;
    } else {
      const taux = apercu.tauxRequis ?? 0;
      const tauxTexte = `${(taux * 100).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} %`;
      const comparaison =
        tri === null
          ? ""
          : taux <= tri
            ? `, moins que ce que le club a fait jusqu'ici (${(tri * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % par an)`
            : taux <= tri * 1.25
              ? `, proche de ce que le club a fait jusqu'ici (${(tri * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % par an)`
              : `, nettement plus que ce que le club a fait jusqu'ici (${(tri * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % par an)`;
      conclusion =
        `Les cotisations seules mènent à ${fcfa(apercu.cotisationsSeules)} en ${moisLong(mois!)}. ` +
        `Le reste, ${fcfa(apercu.partBourse)}, doit venir de la bourse : environ ${tauxTexte} par an${comparaison}.`;
    }
  }

  return (
    <>
      <label className="block">
        <span className="text-[13px] font-medium">Montant visé (FCFA)</span>
        <input
          name="montant"
          inputMode="numeric"
          autoComplete="off"
          required
          value={saisieMontant}
          onChange={(e) => majMontant(e.target.value)}
          onBlur={() => {
            const n = lireMontant(saisieMontant);
            if (n !== null) majMontant(nombre(n));
          }}
          placeholder="5 000 000"
          className={styleChamp}
          style={couleursChamp}
        />
      </label>
      <label className="mt-3 block">
        <span className="text-[13px] font-medium">À atteindre pour</span>
        <input
          name="echeance"
          type="month"
          required
          value={saisieEcheance}
          onChange={(e) => majEcheance(e.target.value)}
          min={aujourdhui.slice(0, 7)}
          placeholder="2027-12"
          className={styleChamp}
          style={couleursChamp}
        />
      </label>
      <label className="mt-3 block">
        <span className="text-[13px] font-medium">
          Intitulé <span className="font-normal" style={{ color: "var(--ink-3)" }}>(facultatif)</span>
        </span>
        <input
          name="intitule"
          maxLength={60}
          defaultValue={intitule ?? ""}
          placeholder="5 millions fin 2027"
          className={styleChamp}
          style={couleursChamp}
        />
      </label>

      {apercu && (
        <div className="mt-4 flex flex-col gap-2.5 rounded-xl p-3.5" style={{ background: "var(--sunk)" }} aria-live="polite">
          <p className="text-[13px] font-semibold">Ce que cela demande</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[18px] font-medium tabular-nums">
                <Voilable>{nombre(apercu.parMois)}</Voilable>
              </p>
              <p className="mt-1 text-[12px]" style={{ color: "var(--ink-2)" }}>
                FCFA à gagner par mois, pendant {apercu.moisRestants} mois
              </p>
            </div>
            <div>
              <p className="text-[18px] font-medium tabular-nums">
                <Voilable>{nombre(rythme)}</Voilable>
              </p>
              <p className="mt-1 text-[12px]" style={{ color: "var(--ink-2)" }}>
                FCFA par mois apportés par les cotisations
              </p>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            {avecMontants(conclusion)}
          </p>
        </div>
      )}
      {cible !== null && valeur !== null && cible <= valeur && (
        <p className="mt-3 text-[12.5px]" style={{ color: "var(--etat-attente)" }}>
          {avecMontants(`Le portefeuille vaut déjà ${fcfa(valeur)} au dernier relevé : visez plus haut.`)}
        </p>
      )}
    </>
  );
}
