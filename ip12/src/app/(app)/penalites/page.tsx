import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import {
  absencesParMembre,
  avancesExigees,
  bornesReprisePenalites,
  listerMembres,
  listerPenalites,
  plansDejaAccordes,
  reglementsPenalite,
  situationsClub,
} from "@/lib/queries";
import {
  ajouterPenalite,
  annulerPenalite,
  rouvrirPenalite,
  constaterPenalitesAbsence,
  constaterPenalitesRetard,
  reglerPenalite,
  rejeterReglementPenalite,
  validerReglementPenalite,
} from "@/app/actions/penalites";
import { dejaAuRegistre, issueR5, tranchesAbsence } from "@/lib/penalites";
import { EFFET, REGLES, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { KIND_PENALITE, STATUT_PENALITE, STATUT_REGLEMENT, libelleMode } from "@/lib/valeurs";
import {
  Champ,
  ChampCache,
  FormulaireAction,
  Selection,
} from "@/components/formulaires";
import { justificatifsParLot } from "@/lib/justificatifs";
import { Alerte, Badge, Carte, CarteEtat, EnTeteEcran, Vide } from "@/components/ui";
import { Panneau } from "@/components/panneau";
import { ChampMenu, MenuLigne } from "@/components/menu-ligne";
import { LienBouton } from "@/components/boutons";
import {
  EcranInitialisation,
  estTableAbsente,
} from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pénalités" };

/** Ce que R5 emporte, en trois mots, avant le detail. */
const LIBELLE_VOIE: Record<string, string> = {
  exclusion_plein_droit: "Exclusion de plein droit",
  plan_redressement: "Plan de redressement",
  vote_art20: "Vote de l'assemblée (art. 20)",
};

const LIBELLE_NATURE: Record<string, string> = {
  [KIND_PENALITE.retard]: "Retard de versement",
  [KIND_PENALITE.absence]: "Absence en réunion",
  [KIND_PENALITE.autre]: "Autre",
};

export default async function PagePenalites() {
  const membre = await exigerMembre();
  const gere = peut(membre, "gererPenalites");

  let penalites, membres, situations, absences, avances, bornes, declarations, pieces,
    plansUtilises;
  try {
    [penalites, membres, situations, absences, avances, bornes, declarations, pieces,
      plansUtilises] =
      await Promise.all([
        listerPenalites(gere ? undefined : { membreId: membre.id }),
        listerMembres(),
        situationsClub(),
        absencesParMembre().catch(() => []),
        avancesExigees().catch(() => []),
        bornesReprisePenalites().catch(() => new Map<string, string>()),
        /*
         * LA TABLE PEUT NE PAS EXISTER ENCORE : la migration s'execute a la main
         * dans Neon. Son absence ne doit pas emporter toute la page -- le
         * registre, lui, est la -- mais elle doit se distinguer d'une liste
         * vide : proposer « Declarer un reglement » sur une table absente
         * mettrait le membre devant une erreur brute de la base.
         */
        reglementsPenalite(gere ? undefined : { membreId: membre.id }).catch((e) => {
          if (estTableAbsente(e)) return null;
          throw e;
        }),
        /* Elle avale deja ses propres erreurs : la page s'affiche sans les vignettes. */
        justificatifsParLot(),
        /* Qui a deja use de son plan unique : R5 ne l'accorde qu'une fois. */
        plansDejaAccordes().catch(() => new Set<string>()),
      ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const total = (statut: string) =>
    penalites
      .filter((p) => p.statut === statut)
      .reduce((s, p) => s + p.montant, 0);

  /*
   * Ce que les statuts prevoient et qui n'a pas encore ete porte au registre.
   *
   * Le rapprochement suit exactement la regle de l'action, `dejaAuRegistre` :
   * la cle, mais aussi le couple membre-echeance pour les lignes ecrites par une
   * version anterieure, et la borne de reprise du tresorier. La page ne
   * regardait que la cle : elle reclamait indefiniment le constat de penalites
   * deja inscrites, que l'action reconnaissait et ne recreait pas. Le bureau
   * appuyait, et la liste ne desemplissait pas.
   */
  const clesPortees = new Set(
    penalites.map((p) => p.source_key).filter(Boolean),
  );
  const registre = penalites.map((p) => ({
    membreId: p.membre_id,
    nature: p.nature,
    dateConstat: p.date_constat,
    cle: p.source_key,
  }));
  const aConstater = situations.flatMap((s) =>
    s.penalites
      .filter(
        (p) =>
          !dejaAuRegistre(s.membreId, p.mois, registre, bornes.get(s.membreId)),
      )
      .map((p) => ({ nom: s.nom, ...p })),
  );

  /*
   * Les tranches d'absences que la feuille de presence justifie et que le registre
   * ne porte pas encore. Le rang sert de cle : il rend le rapprochement exact meme
   * quand une tranche ancienne a deja ete reglee.
   */
  const absencesAConstater = absences.flatMap((a) =>
    tranchesAbsence(a.injustifiees, REGLES)
      .filter((t) => !clesPortees.has(`absence:${a.membreId}:${t.rang}`))
      .map((t) => ({ nom: a.nom, ...t })),
  );

  /*
   * Les membres que le cumul de penalites expose a l'exclusion. La regle ne mord
   * qu'a sa date d'effet : avant elle, le decompte s'affiche en avertissement.
   */
  /*
   * ET CE QUE R5 PREVOIT POUR CHACUN, NOMMEMENT.
   *
   * La page se contentait de compter : « 2 membres exposes », puis leurs noms.
   * Or R5 ne conduit pas au meme endroit pour tous -- exclusion de plein droit
   * si le retard n'a pas ete declare au groupe (R3), plan de redressement s'il
   * l'a ete, vote de l'art. 20 si le membre a deja use de son plan unique.
   * `issueR5` decide cela depuis le debut, et n'etait appelee par aucune page :
   * onze controles la verifiaient, personne ne s'en servait. Le bureau lisait
   * donc une liste de noms sans savoir ce qu'elle emportait.
   */
  const exposes = situations
    .filter((x) => x.nbPenalitesImpayees >= REGLES.penalitesImpayeesAvantExclusion)
    .map((x) => ({
      ...x,
      issue: issueR5(
        x.nbMoisRetard,
        x.retardDeclare,
        plansUtilises.has(x.membreId),
        x.nbPenalitesImpayees,
      ),
    }));
  const regleEnVigueur =
    new Date().toISOString().slice(0, 10) >= EFFET.penalitesIndissociables;
  const dateEffet = EFFET.penalitesIndissociables
    .split("-")
    .reverse()
    .join("/");

  /*
   * Ce que le membre peut declarer : ses propres lignes encore dues, moins celles
   * qui portent deja une declaration en attente -- il ne sert a rien d'en poser
   * deux, et la base les refuserait.
   */
  const circuitPret = declarations !== null;
  const reglements = declarations ?? [];
  const enAttenteParLigne = new Set(
    reglements
      .filter((r) => r.statut === STATUT_REGLEMENT.enAttente)
      .map((r) => r.penalite_id),
  );
  const mesLignesDues = penalites.filter(
    (p) =>
      p.membre_id === membre.id &&
      p.statut === STATUT_PENALITE.due &&
      !enAttenteParLigne.has(p.id),
  );
  const mesDeclarations = reglements.filter((r) => r.membre_id === membre.id);
  const aExaminer = reglements.filter((r) => r.statut === STATUT_REGLEMENT.enAttente);
  /*
   * UN VERSEMENT, UNE LIGNE A EXAMINER.
   *
   * Un versement reparti sur plusieurs penalites ecrit une declaration par
   * ligne, reliees par leur lot. Les afficher une a une faisait valider trois
   * fois un seul transfert. Elles se presentent groupees, et se valident ou
   * se refusent en un geste. Une declaration sans lot reste seule.
   */
  const lotsAExaminer = [
    ...aExaminer
      .reduce((groupes, r) => {
        const cle = r.lot ?? r.id;
        groupes.set(cle, [...(groupes.get(cle) ?? []), r]);
        return groupes;
      }, new Map<string, typeof aExaminer>())
      .values(),
  ].map((lignes) => ({
    cle: lignes[0].lot ?? lignes[0].id,
    parLot: Boolean(lignes[0].lot),
    premiere: lignes[0],
    lignes,
    montant: lignes.reduce((t, r) => t + r.montant, 0),
    quantite: lignes.reduce((t, r) => t + r.quantite, 0),
  }));

  const saisie = gere ? (
    <Panneau
      libelle="Saisir une pénalité"
      titre="Pénalité manuelle"
      introduction="Pour une absence en réunion ou tout motif que le calcul automatique ne couvre pas."
    >
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
            libelle="Quantité"
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
    </Panneau>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <EnTeteEcran
          titre="Pénalités dues"
          sous="à ce jour"
          brut={total(STATUT_PENALITE.due)}
          unite="FCFA"
          detail="Art. 9 : la pénalité reste acquise au club, même après régularisation du mois."
        />
        <div className="sans-impression">{saisie}</div>
      </div>

      <CarteEtat
        chiffres={[
          { libelle: "Réglées", brut: total(STATUT_PENALITE.payee), unite: "FCFA" },
          { libelle: "Annulées", brut: total(STATUT_PENALITE.annulee), unite: "FCFA" },
        ]}
      />

      {exposes.length > 0 && (
        <Alerte
          ton={regleEnVigueur ? "rouge" : "ambre"}
          titre={
            regleEnVigueur
              ? `${exposes.length} membre(s) exclus de plein droit`
              : `${exposes.length} membre(s) exposés à compter du ${dateEffet}`
          }
        >
          <p>
            Les pénalités sont indissociables des cotisations :{" "}
            {REGLES.penalitesImpayeesAvantExclusion} pénalités de retard
            impayées emportent l&apos;exclusion (R5), même si les cotisations
            sont à jour.
            {regleEnVigueur ? "" : ` La règle prend effet le ${dateEffet}.`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {exposes.map((x) => (
              <li key={x.membreId}>
                {x.nom} &middot; {x.nbPenalitesImpayees} pénalités impayées
                {x.issue.applicable && (
                  <span className="block text-xs" style={{ color: "var(--discret)" }}>
                    {LIBELLE_VOIE[x.issue.voie ?? ""] ?? ""} : {x.issue.texte}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Alerte>
      )}

      {avances.length > 0 && (
        <Carte titre="Avances imposées">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Mesure disciplinaire : le membre doit détenir en permanence
            l&apos;avance indiquée. Elle s&apos;exprime en mois, pour
            qu&apos;une cotisation revue en assemblée ne l&apos;allège pas sans
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
                      {a.respectee ? "Respectée" : "Non respectée"}
                    </Badge>
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {/*
                      * A l'approche du terme, l'exigence se limite aux mois qui
                      * restent : « 3 mois exiges, soit 10 000 » se contredirait.
                      */}
                    {a.moisRequis < a.mois
                      ? `${a.moisRequis} mois restant${a.moisRequis > 1 ? "s" : ""} exigé${a.moisRequis > 1 ? "s" : ""} sur ${a.mois}`
                      : `${a.mois} mois exigés`}
                    , soit {fcfa(a.montantExige)} &middot;
                    détenu {fcfa(a.avanceDetenue)}
                    {a.fin ? ` · jusqu'au ${dateCourte(a.fin)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Carte>
      )}

      {/*
       * LE REGLEMENT SE DECLARE AILLEURS, ET C'EST VOULU.
       *
       * Cette page portait son propre formulaire, ou le membre choisissait la
       * ligne qu'il reglait. C'etait permettre de solder une penalite recente
       * en laissant une plus ancienne ouverte -- ce que le club a exclu pour
       * les cotisations comme pour les penalites. Le reglement se declare
       * desormais depuis Versements, par un montant, et s'impute de la plus
       * ancienne a la plus recente : un seul chemin, une seule regle.
       *
       * Cette page reste le registre : ce qui est du, ce qui a ete declare, ce
       * que le tresorier valide.
       */}
      {circuitPret && mesLignesDues.length > 0 && (
        <div className="sans-impression">
          <Carte titre="Régler vos pénalités">
            <p className="mb-4 text-[13px]" style={{ color: "var(--ink-2)" }}>
              Le règlement se déclare depuis Versements : choisissez « une pénalité », puis
              indiquez le montant versé. Il solde vos pénalités de la plus ancienne à la plus
              récente, et part au trésorier, qui le valide.
            </p>
            <LienBouton href="/versements">Déclarer un règlement</LienBouton>
          </Carte>
        </div>
      )}

      {/* Vide, elle disait « aucun reglement en attente » : l'accueil compte deja cette file. */}
      {gere && circuitPret && lotsAExaminer.length > 0 && (
        <Carte titre={`Règlements déclarés, à vérifier (${lotsAExaminer.length})`}>
          {lotsAExaminer.length === 0 ? (
            <Vide>Aucun règlement déclaré en attente.</Vide>
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
              {lotsAExaminer.map(({ cle, parLot, premiere: r, lignes, montant, quantite }) => (
                <li key={cle} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {r.membre_nom} &middot; {fcfa(montant)}
                        {quantite > 1 && (
                          <span className="font-normal" style={{ color: "var(--discret)" }}>
                            {" "}
                            ({quantite} pénalités)
                          </span>
                        )}
                      </p>
                      <p className="text-xs" style={{ color: "var(--discret)" }}>
                        Payé le {dateCourte(r.date_paiement)} &middot; {libelleMode(r.mode)}
                        {r.reference ? ` · réf. ${r.reference}` : ""}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {lignes.map((l) => (
                          <li key={l.id} className="text-xs" style={{ color: "var(--discret)" }}>
                            {LIBELLE_NATURE[l.nature] ?? l.nature} constatée le{" "}
                            {dateCourte(l.date_constat)} &middot; {l.quantite} ×{" "}
                            {fcfa(l.montant_unitaire)}
                            {l.quantite < l.quantite_ligne && (
                              <span style={{ color: "var(--etat-attente)" }}>
                                {" "}
                                (partiel : {l.quantite} sur {l.quantite_ligne}, le reste restera dû)
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {r.note && (
                        <p className="mt-1 text-xs italic" style={{ color: "var(--discret)" }}>
                          {r.note}
                        </p>
                      )}
                      <div className="mt-1">
                        {(pieces.get(r.lot) ?? []).length > 0 ? (
                          <span className="flex flex-wrap gap-2">
                            {(pieces.get(r.lot) ?? []).map((j) => (
                              <a
                                key={j.id}
                                href={`/api/justificatif/${j.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center rounded px-2 py-0.5 text-xs underline"
                                style={{
                                  background: "var(--etat-ok-fond)",
                                  color: "var(--etat-ok)",
                                }}
                              >
                                {j.mime === "application/pdf" ? "Bordereau PDF" : "Voir le reçu"}
                              </a>
                            ))}
                          </span>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--etat-attente)" }}>
                            Aucun justificatif joint : à vérifier avant de valider.
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      <FormulaireAction
                        action={validerReglementPenalite}
                        libelle="Valider"
                        compact
                        confirmation={
                          lignes.length > 1
                            ? `Valider ce règlement de ${fcfa(montant)} ? Les ${lignes.length} pénalités seront soldées.`
                            : "Valider ce règlement ? La pénalité sera soldée."
                        }
                      >
                        <ChampCache nom={parLot ? "lot" : "id"} valeur={cle} />
                      </FormulaireAction>
                      <FormulaireAction
                        action={rejeterReglementPenalite}
                        libelle="Refuser"
                        variante="danger"
                        compact
                        confirmation={
                          lignes.length > 1
                            ? `Refuser ce règlement ? Les ${lignes.length} pénalités resteront dues.`
                            : "Refuser ce règlement ? La pénalité restera due."
                        }
                      >
                        <ChampCache nom={parLot ? "lot" : "id"} valeur={cle} />
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
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Carte>
      )}

      {!gere && mesDeclarations.length > 0 && (
        <Carte titre={`Mes règlements déclarés (${mesDeclarations.length})`}>
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {mesDeclarations.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {fcfa(r.montant)}
                    {r.quantite > 1 && (
                      <span className="font-normal" style={{ color: "var(--discret)" }}>
                        {" "}
                        ({r.quantite} × {fcfa(r.montant_unitaire)})
                      </span>
                    )}
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {LIBELLE_NATURE[r.nature] ?? r.nature} &middot; déclaré le{" "}
                    {dateCourte(r.cree_le)} &middot; payé le {dateCourte(r.date_paiement)}
                  </p>
                  {r.motif_refus && (
                    <p className="mt-0.5 text-xs italic" style={{ color: "var(--perte)" }}>
                      {r.motif_refus}
                    </p>
                  )}
                </div>
                <Badge
                  ton={
                    r.statut === STATUT_REGLEMENT.validee
                      ? "vert"
                      : r.statut === STATUT_REGLEMENT.rejetee
                        ? "rouge"
                        : "ambre"
                  }
                >
                  {r.statut === STATUT_REGLEMENT.validee
                    ? "Validé"
                    : r.statut === STATUT_REGLEMENT.rejetee
                      ? "Refusé"
                      : "En attente"}
                </Badge>
              </li>
            ))}
          </ul>
        </Carte>
      )}

      <Carte
        titre={
          gere
            ? `Registre (${penalites.length})`
            : `Mes pénalités (${penalites.length})`
        }
      >
        {penalites.length === 0 ? (
          <Vide>Aucune pénalité enregistrée.</Vide>
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
                            ? "Réglée"
                            : "Annulée"}
                      </Badge>
                      {!p.auto && <Badge ton="ambre">Saisie</Badge>}
                    </p>
                    <p className="text-xs" style={{ color: "var(--discret)" }}>
                      {LIBELLE_NATURE[p.nature] ?? p.nature} &middot; constatée
                      le {dateCourte(p.date_constat)}
                      {p.date_reglement
                        ? ` · soldée le ${dateCourte(p.date_reglement)}`
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
                   * LES COMMANDES D'UNE LIGNE VIVENT DERRIERE LES TROIS POINTS.
                   *
                   * Chaque penalite portait jusqu'a deux boutons et deux boites
                   * de saisie -- « Reglee », « Annuler », un motif, un nombre de
                   * mois -- poses a demeure sur une page qu'on ouvre pour lire.
                   * Le motif et le nombre de mois n'apparaissent plus qu'au
                   * moment de repondre a la question, ou l'on sait quoi y
                   * mettre. Reprendre un reglement ou une annulation reste
                   * possible : une erreur de manipulation ne doit pas rester
                   * inscrite pour toujours.
                   */}
                  {gere && (
                    <MenuLigne
                      etiquette={`Actions sur la pénalité de ${p.membre_nom} du ${dateCourte(p.date_constat)}`}
                      actions={
                        p.statut === STATUT_PENALITE.due
                          ? [
                              {
                                libelle: "Marquer réglée",
                                action: reglerPenalite,
                                champs: (
                                  <>
                                    <ChampCache nom="id" valeur={p.id} />
                                    {p.quantite > 1 && (
                                      <ChampMenu
                                        nom="quantite"
                                        libelle={`Mois réglés, sur ${p.quantite}`}
                                        type="number"
                                        min={1}
                                        max={p.quantite}
                                        requis={false}
                                        indication={`Vide : les ${p.quantite}`}
                                      />
                                    )}
                                  </>
                                ),
                                confirmation:
                                  p.quantite > 1
                                    ? `Combien des ${p.quantite} mois sont réglés ? Laissez vide pour tout solder.`
                                    : "Marquer cette pénalité comme réglée ?",
                                confirmer: "Marquer réglée",
                              },
                              {
                                libelle: "Annuler la pénalité",
                                action: annulerPenalite,
                                champs: (
                                  <>
                                    <ChampCache nom="id" valeur={p.id} />
                                    <ChampMenu
                                      nom="motif"
                                      libelle="Motif de l'annulation"
                                      indication="Dérogation, erreur de constat..."
                                    />
                                  </>
                                ),
                                confirmation: "Annuler cette pénalité ?",
                                confirmer: "Annuler la pénalité",
                              },
                            ]
                          : [
                              {
                                libelle: "Remettre en dû",
                                action: rouvrirPenalite,
                                champs: (
                                  <>
                                    <ChampCache nom="id" valeur={p.id} />
                                    <ChampMenu
                                      nom="motif"
                                      libelle="Motif de la reprise"
                                      indication="Règlement annulé, erreur..."
                                    />
                                  </>
                                ),
                                confirmation: "Remettre cette pénalité en du ?",
                                confirmer: "Remettre en dû",
                              },
                            ]
                      }
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Carte>



      {/*
        * LES OUTILS APRES LE REGISTRE, ET SEULEMENT QUAND ILS SERVENT.
        *
        * Ils passaient avant lui : on lisait d'abord « le registre est a jour :
        * rien de nouveau a constater », puis la liste des absences, avant
        * d'atteindre ce qu'on venait voir, en troisieme page. Le constat des
        * retards a lieu de toute facon a chaque relance : sa carte ne parait
        * que lorsqu'il reste quelque chose a porter.
        */}
      {gere && aConstater.length > 0 && (
        <Carte titre="Constater les retards">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Le site calcule ce que les statuts prévoient ; c&apos;est le bureau
            qui le porte au registre. Cette action est rejouable : une pénalité
            déjà réglée ou annulée n&apos;est jamais retouchée, seules celles
            encore dues voient leur montant réajusté si R4 vient à
            s&apos;appliquer.
          </p>
          {aConstater.length === 0 ? (
            <Alerte ton="vert">
              Le registre est à jour : rien de nouveau à constater.
            </Alerte>
          ) : (
            <>
              <Alerte
                ton="ambre"
                titre={`${aConstater.length} pénalité${aConstater.length > 1 ? "s" : ""} à constater`}
              >
                <ul className="mt-1 space-y-0.5">
                  {aConstater.slice(0, 8).map((p, i) => (
                    <li key={`${p.nom}-${p.mois}-${i}`}>
                      {p.nom} &middot; {moisLong(p.mois)} &middot;{" "}
                      {fcfa(p.montant)}
                      {p.doublee ? " (doublée, R4)" : ""}
                    </li>
                  ))}
                  {aConstater.length > 8 && (
                    <li>et {aConstater.length - 8} autres…</li>
                  )}
                </ul>
              </Alerte>
              {/*
                * UN SEUL BOUTON PLEIN PAR ECRAN, et c'est « Saisir une
                * penalite », en tete de page. Celui-ci et son jumeau des
                * absences etaient pleins eux aussi : trois commandes noires sur
                * un meme ecran ne disent plus laquelle compte. L'encadre qui
                * les precede designe deja ce qu'il y a a faire.
                */}
              <FormulaireAction
                action={constaterPenalitesRetard}
                libelle="Porter au registre"
                variante="discret"
                confirmation={`Constater ${aConstater.length} pénalité(s) de retard ?`}
              />
            </>
          )}
        </Carte>
      )}

      {gere && (
        <Carte titre="Constater les absences">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            {fcfa(REGLES.penaliteAbsence)} par tranche de{" "}
            {REGLES.absencesParTranche} absences injustifiées. Le club
            sanctionne la répétition, non l&apos;empêchement ponctuel : une
            absence isolée ne coûte rien. Pour en justifier une, le secrétaire
            la passe en &laquo;&nbsp;Excusé&nbsp;&raquo; sur la séance, depuis
            la page Réunions : elle sort alors du compte.
          </p>
          {absences.length === 0 ? (
            <Vide>Aucune feuille de présence pointée.</Vide>
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
                        {a.injustifiees} injustifiée
                        {a.injustifiees > 1 ? "s" : ""}
                        {a.excusees > 0
                          ? ` · ${a.excusees} excusée${a.excusees > 1 ? "s" : ""}`
                          : ""}
                      </span>
                    </li>
                  ))}
              </ul>
              {absencesAConstater.length === 0 ? (
                <Alerte ton="vert">
                  Le registre est à jour : aucune tranche d&apos;absences à
                  porter.
                </Alerte>
              ) : (
                <>
                  <Alerte
                    ton="ambre"
                    titre={`${absencesAConstater.length} tranche${absencesAConstater.length > 1 ? "s" : ""} à constater`}
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
                    variante="discret"
                    confirmation={`Constater ${absencesAConstater.length} pénalité(s) d'absence ?`}
                  />
                </>
              )}
            </>
          )}
        </Carte>
      )}
    </>
  );
}
