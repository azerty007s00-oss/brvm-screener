import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import {
  listerMouvementsCaisse,
  reglagesEffectifs,
  reglementsPenalite,
  versementsEnAttente,
} from "@/lib/queries";
import { justificatifsParLot, type Justificatif } from "@/lib/justificatifs";
import { rejeterDeclaration, validerDeclaration } from "@/app/actions/versements";
import { rejeterReglementPenalite, validerReglementPenalite } from "@/app/actions/penalites";
import { rejeterMouvement, validerMouvement } from "@/app/actions/caisse";
import { accorde, dateCourte, debutMois, fcfa, joursDepuis } from "@/lib/settings";
import { listeDesMois } from "@/lib/sortie";
import {
  KIND_PENALITE,
  METHODE,
  SENS_CAISSE,
  STATUT_CAISSE,
  STATUT_REGLEMENT,
  libelleCategorie,
  libelleMode,
} from "@/lib/valeurs";
import { EnTeteEcran, Vide } from "@/components/ui";
import { GlypheEtat } from "@/components/glyphe-etat";
import { Decision } from "@/components/decision";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";
import { Voilable, avecMontants } from "@/components/voilable";

export const dynamic = "force-dynamic";
export const metadata = { title: "À valider" };

/**
 * LA BOITE « A VALIDER » : TOUT CE QUI ATTEND LE VISA DU BUREAU, AU MEME ENDROIT.
 *
 * Les versements se validaient depuis Versements, les reglements de penalites
 * depuis Penalites, les mouvements de caisse depuis Caisse. Le tresorier faisait
 * le tour de trois pages pour savoir s'il avait quelque chose a faire, et la
 * declaration d'un membre pouvait dormir sur celle qu'il n'ouvrait pas. Une
 * seule file, la plus ancienne en tete de chaque groupe, et un geste par
 * declaration -- comme le membre l'a faite, quel que soit le nombre de mois ou
 * de penalites qu'elle couvre.
 *
 * Chaque ligne dit ce qu'il faut verifier avant de viser : le reçu, a un
 * toucher ; un versement arrive apres l'echeance, dont la penalite reste due ;
 * une remise sans justificatif.
 */

type Ligne = {
  cle: string;
  nom: string;
  montant: number;
  objet: string;
  quand: string;
  pieces: Justificatif[];
  alerte: string | null;
  /** Le jour ou la declaration est arrivee : ce qui mesure l'attente. */
  depuis: string;
  decision: React.ReactNode;
};

type Groupe = { cle: "versements" | "penalites" | "caisse"; titre: string; lignes: Ligne[] };

const FILTRES: { cle: Groupe["cle"] | null; libelle: string }[] = [
  { cle: null, libelle: "Tout" },
  { cle: "versements", libelle: "Versements" },
  { cle: "penalites", libelle: "Pénalités" },
  { cle: "caisse", libelle: "Caisse" },
];

const NATURE: Record<string, string> = {
  [KIND_PENALITE.retard]: "retard",
  [KIND_PENALITE.absence]: "absence",
  [KIND_PENALITE.autre]: "autre",
};

/** Regroupe des lignes par lot, dans l'ordre ou elles arrivent. */
function parLot<T>(lignes: T[], cle: (l: T) => string): T[][] {
  const groupes = new Map<string, T[]>();
  for (const l of lignes) groupes.set(cle(l), [...(groupes.get(cle(l)) ?? []), l]);
  return [...groupes.values()];
}

export default async function PageAValider({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const membre = await exigerMembre();
  if (!peut(membre, "validerVersement")) {
    return <Vide>Cette page est réservée au trésorier et au président.</Vide>;
  }
  const { type } = await searchParams;
  const filtre = FILTRES.find((f) => f.cle === type)?.cle ?? null;
  const voitCaisse = peut(membre, "gererReglages");

  let versements, reglements, mouvements, pieces, reglages;
  try {
    [versements, reglements, mouvements, pieces, reglages] = await Promise.all([
      versementsEnAttente(),
      /* La table des reglements nait d'une migration : sans elle, le groupe se tait. */
      reglementsPenalite({ statut: STATUT_REGLEMENT.enAttente }).catch(() => []),
      voitCaisse
        ? listerMouvementsCaisse().then((m) => m.filter((x) => x.statut === STATUT_CAISSE.enAttente))
        : Promise.resolve([]),
      justificatifsParLot(),
      reglagesEffectifs(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const moisCourant = debutMois();
  const jour = String(reglages.jourEcheance).padStart(2, "0");
  const sansPiece = (mode: string) =>
    mode === METHODE.especes
      ? "Sans justificatif : vérifiez la remise en espèces avant de valider."
      : "Sans justificatif : retrouvez ce versement sur le compte du club avant de valider.";

  /* ------------------------------------------------------------ versements */
  const lignesVersements: Ligne[] = parLot(versements, (v) => v.lot).map((lot) => {
    const v = lot[0];
    const mois = lot.map((x) => x.mois).sort();
    const montant = lot.reduce((t, x) => t + x.montant, 0);
    const pj = pieces.get(v.lot) ?? [];
    /* Une cotisation reprise au rachat n'est pas encore payee : la sortie l'inscrit en attente. */
    const reprise = (v.note ?? "").startsWith("Cotisation impayée de ");
    const avance = mois.every((m) => m > moisCourant);
    const objet = reprise
      ? `${v.note} : ${listeDesMois(mois)}, à valider à réception de l'argent`
      : `${mois.length > 1 ? "Cotisations" : "Cotisation"} ${listeDesMois(mois)}` +
        `${avance ? ", payée d'avance" : ""} · ${libelleMode(v.mode)}` +
        `${v.reference ? ` · réf. ${v.reference}` : ""}`;
    /*
     * L'art. 9 attache la penalite au versement arrive apres le 10 : valider ne
     * l'efface pas. Le dire ici evite au tresorier de croire le mois regle sans
     * reste, et au membre de l'apprendre par la relance suivante.
     */
    const tardif = !reprise && mois.find((m) => v.date_versement > `${m.slice(0, 8)}${jour}`);
    const alerte = tardif
      ? `Versé le ${dateCourte(v.date_versement)}, après l'échéance du ${reglages.jourEcheance} : ` +
        "la pénalité de l'art. 9 reste due."
      : pj.length === 0 && !reprise
        ? sansPiece(v.mode)
        : null;
    const autre = v.saisi_par_nom && v.saisi_par_nom !== v.membre_nom ? `, saisi par ${v.saisi_par_nom}` : "";
    return {
      cle: v.lot,
      nom: v.membre_nom,
      montant,
      objet,
      quand:
        `déclaré le ${dateCourte(v.declare_le)}${autre}` +
        (v.date_versement !== v.declare_le && !reprise ? ` · versé le ${dateCourte(v.date_versement)}` : ""),
      pieces: pj,
      alerte,
      depuis: v.declare_le,
      decision: <Decision valider={validerDeclaration} rejeter={rejeterDeclaration} champs={{ lot: v.lot }} />,
    };
  });

  /* ---------------------------------------------------- reglements de penalites */
  const lignesPenalites: Ligne[] = parLot(reglements, (r) => r.lot ?? r.id).map((lot) => {
    const r = lot[0];
    const montant = lot.reduce((t, x) => t + x.montant, 0);
    const quantite = lot.reduce((t, x) => t + x.quantite, 0);
    const pj = r.lot ? (pieces.get(r.lot) ?? []) : [];
    const natures = [...new Set(lot.map((x) => NATURE[x.nature] ?? x.nature))].join(" et ");
    const constats = [...new Set(lot.map((x) => dateCourte(x.date_constat)))];
    const partiel = lot.some((x) => x.quantite < x.quantite_ligne);
    return {
      cle: r.lot ?? r.id,
      nom: r.membre_nom,
      montant,
      objet:
        `${quantite} ${accorde(quantite, "pénalité")} de ${natures}, constatée${quantite > 1 ? "s" : ""} ` +
        `le ${constats.join(", le ")} · ${libelleMode(r.mode)}` +
        `${r.reference ? ` · réf. ${r.reference}` : ""}`,
      quand: `déclaré le ${dateCourte(r.cree_le)} · payé le ${dateCourte(r.date_paiement)}`,
      pieces: pj,
      alerte: partiel
        ? "Règlement partiel : le reste de la ligne restera dû après validation."
        : pj.length === 0
          ? sansPiece(r.mode)
          : null,
      depuis: r.cree_le.slice(0, 10),
      decision: (
        <Decision
          valider={validerReglementPenalite}
          rejeter={rejeterReglementPenalite}
          champs={r.lot ? { lot: r.lot } : { id: r.id }}
        />
      ),
    };
  });

  /* ------------------------------------------------------------------- caisse */
  const lignesCaisse: Ligne[] = mouvements.map((m) => ({
    cle: m.id,
    nom: `${m.sens === SENS_CAISSE.depense ? "Dépense" : "Recette"} : ${libelleCategorie(m.categorie).toLowerCase()}`,
    montant: m.montant,
    objet: [m.saisi_par ? `Saisie par ${m.saisi_par}` : null, m.note].filter(Boolean).join(" · "),
    quand: `saisie le ${dateCourte(m.saisi_le)} · datée du ${dateCourte(m.date_mouvement)}`,
    pieces: [],
    alerte: null,
    depuis: m.saisi_le,
    decision: (
      <Decision valider={validerMouvement} rejeter={rejeterMouvement} champs={{ id: m.id }} motifAuMembre={false} />
    ),
  }));

  const groupes: Groupe[] = [
    { cle: "versements" as const, titre: "Versements", lignes: lignesVersements },
    { cle: "penalites" as const, titre: "Règlements de pénalités", lignes: lignesPenalites },
    { cle: "caisse" as const, titre: "Caisse", lignes: lignesCaisse },
  ].filter((g) => g.lignes.length > 0);

  const toutes = groupes.flatMap((g) => g.lignes);
  const encaissements = [...lignesVersements, ...lignesPenalites].reduce((t, l) => t + l.montant, 0);
  const plusAncienne = toutes.map((l) => l.depuis).sort()[0];
  const attente = plusAncienne ? joursDepuis(plusAncienne) : 0;
  const affiches = filtre ? groupes.filter((g) => g.cle === filtre) : groupes;

  return (
    <>
      <EnTeteEcran
        titre="À valider"
        sous="en attente de votre visa"
        brut={toutes.length}
        unite={accorde(toutes.length, "déclaration", "déclarations")}
        detail={
          toutes.length === 0
            ? "Rien n'attend : tout ce que les membres ont déclaré est traité."
            : [
                encaissements > 0 ? `${fcfa(encaissements)} à retrouver sur le compte du club` : null,
                lignesCaisse.length > 0
                  ? `${lignesCaisse.length} ${accorde(lignesCaisse.length, "mouvement", "mouvements")} de caisse`
                  : null,
              ]
                .filter(Boolean)
                .join(", et ") +
              (attente > 0
                ? `. La plus ancienne attend depuis ${attente} ${accorde(attente, "jour")}.`
                : ". La plus ancienne date d'aujourd'hui.")
        }
      />

      {toutes.length === 0 ? (
        <p className="flex items-center gap-2.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
          <GlypheEtat statut="paye" taille={18} />
          Vous êtes à jour.
        </p>
      ) : (
        <>
          {/*
            * Les filtres sont des liens : le choix survit au rechargement, et la
            * page reste rendue au serveur. Un groupe vide n'a pas de filtre.
            */}
          <nav aria-label="Filtrer" className="sans-impression flex flex-wrap gap-2">
            {FILTRES.filter((f) => f.cle === null || groupes.some((g) => g.cle === f.cle)).map((f) => {
              const nb = f.cle ? (groupes.find((g) => g.cle === f.cle)?.lignes.length ?? 0) : toutes.length;
              const ici = filtre === f.cle;
              return (
                <Link
                  key={f.libelle}
                  href={f.cle ? `/a-valider?type=${f.cle}` : "/a-valider"}
                  scroll={false}
                  aria-current={ici ? "true" : undefined}
                  className="tapable inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-semibold"
                  style={
                    ici
                      ? { background: "var(--ink)", color: "var(--page)", borderColor: "var(--ink)" }
                      : { color: "var(--ink-2)", borderColor: "var(--line-2)" }
                  }
                >
                  {f.libelle} · {nb}
                </Link>
              );
            })}
          </nav>

          {affiches.map((g) => (
            <section key={g.cle} className="revele">
              <h2 className="mb-1 text-[15px] font-semibold">
                {g.titre} · {g.lignes.length}
              </h2>
              <ul>
                {g.lignes.map((l) => (
                  <li
                    key={l.cle}
                    className="flex flex-col gap-2 py-3.5"
                    style={{ borderTop: "1px solid var(--line)" }}
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{l.nom}</span>
                      <span className="flex-none text-[15px] font-semibold tabular-nums"><Voilable>{fcfa(l.montant)}</Voilable></span>
                    </div>
                    {l.objet && (
                      <p className="text-[13px] leading-snug" style={{ color: "var(--ink-2)" }}>
                        {avecMontants(l.objet)}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2.5">
                      {l.pieces.map((j) => (
                        <a
                          key={j.id}
                          href={`/api/justificatif/${j.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="tapable inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-[12.5px]"
                          style={{ background: "var(--sunk)", color: "var(--ink)" }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            className="flex-none"
                            style={{ fill: "none", stroke: "var(--ink-2)", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}
                          >
                            <path d="M21 11.5 L12.5 20 A5 5 0 0 1 5.4 12.9 L13.6 4.7 A3.3 3.3 0 0 1 18.3 9.4 L10.2 17.5 A1.7 1.7 0 0 1 7.8 15.1 L15.3 7.6" />
                          </svg>
                          <span className="truncate">{j.nom}</span>
                        </a>
                      ))}
                      <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                        {l.quand}
                      </span>
                    </div>
                    {l.alerte && (
                      <p
                        className="rounded-lg px-2.5 py-2 text-[12.5px] leading-snug"
                        style={{ background: "var(--etat-attente-fond)", color: "var(--etat-attente)" }}
                      >
                        {avecMontants(l.alerte)}
                      </p>
                    )}
                    {l.decision}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p
            className="pt-3.5 text-[12.5px] leading-relaxed"
            style={{ borderTop: "1px solid var(--line)", color: "var(--ink-3)" }}
          >
            Valider porte la déclaration au registre et met à jour la part du membre. Rejeter demande un
            motif, envoyé au membre par courriel ; pour la caisse, il reste au journal.
          </p>
        </>
      )}
    </>
  );
}
