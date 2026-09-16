import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import {
  absencesParMembre,
  avancesExigees,
  listerMembres,
  listerPenalites,
  situationsClub,
} from "@/lib/queries";
import {
  ajouterPenalite,
  annulerPenalite,
  rouvrirPenalite,
  constaterPenalitesAbsence,
  constaterPenalitesRetard,
  reglerPenalite,
} from "@/app/actions/penalites";
import { tranchesAbsence } from "@/lib/penalites";
import { EFFET, REGLES, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { KIND_PENALITE, STATUT_PENALITE } from "@/lib/valeurs";
import {
  Champ,
  ChampCache,
  Depliant,
  FormulaireAction,
  Selection,
} from "@/components/formulaires";
import { Alerte, Badge, Carte, Statistique, Vide } from "@/components/ui";
import {
  EcranInitialisation,
  estTableAbsente,
} from "@/components/initialisation";

export const dynamic = "force-dynamic";

const LIBELLE_NATURE: Record<string, string> = {
  [KIND_PENALITE.retard]: "Retard de versement",
  [KIND_PENALITE.absence]: "Absence en reunion",
  [KIND_PENALITE.autre]: "Autre",
};

export default async function PagePenalites() {
  const membre = await exigerMembre();
  const gere = peut(membre, "gererPenalites");

  let penalites, membres, situations, absences, avances;
  try {
    [penalites, membres, situations, absences, avances] = await Promise.all([
      listerPenalites(gere ? undefined : { membreId: membre.id }),
      listerMembres(),
      situationsClub(),
      absencesParMembre().catch(() => []),
      avancesExigees().catch(() => []),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const total = (statut: string) =>
    penalites
      .filter((p) => p.statut === statut)
      .reduce((s, p) => s + p.montant, 0);

  // Ce que les statuts prevoient et qui n'a pas encore ete porte au registre.
  const dejaConstatees = new Set(
    penalites.map((p) => p.source_key).filter(Boolean),
  );
  const aConstater = situations.flatMap((s) =>
    s.penalites
      .filter((p) => !dejaConstatees.has(`retard:${s.membreId}:${p.mois}`))
      .map((p) => ({ nom: s.nom, ...p })),
  );

  /*
   * Les tranches d'absences que la feuille de presence justifie et que le registre
   * ne porte pas encore. Le rang sert de cle : il rend le rapprochement exact meme
   * quand une tranche ancienne a deja ete reglee.
   */
  const absencesAConstater = absences.flatMap((a) =>
    tranchesAbsence(a.injustifiees, REGLES)
      .filter((t) => !dejaConstatees.has(`absence:${a.membreId}:${t.rang}`))
      .map((t) => ({ nom: a.nom, ...t })),
  );

  /*
   * Les membres que le cumul de penalites expose a l'exclusion. La regle ne mord
   * qu'a sa date d'effet : avant elle, le decompte s'affiche en avertissement.
   */
  const exposes = situations.filter(
    (x) => x.nbPenalitesImpayees >= REGLES.penalitesImpayeesAvantExclusion,
  );
  const regleEnVigueur =
    new Date().toISOString().slice(0, 10) >= EFFET.penalitesIndissociables;
  const dateEffet = EFFET.penalitesIndissociables
    .split("-")
    .reverse()
    .join("/");

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Statistique
          libelle="Dues"
          valeur={fcfa(total(STATUT_PENALITE.due))}
          accent="rouge"
        />
        <Statistique
          libelle="Reglees"
          valeur={fcfa(total(STATUT_PENALITE.payee))}
          accent="vert"
        />
        <Statistique
          libelle="Annulees"
          valeur={fcfa(total(STATUT_PENALITE.annulee))}
        />
      </div>

      {exposes.length > 0 && (
        <Alerte
          ton={regleEnVigueur ? "rouge" : "ambre"}
          titre={
            regleEnVigueur
              ? `${exposes.length} membre(s) exclus de plein droit`
              : `${exposes.length} membre(s) exposes a compter du ${dateEffet}`
          }
        >
          <p>
            Les penalites sont indissociables des cotisations :{" "}
            {REGLES.penalitesImpayeesAvantExclusion} penalites de retard
            impayees emportent l&apos;exclusion (R5), meme si les cotisations
            sont a jour.
            {regleEnVigueur ? "" : ` La regle prend effet le ${dateEffet}.`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {exposes.map((x) => (
              <li key={x.membreId}>
                {x.nom} &middot; {x.nbPenalitesImpayees} penalites impayees
              </li>
            ))}
          </ul>
        </Alerte>
      )}

      {avances.length > 0 && (
        <Carte titre="Avances imposees">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Mesure disciplinaire : le membre doit detenir en permanence
            l&apos;avance indiquee. Elle s&apos;exprime en mois, pour
            qu&apos;une cotisation revue en assemblee ne l&apos;allege pas sans
            qu&apos;on l&apos;ait voulu.
          </p>
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {avances.map((a) => (
              <li
                key={a.membreId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {a.membreNom}
                    <Badge ton={a.respectee ? "vert" : "rouge"}>
                      {a.respectee ? "Respectee" : "Non respectee"}
                    </Badge>
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {a.mois} mois exiges, soit {fcfa(a.montantExige)} &middot;
                    detenu {fcfa(a.avanceDetenue)}
                    {a.fin ? ` · jusqu'au ${dateCourte(a.fin)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Carte>
      )}

      {gere && (
        <Carte titre="Constater les retards">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Le site calcule ce que les statuts prevoient ; c&apos;est le bureau
            qui le porte au registre. Cette action est rejouable : une penalite
            deja reglee ou annulee n&apos;est jamais retouchee, seules celles
            encore dues voient leur montant reajuste si R4 vient a
            s&apos;appliquer.
          </p>
          {aConstater.length === 0 ? (
            <Alerte ton="vert">
              Le registre est a jour : rien de nouveau a constater.
            </Alerte>
          ) : (
            <>
              <Alerte
                ton="ambre"
                titre={`${aConstater.length} penalite${aConstater.length > 1 ? "s" : ""} a constater`}
              >
                <ul className="mt-1 space-y-0.5">
                  {aConstater.slice(0, 8).map((p, i) => (
                    <li key={`${p.nom}-${p.mois}-${i}`}>
                      {p.nom} &middot; {moisLong(p.mois)} &middot;{" "}
                      {fcfa(p.montant)}
                      {p.doublee ? " (doublee, R4)" : ""}
                    </li>
                  ))}
                  {aConstater.length > 8 && (
                    <li>et {aConstater.length - 8} autres…</li>
                  )}
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

      {gere && (
        <Carte titre="Constater les absences">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            {fcfa(REGLES.penaliteAbsence)} par tranche de{" "}
            {REGLES.absencesParTranche} absences injustifiees. Le club
            sanctionne la repetition, non l&apos;empechement ponctuel : une
            absence isolee ne coute rien. Pour en justifier une, le secretaire
            la passe en &laquo;&nbsp;Excuse&nbsp;&raquo; sur la seance, depuis
            la page Reunions — elle sort alors du compte.
          </p>
          {absences.length === 0 ? (
            <Vide>Aucune feuille de presence pointee.</Vide>
          ) : (
            <>
              <ul
                className="mb-3 divide-y text-sm"
                style={{ borderColor: "var(--bordure)" }}
              >
                {absences
                  .filter((a) => a.injustifiees > 0 || a.excusees > 0)
                  .map((a) => (
                    <li
                      key={a.membreId}
                      className="flex justify-between gap-2 py-1.5"
                    >
                      <span>{a.nom}</span>
                      <span style={{ color: "var(--discret)" }}>
                        {a.injustifiees} injustifiee
                        {a.injustifiees > 1 ? "s" : ""}
                        {a.excusees > 0
                          ? ` · ${a.excusees} excusee${a.excusees > 1 ? "s" : ""}`
                          : ""}
                      </span>
                    </li>
                  ))}
              </ul>
              {absencesAConstater.length === 0 ? (
                <Alerte ton="vert">
                  Le registre est a jour : aucune tranche d&apos;absences a
                  porter.
                </Alerte>
              ) : (
                <>
                  <Alerte
                    ton="ambre"
                    titre={`${absencesAConstater.length} tranche${absencesAConstater.length > 1 ? "s" : ""} a constater`}
                  >
                    <ul className="mt-1 space-y-0.5">
                      {absencesAConstater.map((t, i) => (
                        <li key={`${t.nom}-${t.rang}-${i}`}>
                          {t.nom} &middot; tranche {t.rang} (
                          {t.absenceDeclenchante} absences) &middot;{" "}
                          {fcfa(t.montant)}
                        </li>
                      ))}
                    </ul>
                  </Alerte>
                  <FormulaireAction
                    action={constaterPenalitesAbsence}
                    libelle="Porter au registre"
                    confirmation={`Constater ${absencesAConstater.length} penalite(s) d'absence ?`}
                  />
                </>
              )}
            </>
          )}
        </Carte>
      )}

      <Carte
        titre={
          gere
            ? `Registre (${penalites.length})`
            : `Mes penalites (${penalites.length})`
        }
      >
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
                        <span
                          className="font-normal"
                          style={{ color: "var(--discret)" }}
                        >
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
                      {LIBELLE_NATURE[p.nature] ?? p.nature} &middot; constatee
                      le {dateCourte(p.date_constat)}
                      {p.date_reglement
                        ? ` · soldee le ${dateCourte(p.date_reglement)}`
                        : ""}
                    </p>
                    {p.motif && (
                      <p className="mt-0.5 text-xs italic">{p.motif}</p>
                    )}
                    {p.note_reglement && (
                      <p
                        className="mt-0.5 text-xs italic"
                        style={{ color: "var(--discret)" }}
                      >
                        {p.note_reglement}
                      </p>
                    )}
                  </div>

                  {/*
                   * Reprendre un reglement ou une annulation : une erreur de
                   * manipulation ne doit pas rester inscrite pour toujours.
                   */}
                  {gere && p.statut !== STATUT_PENALITE.due && (
                    <FormulaireAction
                      action={rouvrirPenalite}
                      libelle="Remettre en dû"
                      compact
                      confirmation="Remettre cette penalite en dû ?"
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
                  )}

                  {gere && p.statut === STATUT_PENALITE.due && (
                    <div className="flex flex-wrap items-start gap-2">
                      {/*
                       * Le nombre de mois regles, quand la ligne en porte
                       * plusieurs : un retard de onze mois se solde rarement
                       * d'un coup. Laisse vide, tout est regle.
                       */}
                      <FormulaireAction
                        action={reglerPenalite}
                        libelle="Reglee"
                        compact
                      >
                        <ChampCache nom="id" valeur={p.id} />
                        {p.quantite > 1 && (
                          <input
                            name="quantite"
                            type="number"
                            min={1}
                            max={p.quantite}
                            placeholder={`sur ${p.quantite}`}
                            title={`Combien de mois sont regles ? Laissez vide pour les ${p.quantite}.`}
                            className="mb-1 w-20 rounded border px-2 py-1 text-xs"
                            style={{
                              background: "var(--fond)",
                              borderColor: "var(--bordure)",
                              color: "var(--texte)",
                            }}
                          />
                        )}
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
            Pour une absence en reunion ou tout motif que le calcul automatique
            ne couvre pas.
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
                options={Object.entries(LIBELLE_NATURE).map(
                  ([valeur, libelle]) => ({
                    valeur,
                    libelle,
                  }),
                )}
              />
              <Champ
                nom="montantUnitaire"
                libelle="Montant unitaire (FCFA)"
                type="number"
                min={1}
                valeur={Math.round(
                  REGLES.cotisationMensuelle * REGLES.tauxPenalite,
                )}
              />
              <Champ
                nom="quantite"
                libelle="Quantite"
                type="number"
                min={1}
                valeur={1}
              />
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
