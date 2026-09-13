import { exigerMembre } from "@/lib/auth";
import { listerMembres, situationsClub, versementsEnAttente } from "@/lib/queries";
import { REGLES, dateCourte, debutMois, fcfa, moisLong } from "@/lib/settings";
import {
  declarerRetard,
  declarerVersement,
  rejeterVersement,
  validerVersement,
} from "@/app/actions/versements";
import { ChampJustificatif } from "@/components/justificatif";
import { justificatifsParLot } from "@/lib/justificatifs";
import { peut } from "@/lib/droits";
import { Champ, ChampCache, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Badge, Carte, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";
import type { StatutMois } from "@/lib/penalites";
import { MODES_AFFICHES, libelleMode } from "@/lib/valeurs";

export const dynamic = "force-dynamic";

const PASTILLE: Record<StatutMois, { ton: string; fond: string; texte: string }> = {
  paye: { ton: "Paye", fond: "var(--color-vert-100)", texte: "var(--color-vert-600)" },
  paye_en_retard: {
    ton: "Paye en retard",
    fond: "var(--color-or-200)",
    texte: "var(--color-or-600)",
  },
  en_attente: { ton: "En attente", fond: "var(--color-ambre-100)", texte: "var(--color-ambre-600)" },
  retard: { ton: "Retard", fond: "var(--color-rouge-100)", texte: "var(--color-rouge-600)" },
  a_venir: { ton: "A venir", fond: "var(--color-brun-100)", texte: "var(--color-brun-600)" },
  hors_periode: { ton: "-", fond: "transparent", texte: "var(--discret)" },
};

export default async function PageVersements() {
  const membre = await exigerMembre();

  let situations, enAttente, membres, pieces;
  try {
    [situations, enAttente, membres, pieces] = await Promise.all([
      situationsClub(),
      versementsEnAttente(),
      listerMembres(),
      justificatifsParLot(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const peutValider = peut(membre, "validerVersement");
  const saisieDirecte = peut(membre, "saisirVersementValide");
  // Les 14 derniers mois : au-dela, la grille devient illisible sur telephone.
  const moisAffiches = (situations[0]?.cellules ?? []).slice(-14);
  const maSituation = situations.find((s) => s.membreId === membre.id);
  const aujourdhui = debutMois();

  return (
    <>
      <Carte titre={saisieDirecte ? "Enregistrer un versement" : "Declarer un versement"}>
        <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
          {saisieDirecte
            ? "Votre saisie vaut validation : vous constatez un encaissement, pour vous ou pour un autre membre."
            : "Votre declaration est visible de tous immediatement, et reste en attente jusqu'a la validation du tresorier qui tient la caisse."}
        </p>
        <FormulaireAction action={declarerVersement} libelle="Declarer">
          {saisieDirecte && (
            <Selection
              nom="membreId"
              libelle="Pour le compte de"
              valeur={String(membre.id)}
              options={membres.map((m) => ({ valeur: String(m.id), libelle: m.nom }))}
            />
          )}
          <Champ nom="moisDebut" libelle="Premier mois couvert" type="month" valeur={aujourdhui.slice(0, 7)} />
          <Champ
            nom="nbMois"
            libelle="Nombre de mois"
            type="number"
            valeur={1}
            min={1}
            max={24}
            aide="Une avance de plusieurs mois cree une ligne par mois couvert."
          />
          <Champ
            nom="montant"
            libelle="Montant par mois (FCFA)"
            type="number"
            valeur={REGLES.cotisationMensuelle}
            min={1}
          />
          <Champ nom="dateVersement" libelle="Date du versement" type="date" valeur={new Date().toISOString().slice(0, 10)} />
          <Selection nom="mode" libelle="Mode" options={MODES_AFFICHES} />
          <Champ nom="reference" libelle="Reference du paiement (facultatif)" requis={false} />
          <Champ nom="note" libelle="Note (facultatif)" requis={false} />
          <ChampJustificatif />
        </FormulaireAction>
      </Carte>

      {peutValider && (
        <Carte titre={`En attente de validation (${enAttente.length})`}>
          {enAttente.length === 0 ? (
            <Vide>Rien a valider.</Vide>
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
              {enAttente.map((v) => (
                <li key={v.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">
                        {v.membre_nom} &middot; {fcfa(v.montant)}
                      </p>
                      <p className="text-xs" style={{ color: "var(--discret)" }}>
                        {moisLong(v.mois)} &middot; verse le {dateCourte(v.date_versement)} &middot;{" "}
                        {libelleMode(v.mode)}
                        {v.saisi_par_nom && v.saisi_par_nom !== v.membre_nom
                          ? ` · saisi par ${v.saisi_par_nom}`
                          : ""}
                      </p>
                      {v.note && (
                        <p className="mt-1 text-xs italic" style={{ color: "var(--discret)" }}>
                          {v.note}
                        </p>
                      )}
                      <div className="mt-1">
                        {(pieces.get(v.lot) ?? []).length > 0 ? (
                          <span className="flex flex-wrap gap-2">
                            {(pieces.get(v.lot) ?? []).map((j) => (
                              <a
                                key={j.id}
                                href={`/api/justificatif/${j.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center rounded px-2 py-0.5 text-xs underline"
                                style={{ background: "var(--color-vert-100)", color: "var(--color-vert-600)" }}
                              >
                                {j.mime === "application/pdf" ? "Bordereau PDF" : "Voir le recu"}
                              </a>
                            ))}
                          </span>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--color-ambre-600)" }}>
                            Aucun justificatif joint — a verifier avant de valider.
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      <FormulaireAction action={validerVersement} libelle="Valider" compact>
                        <ChampCache nom="id" valeur={v.id} />
                      </FormulaireAction>
                      <FormulaireAction
                        action={rejeterVersement}
                        libelle="Rejeter"
                        variante="danger"
                        compact
                        confirmation="Rejeter ce versement ? Le mois redeviendra disponible."
                      >
                        <ChampCache nom="id" valeur={v.id} />
                        <input
                          name="motif"
                          placeholder="Motif"
                          required
                          className="mb-1 w-28 rounded border px-2 py-1 text-xs"
                          style={{ background: "var(--fond)", borderColor: "var(--bordure)", color: "var(--texte)" }}
                        />
                      </FormulaireAction>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Carte>
      )}

      <Carte titre="Etat des versements">
        <div className="defilement-x -mx-1 px-1">
          <table className="w-full min-w-[640px] border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-[1] pb-2 pr-3 text-left font-semibold" style={{ background: "var(--carte)" }}>
                  Membre
                </th>
                {moisAffiches.map((c) => (
                  <th key={c.mois} className="pb-2 text-center font-medium" style={{ color: "var(--discret)" }}>
                    {moisLong(c.mois).slice(0, 3)}
                    <br />
                    <span className="opacity-60">{c.mois.slice(2, 4)}</span>
                  </th>
                ))}
                <th className="pb-2 pl-3 text-right font-semibold">Verse</th>
              </tr>
            </thead>
            <tbody>
              {situations.map((s) => (
                <tr key={s.membreId} className="border-t" style={{ borderColor: "var(--bordure)" }}>
                  <td
                    className="sticky left-0 z-[1] py-2 pr-3 font-medium whitespace-nowrap"
                    style={{ background: "var(--carte)" }}
                  >
                    {s.nom}
                    {s.nbMoisRetard > 0 && (
                      <span className="ml-1.5">
                        <Badge ton="rouge">{s.nbMoisRetard}</Badge>
                      </span>
                    )}
                  </td>
                  {s.cellules.slice(-14).map((c) => (
                    <td key={c.mois} className="py-2 text-center">
                      <span
                        title={`${moisLong(c.mois)} — ${PASTILLE[c.statut].ton}`}
                        className="inline-block h-5 w-5 rounded"
                        style={{ background: PASTILLE[c.statut].fond }}
                      />
                    </td>
                  ))}
                  <td className="py-2 pl-3 text-right font-semibold whitespace-nowrap">{fcfa(s.verse)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[11px]" style={{ color: "var(--discret)" }}>
          {(["paye", "paye_en_retard", "en_attente", "retard", "a_venir"] as StatutMois[]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded" style={{ background: PASTILLE[k].fond }} />
              {PASTILLE[k].ton}
            </span>
          ))}
        </div>
      </Carte>

      {maSituation && maSituation.moisEnRetard.length > 0 && (
        <Carte titre="Declarer un retard (R3)">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            La resolution R3 impose de signaler son retard sur le groupe WhatsApp, en taguant tous les
            membres, au plus tard le lendemain de l&apos;entree dans le 2e mois. Enregistrez ici la
            declaration faite : elle preserve votre droit au plan de redressement prevu par R5.
          </p>
          <Depliant titre="Enregistrer ma declaration">
            <FormulaireAction action={declarerRetard} libelle="Enregistrer la declaration">
              <Selection
                nom="mois"
                libelle="Mois concerne"
                options={maSituation.moisEnRetard.map((m) => ({ valeur: m, libelle: moisLong(m) }))}
              />
              <Champ nom="note" libelle="Precision (facultatif)" requis={false} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}
    </>
  );
}
