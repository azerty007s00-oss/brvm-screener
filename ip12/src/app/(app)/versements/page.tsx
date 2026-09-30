import Link from "next/link";
import type { CelluleMois } from "@/lib/penalites";
import { exigerMembre } from "@/lib/auth";
import {
  listerMembres,
  listerVersements,
  situationsClub,
  versementsEnAttente,
} from "@/lib/queries";
import { REGLES, dateCourte, debutMois, fcfa, moisLong, nombre } from "@/lib/settings";
import { relancerMaintenant } from "@/app/actions/administration";
import {
  annulerVersementValide,
  corrigerVersement,
  declarerRetard,
  declarerVersement,
  rejeterVersement,
  validerVersement,
} from "@/app/actions/versements";
import { ChampJustificatif } from "@/components/justificatif";
import { justificatifsParLot } from "@/lib/justificatifs";
import { peut } from "@/lib/droits";
import {
  Champ,
  ChampCache,
  Depliant,
  FormulaireAction,
  Selection,
} from "@/components/formulaires";
import { Carte, EnTeteEcran, Vide } from "@/components/ui";
import { Panneau } from "@/components/panneau";
import {
  EcranInitialisation,
  estTableAbsente,
} from "@/components/initialisation";
import {
  Frise,
  GlypheEtat,
  LegendeEtats,
  LIBELLE_STATUT,
  initialeMois,
  statutLigne,
} from "@/components/glyphe-etat";
import { MODES_AFFICHES, STATUT_VERSEMENT, libelleMode } from "@/lib/valeurs";
import { Chiffre } from "@/components/chiffre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Versements" };

/**
 * La phrase qui accompagne un mois dans le detail.
 *
 * Une seule formule pour six etats disait forcement une betise a l'un d'eux :
 * « il manque 5 000 FCFA » sur un mois pas encore du, ou « rien de verse » sur
 * un mois paye d'avance. Chaque etat a donc sa phrase, et aucune ne calcule
 * quoi que ce soit -- tout vient de la cellule.
 */
function detailDuMois(c: CelluleMois): string {
  const verse = c.dateVersement ? `Verse le ${dateCourte(c.dateVersement)}.` : null;
  switch (c.statut) {
    case "paye":
      return verse ?? "Mois solde.";
    case "paye_en_retard":
      return `${verse ?? "Mois solde"} La penalite reste due (art. 9).`;
    case "en_attente":
      return "Declare, en attente de validation par le tresorier.";
    case "partiel":
      return `${verse ? `${verse} ` : ""}Il manque ${fcfa(c.manque)}.`;
    case "retard":
      return `Rien de verse : ${fcfa(c.manque > 0 ? c.manque : c.requis)} dus depuis le ${REGLES.jourEcheance}.`;
    case "a_venir":
      return verse
        ? `${verse} Mois paye d'avance.`
        : `Pas encore du : echeance au ${REGLES.jourEcheance}.`;
    case "hors_periode":
      return "";
  }
}

/** Le chevron des lignes depliantes : tourne quand le detail s'ouvre. */
function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="chevron h-4 w-4 flex-none"
      style={{ fill: "none", stroke: "var(--discret)", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}
    >
      <path d="M9.5 6 L15.5 12 L9.5 18" />
    </svg>
  );
}

export default async function PageVersements({
  searchParams,
}: {
  searchParams: Promise<{ ordre?: string }>;
}) {
  const membre = await exigerMembre();
  const ordre = (await searchParams).ordre === "nom" ? "nom" : "urgence";

  let situations, enAttente, membres, pieces, valides;
  try {
    [situations, enAttente, membres, pieces, valides] = await Promise.all([
      situationsClub(),
      versementsEnAttente(),
      listerMembres(),
      justificatifsParLot(),
      listerVersements({ statut: STATUT_VERSEMENT.valide }),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const peutValider = peut(membre, "validerVersement");
  const peutCorriger = peut(membre, "corrigerVersement");
  const peutRelancer = peut(membre, "relancer");
  // Les corrections portent sur des saisies recentes : au-dela, on ne corrige plus, on regularise.
  const corrigibles = valides.slice(0, 40);
  const saisieDirecte = peut(membre, "saisirVersementValide");
  // Les 14 derniers mois : au-dela, la grille devient illisible sur telephone.
  const moisAffiches = (situations[0]?.cellules ?? []).slice(-14);
  const maSituation = situations.find((s) => s.membreId === membre.id);
  const aujourdhui = debutMois();

  /* Combien de membres ont solde le mois en cours : l'etat des cellules le dit. */
  const payesCeMois = situations.filter((x) => {
    const c = x.cellules.find((y) => y.mois === aujourdhui);
    return c?.statut === "paye" || c?.statut === "paye_en_retard";
  }).length;

  /* Une grille unique : l'echelle des mois et les dix frises s'y alignent. */
  const colonnes = {
    gridTemplateColumns: `repeat(${Math.max(moisAffiches.length, 1)}, minmax(0, 1fr))`,
  };

  /* Les annees du bandeau, chacune couvrant ses mois de la fenetre. */
  const annees = moisAffiches.reduce<{ annee: string; nb: number }[]>((acc, c) => {
    const annee = c.mois.slice(0, 4);
    const dernier = acc.at(-1);
    if (dernier?.annee === annee) dernier.nb++;
    else acc.push({ annee, nb: 1 });
    return acc;
  }, []);

  /*
   * Le detail d'un mois va chercher sa note et sa piece dans les lignes deja
   * chargees pour les cartes du dessus -- validees comme en attente. Aucune
   * requete de plus : le registre ne coute que sa mise en page.
   */
  const versementsDuMois = new Map<string, typeof valides>();
  for (const v of [...valides, ...enAttente]) {
    const cle = `${v.membre_id}|${v.mois}`;
    const deja = versementsDuMois.get(cle);
    if (deja) deja.push(v);
    else versementsDuMois.set(cle, [v]);
  }

  /*
   * L'ordre d'urgence remonte ce qui reclame une action : ce qui manque, puis
   * ce qui attend une validation, puis ce qui est en regle ; a egalite, le plus
   * de mois concernes d'abord, puis le nom. C'est un ordre d'affichage : il ne
   * touche a aucun calcul, et le tri par nom rend la liste au classement connu.
   */
  const lignesRegistre = situations
    .map((s) => {
      const fenetre = s.cellules.slice(-14);
      const du = fenetre.filter((c) => c.statut === "retard" || c.statut === "partiel").length;
      const attente = fenetre.filter((c) => c.statut === "en_attente").length;
      return {
        s,
        fenetre,
        statut: statutLigne(fenetre),
        moi: s.membreId === membre.id,
        rang: du > 0 ? 0 : attente > 0 ? 1 : 2,
        poids: du > 0 ? du : attente,
      };
    })
    .sort((a, b) =>
      ordre === "nom"
        ? a.s.nom.localeCompare(b.s.nom, "fr")
        : a.rang - b.rang || b.poids - a.poids || a.s.nom.localeCompare(b.s.nom, "fr"),
    );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <EnTeteEcran
          titre={`Cotisations de ${moisLong(aujourdhui)}`}
          chiffre={
            <>
              <Chiffre valeur={payesCeMois} format={String} /> sur {situations.length}
            </>
          }
          detail={
            enAttente.length > 0
              ? `${enAttente.length} declaration${enAttente.length > 1 ? "s" : ""} en attente de validation.`
              : "Aucune declaration en attente."
          }
        />
        <div className="sans-impression flex flex-wrap gap-2.5">
          {peutRelancer && (
            <Panneau
              libelle="Relancer maintenant"
              titre="Relancer les retardataires"
              variante="secondaire"
              introduction="La relance part d'elle-meme le 10 de chaque mois. Entre deux, vous pouvez l'envoyer a la main : c'est exactement le meme courrier -- mois manquants, penalites, rappels R2, R3 et R4, mesures disciplinaires. Seuls les membres concernes le recoivent ; ceux qui sont a jour ne sont jamais ecrits."
            >
              <FormulaireAction action={relancerMaintenant} libelle="Relancer maintenant" />
            </Panneau>
          )}
          <Panneau
            libelle={saisieDirecte ? "Enregistrer un versement" : "Declarer un versement"}
            titre={saisieDirecte ? "Enregistrer un versement" : "Declarer un versement"}
            introduction={
              saisieDirecte
                ? "Votre saisie vaut validation : vous constatez un encaissement, pour vous ou pour un autre membre."
                : "Votre declaration est visible de tous immediatement, et reste en attente jusqu'a la validation du tresorier qui tient la caisse. Il en est prevenu par courriel, vous et le president en copie."
            }
          >
            <FormulaireAction action={declarerVersement} libelle="Declarer">
              {saisieDirecte && (
                <Selection
                  nom="membreId"
                  libelle="Pour le compte de"
                  valeur={String(membre.id)}
                  options={membres.map((m) => ({ valeur: String(m.id), libelle: m.nom }))}
                />
              )}
              <Champ
                nom="moisDebut"
                libelle="Premier mois couvert"
                type="month"
                valeur={aujourdhui.slice(0, 7)}
              />
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
              <Champ
                nom="dateVersement"
                libelle="Date du versement"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Selection nom="mode" libelle="Mode" options={MODES_AFFICHES} />
              <Champ nom="reference" libelle="Reference du paiement (facultatif)" requis={false} />
              <Champ nom="note" libelle="Note (facultatif)" requis={false} />
              <ChampJustificatif />
            </FormulaireAction>
          </Panneau>
        </div>
      </div>

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
                      <p
                        className="text-xs"
                        style={{ color: "var(--discret)" }}
                      >
                        {moisLong(v.mois)} &middot; verse le{" "}
                        {dateCourte(v.date_versement)} &middot;{" "}
                        {libelleMode(v.mode)}
                        {v.saisi_par_nom && v.saisi_par_nom !== v.membre_nom
                          ? ` · saisi par ${v.saisi_par_nom}`
                          : ""}
                      </p>
                      {v.note && (
                        <p
                          className="mt-1 text-xs italic"
                          style={{ color: "var(--discret)" }}
                        >
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
                                style={{
                                  background: "var(--etat-ok-fond)",
                                  color: "var(--etat-ok)",
                                }}
                              >
                                {j.mime === "application/pdf"
                                  ? "Bordereau PDF"
                                  : "Voir le recu"}
                              </a>
                            ))}
                          </span>
                        ) : (
                          <span
                            className="text-xs"
                            style={{ color: "var(--etat-attente)" }}
                          >
                            Aucun justificatif joint — a verifier avant de
                            valider.
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      <FormulaireAction
                        action={validerVersement}
                        libelle="Valider"
                        compact
                      >
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

      {/*
       * Les versements valides, ouverts a tous.
       *
       * Le justificatif et la note n'existaient que dans la carte « a valider »,
       * reservee au tresorier : une fois le versement valide, plus personne ne
       * les voyait, pas meme celui qui les avait joints. Un club dont les
       * comptes sont ouverts (art. 12) doit montrer la piece autant que le
       * chiffre -- c'est la piece qui permet de contester.
       *
       * La correction et l'annulation restent au tresorier et au president :
       * voir n'est pas ecrire.
       */}
      {corrigibles.length > 0 && (
        <Carte titre={`Versements valides (${corrigibles.length})`}>
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            {peutCorriger
              ? "Les saisies les plus recentes, justificatifs compris. Une erreur n'est pas definitive : la correction ne remplace pas en silence, l'etat anterieur reste inscrit sur la ligne et au journal, et le motif est obligatoire."
              : "Les saisies les plus recentes, justificatifs compris. Chacun peut verifier ce qui a ete encaisse, pour lui comme pour les autres : les comptes du club sont ouverts a tous ses membres (art. 12)."}
          </p>
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {corrigibles.map((v) => (
              <li key={v.id} className="py-1.5">
                <Depliant
                  titre={`${v.membre_nom} · ${moisLong(v.mois)} · ${fcfa(v.montant)}`}
                >
                  <p
                    className="mb-3 text-xs"
                    style={{ color: "var(--discret)" }}
                  >
                    Verse le {dateCourte(v.date_versement)} &middot;{" "}
                    {libelleMode(v.mode)}
                    {v.reference ? ` · ${v.reference}` : ""}
                    {v.valide_par_nom
                      ? ` · valide par ${v.valide_par_nom}`
                      : ""}
                  </p>
                  {v.motif_rejet && (
                    <p
                      className="mb-3 whitespace-pre-line rounded-lg px-2 py-1.5 text-[11px]"
                      style={{
                        background: "var(--sunk)",
                        color: "var(--discret)",
                      }}
                    >
                      {v.motif_rejet}
                    </p>
                  )}
                  {v.note && (
                    <p
                      className="mb-3 text-xs italic"
                      style={{ color: "var(--discret)" }}
                    >
                      {v.note}
                    </p>
                  )}
                  <div className="mb-3 text-xs">
                    {(pieces.get(v.lot) ?? []).length > 0 ? (
                      <ul className="space-y-1">
                        {(pieces.get(v.lot) ?? []).map((j) => (
                          <li key={j.id}>
                            <a
                              href={`/api/justificatif/${j.id}`}
                              target="_blank"
                              rel="noopener"
                              className="underline"
                              style={{ color: "var(--gold-ink)" }}
                            >
                              {j.nom}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p style={{ color: "var(--discret)" }}>
                        Aucun justificatif joint.
                      </p>
                    )}
                  </div>
                  {peutCorriger && (
                    <>
                      <FormulaireAction
                        action={corrigerVersement}
                        libelle="Corriger"
                        compact
                      >
                        <ChampCache nom="id" valeur={v.id} />
                        <Champ
                          nom="montant"
                          libelle="Montant (FCFA)"
                          type="number"
                          min={1}
                          valeur={v.montant}
                        />
                        <Champ
                          nom="dateVersement"
                          libelle="Date du versement"
                          type="date"
                          valeur={v.date_versement}
                        />
                        <Champ
                          nom="mois"
                          libelle="Mois couvert"
                          type="date"
                          valeur={v.mois}
                          aide="Le premier du mois. Un mois deja couvert pour ce membre est refuse."
                        />
                        <Selection
                          nom="mode"
                          libelle="Mode"
                          valeur={v.mode}
                          options={MODES_AFFICHES}
                        />
                        <Champ
                          nom="reference"
                          libelle="Reference"
                          requis={false}
                          valeur={v.reference ?? ""}
                        />
                        <Champ
                          nom="motif"
                          libelle="Motif de la correction"
                          aide="Restera inscrit sur la ligne."
                        />
                      </FormulaireAction>
                      <div
                        className="mt-4 border-t pt-3"
                        style={{ borderColor: "var(--bordure)" }}
                      >
                        <p
                          className="mb-2 text-[11px]"
                          style={{ color: "var(--discret)" }}
                        >
                          Si l&apos;encaissement n&apos;a jamais eu lieu, ou a
                          ete compte deux fois : l&apos;annulation libere le
                          mois.
                        </p>
                        <FormulaireAction
                          action={annulerVersementValide}
                          libelle="Annuler ce versement"
                          variante="danger"
                          compact
                          confirmation={`Annuler ${fcfa(v.montant)} de ${v.membre_nom} pour ${moisLong(v.mois)} ?`}
                        >
                          <ChampCache nom="id" valeur={v.id} />
                          <Champ nom="motif" libelle="Motif de l'annulation" />
                        </FormulaireAction>
                      </div>
                    </>
                  )}
                </Depliant>
              </li>
            ))}
          </ul>
        </Carte>
      )}

      <Carte titre="Registre des cotisations">
        <div className="mb-4">
          <LegendeEtats />
        </div>

        {/*
         * L'ordre des lignes est un lien, non un bouton : la page est rendue au
         * serveur, et le tri survit alors au rechargement comme au partage du
         * lien. C'est un ordre d'affichage -- aucun chiffre n'en depend.
         */}
        <div className="sans-impression mb-3 flex items-center gap-2 text-xs">
          <span style={{ color: "var(--discret)" }}>Ordre des lignes</span>
          <div
            className="ml-auto inline-flex overflow-hidden rounded-xl border"
            style={{ borderColor: "var(--bordure)" }}
          >
            {(
              [
                ["urgence", "Urgence"],
                ["nom", "Nom"],
              ] as const
            ).map(([cle, libelle]) => (
              <Link
                key={cle}
                href={cle === "urgence" ? "/versements" : "/versements?ordre=nom"}
                scroll={false}
                aria-current={ordre === cle ? "true" : undefined}
                className="grid min-h-11 place-items-center px-4 text-[13px] font-semibold"
                style={
                  ordre === cle
                    ? { background: "var(--ink)", color: "var(--page)" }
                    : { color: "var(--discret)" }
                }
              >
                {libelle}
              </Link>
            ))}
          </div>
        </div>

        <div
          className="overflow-hidden rounded-xl border"
          style={{ borderColor: "var(--bordure)" }}
        >
          {/* L'echelle des mois, posee une fois pour toutes les frises. */}
          <div
            className="border-b px-3 pt-2 pb-1.5"
            style={{ borderColor: "var(--bordure)", background: "var(--fond)" }}
          >
            <div className="grid" style={colonnes}>
              {annees.map((a) => (
                <span
                  key={a.annee}
                  className="border-l pl-1 text-[10px] font-semibold"
                  style={{
                    gridColumn: `span ${a.nb}`,
                    borderColor: "var(--bordure)",
                    color: "var(--discret)",
                  }}
                >
                  {a.annee}
                </span>
              ))}
            </div>
            <div className="mt-0.5 grid gap-1" style={colonnes}>
              {moisAffiches.map((c) => (
                <span
                  key={c.mois}
                  className="rounded text-center text-[11px] leading-5"
                  style={
                    c.mois === aujourdhui
                      ? { background: "var(--sunk)", color: "var(--ink)", fontWeight: 600 }
                      : { color: "var(--discret)" }
                  }
                >
                  {initialeMois(c.mois)}
                </span>
              ))}
            </div>
          </div>

          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {lignesRegistre.map(({ s, fenetre, statut, moi }) => (
              <li key={s.membreId} >
                {/*
                 * Un seul detail ouvert a la fois : le nom du groupe suffit, le
                 * navigateur ferme les autres sans une ligne de JavaScript.
                 */}
                <details name="registre" className="ligne-registre">
                  <summary className="tapable cursor-pointer px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{s.nom}</span>
                      {/*
                        * « vous » est un mot, non une pastille doree : c'est un
                        * reperage, pas une distinction. De meme, un nombre de
                        * mois de retard se lit mieux ecrit qu'enferme dans une
                        * gelule rouge, qui criait plus fort que le retard.
                        */}
                      {moi && (
                        <span
                          className="flex-none text-[12px] font-medium"
                          style={{ color: "var(--ink-3)" }}
                        >
                          vous
                        </span>
                      )}
                      <span
                        className="flex-none text-[12px] font-semibold"
                        style={{ color: statut.encre }}
                      >
                        {statut.texte}
                      </span>
                      <Chevron />
                    </div>
                    <div className="mt-1.5">
                      <Frise cellules={fenetre} taille={18} etiquette={s.nom} />
                    </div>
                  </summary>

                  <div
                    className="border-t px-3 py-3"
                    style={{ borderColor: "var(--bordure)", background: "var(--carte)" }}
                  >
                    <ul className="space-y-2.5">
                      {fenetre
                        .filter((c) => c.statut !== "hors_periode" && !(c.statut === "a_venir" && c.montant === 0))
                        .slice(-4)
                        .reverse()
                        .map((c) => {
                          const lignes = versementsDuMois.get(`${s.membreId}|${c.mois}`) ?? [];
                          const note = lignes.find((v) => v.note)?.note ?? null;
                          const justificatifs = lignes.flatMap((v) => pieces.get(v.lot) ?? []);
                          return (
                            <li key={c.mois} className="flex gap-2">
                              <span className="mt-0.5">
                                <GlypheEtat statut={c.statut} taille={16} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                                  <span className="font-semibold">{moisLong(c.mois)}</span>
                                  <span style={{ color: "var(--discret)" }}>
                                    {LIBELLE_STATUT[c.statut]}
                                  </span>
                                  <span className="ml-auto font-semibold whitespace-nowrap tabular-nums">
                                    {c.manque > 0 && c.montant > 0
                                      ? `${nombre(c.montant)} sur ${fcfa(c.requis)}`
                                      : fcfa(c.montant > 0 ? c.montant : c.requis)}
                                  </span>
                                </div>
                                <p className="text-[12px]" style={{ color: "var(--discret)" }}>
                                  {detailDuMois(c)}
                                  {note ? ` Note : ${note}` : ""}
                                </p>
                                {justificatifs.length > 0 && (
                                  <p className="text-[12px]">
                                    {justificatifs.map((j) => (
                                      <a
                                        key={j.id}
                                        href={`/api/justificatif/${j.id}`}
                                        target="_blank"
                                        rel="noopener"
                                        className="mr-3 underline"
                                        style={{ color: "var(--gold-ink)" }}
                                      >
                                        {j.nom}
                                      </a>
                                    ))}
                                  </p>
                                )}
                              </div>
                            </li>
                          );
                        })}
                    </ul>
                    <p className="mt-3 text-[12px]" style={{ color: "var(--discret)" }}>
                      Verse depuis le debut :{" "}
                      <span className="font-semibold tabular-nums" style={{ color: "var(--texte)" }}>
                        {fcfa(s.verse)}
                      </span>
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      </Carte>

      {maSituation && maSituation.moisEnRetard.length > 0 && (
        <Carte titre="Declarer un retard (R3)">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            La resolution R3 impose de signaler son retard sur le groupe
            WhatsApp, en taguant tous les membres, au plus tard le lendemain de
            l&apos;entree dans le 2e mois. Enregistrez ici la declaration faite
            : elle preserve votre droit au plan de redressement prevu par R5.
          </p>
          <Depliant titre="Enregistrer ma declaration">
            <FormulaireAction
              action={declarerRetard}
              libelle="Enregistrer la declaration"
            >
              <Selection
                nom="mois"
                libelle="Mois concerne"
                options={maSituation.moisEnRetard.map((m) => ({
                  valeur: m,
                  libelle: moisLong(m),
                }))}
              />
              <Champ
                nom="note"
                libelle="Precision (facultatif)"
                requis={false}
              />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}
    </>
  );
}
