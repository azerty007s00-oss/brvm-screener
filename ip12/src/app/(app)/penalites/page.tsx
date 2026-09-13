import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerMembres, listerPenalites, situationsClub } from "@/lib/queries";
import {
  ajouterPenalite,
  annulerPenalite,
  constaterPenalitesRetard,
  reglerPenalite,
} from "@/app/actions/penalites";
import { REGLES, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { KIND_PENALITE, STATUT_PENALITE } from "@/lib/valeurs";
import { Champ, ChampCache, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Alerte, Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

const LIBELLE_NATURE: Record<string, string> = {
  [KIND_PENALITE.retard]: "Retard de versement",
  [KIND_PENALITE.absence]: "Absence en reunion",
  [KIND_PENALITE.autre]: "Autre",
};

export default async function PagePenalites() {
  const membre = await exigerMembre();
  const gere = peut(membre, "gererPenalites");

  let penalites, membres, situations;
  try {
    [penalites, membres, situations] = await Promise.all([
      listerPenalites(gere ? undefined : { membreId: membre.id }),
      listerMembres(),
      situationsClub(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const total = (statut: string) =>
    penalites.filter((p) => p.statut === statut).reduce((s, p) => s + p.montant, 0);

  // Ce que les statuts prevoient et qui n'a pas encore ete porte au registre.
  const dejaConstatees = new Set(penalites.map((p) => p.source_key).filter(Boolean));
  const aConstater = situations.flatMap((s) =>
    s.penalites
      .filter((p) => !dejaConstatees.has(`retard:${s.membreId}:${p.mois}`))
      .map((p) => ({ nom: s.nom, ...p })),
  );

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Statistique libelle="Dues" valeur={fcfa(total(STATUT_PENALITE.due))} accent="rouge" />
        <Statistique libelle="Reglees" valeur={fcfa(total(STATUT_PENALITE.payee))} accent="vert" />
        <Statistique libelle="Annulees" valeur={fcfa(total(STATUT_PENALITE.annulee))} />
      </div>

      {gere && (
        <Carte titre="Constater les retards">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Le site calcule ce que les statuts prevoient ; c&apos;est le bureau qui le porte au
            registre. Cette action est rejouable : une penalite deja reglee ou annulee n&apos;est
            jamais retouchee, seules celles encore dues voient leur montant reajuste si R4 vient a
            s&apos;appliquer.
          </p>
          {aConstater.length === 0 ? (
            <Alerte ton="vert">Le registre est a jour : rien de nouveau a constater.</Alerte>
          ) : (
            <>
              <Alerte ton="ambre" titre={`${aConstater.length} penalite${aConstater.length > 1 ? "s" : ""} a constater`}>
                <ul className="mt-1 space-y-0.5">
                  {aConstater.slice(0, 8).map((p, i) => (
                    <li key={`${p.nom}-${p.mois}-${i}`}>
                      {p.nom} &middot; {moisLong(p.mois)} &middot; {fcfa(p.montant)}
                      {p.doublee ? " (doublee, R4)" : ""}
                    </li>
                  ))}
                  {aConstater.length > 8 && <li>et {aConstater.length - 8} autres…</li>}
                </ul>
              </Alerte>
              <FormulaireAction
                action={constaterPenalitesRetard}
                libelle="Porter au registre"
                confirmation={`Constater ${aConstater.length} penalite(s) de retard ?`}
              />
            </>
          )}
        </Carte>
      )}

      <Carte titre={gere ? `Registre (${penalites.length})` : `Mes penalites (${penalites.length})`}>
        {penalites.length === 0 ? (
          <Vide>Aucune penalite enregistree.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {penalites.map((p) => (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {gere && `${p.membre_nom} · `}
                      {fcfa(p.montant)}
                      {p.quantite > 1 && (
                        <span className="font-normal" style={{ color: "var(--discret)" }}>
                          ({p.quantite} × {fcfa(p.montant_unitaire)})
                        </span>
                      )}
                      <Badge
                        ton={
                          p.statut === STATUT_PENALITE.due
                            ? "rouge"
                            : p.statut === STATUT_PENALITE.payee
                              ? "vert"
                              : "neutre"
                        }
                      >
                        {p.statut === STATUT_PENALITE.due
                          ? "Due"
                          : p.statut === STATUT_PENALITE.payee
                            ? "Reglee"
                            : "Annulee"}
                      </Badge>
                      {!p.auto && <Badge ton="ambre">Saisie</Badge>}
                    </p>
                    <p className="text-xs" style={{ color: "var(--discret)" }}>
                      {LIBELLE_NATURE[p.nature] ?? p.nature} &middot; constatee le{" "}
                      {dateCourte(p.date_constat)}
                      {p.date_reglement ? ` · soldee le ${dateCourte(p.date_reglement)}` : ""}
                    </p>
                    {p.motif && <p className="mt-0.5 text-xs italic">{p.motif}</p>}
                    {p.note_reglement && (
                      <p className="mt-0.5 text-xs italic" style={{ color: "var(--discret)" }}>
                        {p.note_reglement}
                      </p>
                    )}
                  </div>

                  {gere && p.statut === STATUT_PENALITE.due && (
                    <div className="flex flex-wrap items-start gap-2">
                      <FormulaireAction action={reglerPenalite} libelle="Reglee" compact>
                        <ChampCache nom="id" valeur={p.id} />
                      </FormulaireAction>
                      <FormulaireAction
                        action={annulerPenalite}
                        libelle="Annuler"
                        variante="danger"
                        compact
                        confirmation="Annuler cette penalite ?"
                      >
                        <ChampCache nom="id" valeur={p.id} />
                        <input
                          name="motif"
                          placeholder="Motif"
                          required
                          className="mb-1 w-28 rounded border px-2 py-1 text-xs"
                          style={{
                            background: "var(--fond)",
                            borderColor: "var(--bordure)",
                            color: "var(--texte)",
                          }}
                        />
                      </FormulaireAction>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Carte>

      {gere && (
        <Carte titre="Penalite manuelle">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Pour une absence en reunion ou tout motif que le calcul automatique ne couvre pas.
          </p>
          <Depliant titre="Saisir une penalite">
            <FormulaireAction action={ajouterPenalite} libelle="Enregistrer">
              <Selection
                nom="membreId"
                libelle="Membre"
                options={membres.map((m) => ({ valeur: m.id, libelle: m.nom }))}
              />
              <Selection
                nom="nature"
                libelle="Nature"
                valeur={KIND_PENALITE.absence}
                options={Object.entries(LIBELLE_NATURE).map(([valeur, libelle]) => ({
                  valeur,
                  libelle,
                }))}
              />
              <Champ
                nom="montantUnitaire"
                libelle="Montant unitaire (FCFA)"
                type="number"
                min={1}
                valeur={Math.round(REGLES.cotisationMensuelle * REGLES.tauxPenalite)}
              />
              <Champ nom="quantite" libelle="Quantite" type="number" min={1} valeur={1} />
              <Champ
                nom="dateConstat"
                libelle="Date du constat"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Champ nom="motif" libelle="Motif" requis={false} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}
    </>
  );
}
