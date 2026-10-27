import Link from "next/link";
import type { CelluleMois } from "@/lib/penalites";
import { exigerMembre } from "@/lib/auth";
import {
  HORIZON_AVANCES,
  circuitReglementsPret,
  listerMembres,
  listerVersements,
  reglagesEffectifs,
  relancesRecentes,
  situationsClub,
  versementsEnAttente,
  type RelanceTracee,
} from "@/lib/queries";
import { CANAL_RELANCE, destinatairesARelancer, sujetRelance, texteRelance, type Destinataire } from "@/lib/relance";
import { cotisationsARegler } from "@/lib/penalites";
import { relancerMembre } from "@/app/actions/relances";
import { RelanceMembre } from "@/components/relance-membre";
import { listeDesMois } from "@/lib/sortie";
import { REGLES, accorde, dateCourte, deMois, debutMois, fcfa, lienDuSite, moisLong, nombre } from "@/lib/settings";
import { relancerMaintenant } from "@/app/actions/administration";
import {
  annulerVersementValide,
  corrigerVersement,
  declarerRetard,
  declarerVersement,
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
import { Carte, EnTeteEcran } from "@/components/ui";
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
  estEntame,
  initialeMois,
  statutAvances,
  statutLigne,
} from "@/components/glyphe-etat";
import { MODES_AFFICHES, STATUT_VERSEMENT, libelleMode } from "@/lib/valeurs";
import { Chiffre } from "@/components/chiffre";
import { Voilable, avecMontants } from "@/components/voilable";

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
  const verse = c.dateVersement ? `Versé le ${dateCourte(c.dateVersement)}.` : null;
  switch (c.statut) {
    case "paye":
      return verse ?? "Mois soldé.";
    case "paye_en_retard":
      return `${verse ?? "Mois soldé"} La pénalité reste due (art. 9).`;
    case "en_attente":
      return "Déclaré, en attente de validation par le trésorier.";
    case "partiel":
      return `${verse ? `${verse} ` : ""}Il manque ${fcfa(c.manque)}.`;
    case "retard":
      return `Rien de versé : ${fcfa(c.manque > 0 ? c.manque : c.requis)} dus depuis le ${REGLES.jourEcheance}.`;
    case "a_venir":
      if (verse) return `${verse} Mois payé d'avance.`;
      return c.montant > 0
        ? `${fcfa(c.montant)} versés d'avance : il manque ${fcfa(c.manque)} avant le ${REGLES.jourEcheance}.`
        : `Pas encore dû : échéance au ${REGLES.jourEcheance}.`;
    case "hors_periode":
      return "";
  }
}

/**
 * Un mois porte par plusieurs versements, dit versement par versement.
 *
 * Octobre lisait « 7 500 FCFA, verse le 10/10, Note : cotisation impayee de
 * KONE Bourama reprise au rachat » : la note d'une seule des deux lignes, sous
 * le total des deux. On croyait le mois paye par la reprise. Chaque versement
 * dit maintenant ce qu'il est : le sien, a sa date, et la cotisation reprise
 * au sortant, a part. Null pour un mois d'un seul versement : la phrase
 * habituelle suffit.
 */
function compositionDuMois(
  lignes: { montant: number; date_versement: string; note: string | null; statut: string }[],
): string | null {
  const valables = lignes.filter((v) => v.statut !== STATUT_VERSEMENT.rejete);
  if (valables.length < 2) return null;
  const morceaux = valables.map((v) => {
    const reprise = /^Cotisation impayée de (.+?), reprise/.exec(v.note ?? "");
    const attente = v.statut === STATUT_VERSEMENT.enAttente ? " (en attente de validation)" : "";
    return reprise
      ? `${fcfa(v.montant)} de cotisation impayée de ${reprise[1]}, reprise au rachat${attente}`
      : `${fcfa(v.montant)} versés le ${dateCourte(v.date_versement)}${attente}` +
          (v.note ? ` (${v.note})` : "");
  });
  return `${morceaux.join(", plus ")}.`;
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
  searchParams: Promise<{ ordre?: string; mois?: string }>;
}) {
  const membre = await exigerMembre();
  const parametres = await searchParams;
  const ordre = parametres.ordre === "nom" ? "nom" : "urgence";
  /* Les mois passes, ou ceux qui viennent : la grille se deplace pour montrer les avances. */
  const vue = parametres.mois === "avenir" ? "avenir" : "passes";
  const lien = (o: typeof ordre, v: typeof vue) => {
    const q = new URLSearchParams();
    if (o === "nom") q.set("ordre", "nom");
    if (v === "avenir") q.set("mois", "avenir");
    const texte = q.toString();
    return texte ? `/versements?${texte}` : "/versements";
  };

  let situations, enAttente, membres, pieces, valides, reglages;
  try {
    [situations, enAttente, membres, pieces, valides, reglages] = await Promise.all([
      situationsClub(),
      versementsEnAttente(),
      listerMembres(),
      justificatifsParLot(),
      listerVersements({ statut: STATUT_VERSEMENT.valide, parSaisie: true }),
      reglagesEffectifs(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const peutValider = peut(membre, "validerVersement");
  /* Une declaration, un lot : le compte que la boite « A valider » montrera. */
  const nbDeclarations = new Set(enAttente.map((v) => v.lot)).size;
  const peutCorriger = peut(membre, "corrigerVersement");
  const peutRelancer = peut(membre, "relancer");

  /*
   * LA RELANCE D'UN MEMBRE, DEPUIS SA LIGNE.
   *
   * Pour le bureau seulement : le courrier que chacun recevrait aujourd'hui,
   * calcule comme au passage automatique, et ce qui lui est deja parti. Un
   * membre a jour n'a rien a se voir reclamer : sa ligne n'a pas de bouton.
   */
  const [aRelancer, relances, circuit] = peutRelancer
    ? await Promise.all([
        destinatairesARelancer().catch(() => new Map<string, Destinataire>()),
        relancesRecentes(),
        circuitReglementsPret(),
      ])
    : [new Map<string, Destinataire>(), new Map<string, RelanceTracee[]>(), true];
  const libelleRelance = (r: RelanceTracee) => {
    const jour = Number(r.date.slice(8, 10));
    const base =
      r.canal === CANAL_RELANCE.individuelle
        ? "Courriel envoyé par le bureau"
        : r.canal === CANAL_RELANCE.groupee
          ? "Relance de tous les retardataires, par le bureau"
          : jour < reglages.jourEcheance
            ? "Courriel automatique, avant l'échéance"
            : jour === reglages.jourEcheance
              ? "Courriel automatique, le jour de l'échéance"
              : "Courriel automatique, après l'échéance";
    return r.ok ? base : `${base} (échec d'envoi)`;
  };
  const relanceDe = (membreId: string) => {
    const d = aRelancer.get(membreId);
    if (!d) return null;
    const traces = relances.get(membreId) ?? [];
    const ceMois = traces.filter((r) => r.ok && r.date.slice(0, 7) === debutMois().slice(0, 7)).length;
    const cotisations = cotisationsARegler(d.situation.cellules).total;
    const penalites = d.dette.montant + d.nonInscrites.montant;
    return (
      <RelanceMembre
        membreId={membreId}
        nom={d.situation.nom}
        sujet={sujetRelance(d, debutMois(), new Date())}
        texte={texteRelance(d, lienDuSite(), new Date(), circuit)}
        historique={traces.slice(0, 4).map((r) => ({
          date: dateCourte(r.date).slice(0, 5),
          libelle: libelleRelance(r),
          echec: !r.ok,
        }))}
        ceMois={ceMois > 0 ? `${ceMois} en ${moisLong(debutMois()).split(" ")[0]}` : null}
        du={
          `Dû à ce jour : ${fcfa(cotisations)} de cotisations` +
          (penalites > 0 ? ` et ${fcfa(penalites)} de pénalités.` : ".")
        }
        relancer={relancerMembre}
      />
    );
  };
  // Les corrections portent sur des saisies recentes : au-dela, on ne corrige plus, on regularise.
  const corrigibles = valides.slice(0, 40);
  const saisieDirecte = peut(membre, "saisirVersementValide");
  /*
   * Quatorze mois : au-dela, la grille devient illisible sur telephone. Les
   * quatorze derniers, ou le mois courant et les treize suivants : la meme
   * grille, poussee vers la droite, montre jusqu'ou chacun a paye d'avance.
   */
  const fenetreDe = (s: { cellules: CelluleMois[]; avances: CelluleMois[] }) =>
    vue === "avenir" ? [...s.cellules.slice(-1), ...s.avances.slice(0, HORIZON_AVANCES)] : s.cellules.slice(-14);
  const moisAffiches = situations[0] ? fenetreDe(situations[0]) : [];
  const maSituation = situations.find((s) => s.membreId === membre.id);
  /* Les parts rachetees que ce membre detient : il les paie, chacune a part. */
  const mesParts = membres.filter((m) => m.titulaireId === membre.id);
  const aujourdhui = debutMois();

  /*
   * Le mois a proposer : le premier qui reste a regler.
   *
   * Le formulaire proposait le mois courant. Pour un membre en retard, c'etait
   * precisement le mois a ne pas choisir ; pour un membre a jour, c'etait un
   * mois deja paye, que la declaration refuse. Dans les deux cas il proposait
   * un refus. `prochainMoisARegler` repond aux deux : le plus ancien mois
   * ouvert s'il en reste un, sinon le premier mois que les avances ne couvrent
   * pas encore.
   */
  const aRegler = maSituation?.prochainReglement ?? null;
  /* Passe le mois courant, c'est qu'il n'y a plus de retard : le ton change. */
  const enAvance = aRegler !== null && aRegler.mois > aujourdhui;

  /*
   * Sur combien : ceux a qui le mois est du. Une part rachetee qui ne cotise
   * qu'a partir du mois suivant n'entre pas dans le compte ; l'accueil, lui,
   * l'en ecartait deja, et les deux pages annoncaient « 5 sur 7 » et « 5 sur 9 ».
   */
  const dusCeMois = situations.filter((x) => {
    const c = x.cellules.find((y) => y.mois === aujourdhui);
    return c !== undefined && c.statut !== "hors_periode";
  }).length;

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
   * UNE PART RACHETEE AVANT SON PREMIER MOIS N'A RIEN A MONTRER DANS LA GRILLE.
   *
   * Ses mois commencent a la premiere echeance qui suit le rachat ; d'ici la, sa
   * frise etait une rangee de cases vides sous « A jour », et rien ne disait
   * quand elle cotiserait, ni combien, ni ce que l'acheteur avait repris des
   * impayes du sortant -- ces mois-la tombent avant son debut et n'ont pas de
   * case. La ligne le dit en mots.
   */
  const partsRachetees = new Map(membres.filter((m) => m.titulaireId).map((m) => [m.id, m]));
  const debutDeLaPart = (id: string): string | null => {
    const part = partsRachetees.get(id);
    if (!part) return null;
    const montant = Math.round((part.fraction ?? 1) * reglages.cotisationMensuelle);
    return `Cotise ${fcfa(montant)} par mois à partir ${deMois(part.date_adhesion)}.`;
  };
  const reprisAuRachat = (id: string): string | null => {
    const part = partsRachetees.get(id);
    if (!part) return null;
    const repris = [...valides, ...enAttente].filter(
      (v) => v.membre_id === id && v.mois < part.date_adhesion && v.statut !== STATUT_VERSEMENT.rejete,
    );
    if (repris.length === 0) return null;
    const total = repris.reduce((t, v) => t + v.montant, 0);
    const attente = repris
      .filter((v) => v.statut === STATUT_VERSEMENT.enAttente)
      .reduce((t, v) => t + v.montant, 0);
    return (
      `Cotisations impayées reprises au rachat : ${fcfa(total)} ` +
      `(${listeDesMois([...new Set(repris.map((v) => v.mois))])})` +
      (attente === 0
        ? ", validées."
        : attente === total
          ? ", en attente de validation."
          : `, dont ${fcfa(attente)} en attente de validation.`)
    );
  };

  /*
   * L'ordre d'urgence remonte ce qui reclame une action : ce qui manque, puis
   * ce qui attend une validation, puis ce qui est en regle ; a egalite, le plus
   * de mois concernes d'abord, puis le nom. C'est un ordre d'affichage : il ne
   * touche a aucun calcul, et le tri par nom rend la liste au classement connu.
   */
  /* Le detail d'une ligne : les quatre mois les plus proches d'aujourd'hui, le plus proche en tete. */
  const procheDAujourdhui = (mois: CelluleMois[]) =>
    vue === "avenir" ? mois.slice(0, 4) : mois.slice(-4).reverse();

  const lignesRegistre = situations
    .map((s) => {
      const fenetre = fenetreDe(s);
      /* Vers l'avenir, ce qui reclame un geste est l'avance a completer avant son echeance. */
      const du =
        vue === "avenir"
          ? fenetre.filter(estEntame).length
          : fenetre.filter((c) => c.statut === "retard" || c.statut === "partiel").length;
      const attente = fenetre.filter((c) => c.statut === "en_attente").length;
      return {
        s,
        fenetre,
        statut: vue === "avenir" ? statutAvances(s.avances) : statutLigne(fenetre),
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
          titre={`Cotisations ${deMois(aujourdhui)}`}
          chiffre={
            <>
              <Chiffre valeur={payesCeMois} format="entier" /> sur {dusCeMois}
            </>
          }
          detail={
            enAttente.length > 0
              ? `${enAttente.length} déclaration${enAttente.length > 1 ? "s" : ""} en attente de validation.`
              : "Aucune déclaration en attente."
          }
        />
        <div className="sans-impression flex flex-wrap gap-2.5">
          {peutRelancer && (
            <Panneau
              libelle="Relancer maintenant"
              titre="Relancer les retardataires"
              variante="secondaire"
              introduction="La relance part d'elle-même le 10 de chaque mois. Entre deux, vous pouvez l'envoyer à la main : c'est exactement le même courrier (mois manquants, pénalités, rappels R2, R3 et R4, mesures disciplinaires). Seuls les membres concernés le reçoivent ; ceux qui sont à jour n'en reçoivent jamais."
            >
              <FormulaireAction action={relancerMaintenant} libelle="Relancer maintenant" />
            </Panneau>
          )}
          <Panneau
            libelle={saisieDirecte ? "Enregistrer un versement" : "Déclarer un versement"}
            titre={saisieDirecte ? "Enregistrer un versement" : "Déclarer un versement"}
            introduction={
              saisieDirecte
                ? "Votre saisie vaut validation : vous constatez un encaissement, pour vous ou pour un autre membre."
                : "Votre déclaration est visible de tous immédiatement, et reste en attente jusqu'à la validation du trésorier qui tient la caisse. Il en est prévenu par courriel, vous et le président en copie."
            }
          >
            <FormulaireAction action={declarerVersement} libelle="Déclarer">
              {saisieDirecte && (
                <Selection
                  nom="membreId"
                  libelle="Pour le compte de"
                  valeur={String(membre.id)}
                  options={membres.map((m) => ({ valeur: String(m.id), libelle: m.nom }))}
                />
              )}
              {/*
                * UNE PART RACHETEE SE PAIE A PART. Elle a ses propres mois et ses
                * propres penalites : le detenteur dit laquelle il regle, et le
                * versement s'impute sur elle seule.
                */}
              {!saisieDirecte && mesParts.length > 0 && (
                <Selection
                  nom="membreId"
                  libelle="Pour quelle part"
                  valeur={String(membre.id)}
                  options={[
                    { valeur: String(membre.id), libelle: "Ma part" },
                    ...mesParts.map((m) => ({ valeur: m.id, libelle: m.nom })),
                  ]}
                />
              )}
              {/*
                * COTISATION OU PENALITE, AU MEME ENDROIT.
                *
                * Les deux se declaraient sur deux pages. Qui versait les deux
                * en un seul transfert declarait le tout ici, et sa penalite
                * restait due sans qu'il comprenne pourquoi. Le demander ote
                * aussi la question de savoir ce que l'argent eteint d'abord :
                * le membre sait ce qu'il a paye, et les statuts ne rendent les
                * deux indissociables qu'au 10/01/2027.
                */}
              <Selection
                nom="nature"
                libelle="Ce que vous réglez"
                valeur="cotisation"
                options={[
                  { valeur: "cotisation", libelle: "Une cotisation mensuelle" },
                  { valeur: "penalite", libelle: "Une pénalité" },
                ]}
              />
              {/*
                * UN CHAMP, LA OU IL Y EN AVAIT TROIS.
                *
                * Mois de depart, nombre de mois, montant par mois : on
                * demandait au membre une information que le site possede. Les
                * mois se reglent dans l'ordre, donc le premier mois impute est
                * determine ; le montant verse dit le reste. Le montant propose
                * est ce qu'il reste a porter au prochain mois -- 3 000 et non
                * 5 000 si un acompte de 2 000 y figure deja.
                *
                * L'imputation exacte est annoncee apres l'envoi, mois par
                * mois : c'est la qu'elle est sure, et pour un autre membre
                * c'est la seule facon de la dire juste.
                */}
              <Champ
                nom="montant"
                libelle="Montant versé (FCFA)"
                type="number"
                valeur={aRegler?.reste ?? REGLES.cotisationMensuelle}
                min={1}
                aide={
                  (aRegler === null
                    ? "Cotisation : votre versement couvre les mois dans l'ordre, du plus ancien au plus récent."
                    : enAvance
                      ? `Cotisation : ce versement ira sur ${moisLong(aRegler.mois)}, puis sur les mois suivants s'il les dépasse.`
                      : `Cotisation : ce versement ira sur ${moisLong(aRegler.mois)}, le plus ancien mois ouvert, puis sur les suivants s'il le dépasse.`) +
                  " Pénalité : il solde les plus anciennes d'abord, et une pénalité se règle entière." +
                  (saisieDirecte
                    ? " Pour un autre membre, c'est sa propre situation qui s'applique ; une pénalité, elle, se solde depuis la page Pénalités."
                    : mesParts.length > 0
                      ? " Pour une part rachetée, ce sont ses propres mois et ses propres pénalités qui s'appliquent."
                      : "")
                }
              />
              {/*
                * LES DEUX DETTES NE SE DECLARENT PAS AU MEME ENDROIT.
                *
                * Une penalite ne couvre aucun mois : elle vise une ligne du
                * registre, et le tresorier la solde contre cette ligne. Elle a
                * donc son propre formulaire. Un membre qui vient de verser
                * cotisation et penalite en un seul transfert n'a aucune raison
                * de le savoir -- il declare le tout ici, et sa penalite reste
                * due sans qu'il comprenne pourquoi. La note ne parait que
                * lorsqu'il en reste une a regler.
                */}
              {(maSituation?.nbPenalitesImpayees ?? 0) > 0 && (
                <p className="mt-3 text-[12px]" style={{ color: "var(--discret)" }}>
                  Vous avez aussi des pénalités dues : choisissez « une pénalité » ci-dessus
                  pour en déclarer le règlement. Le détail de chaque ligne se lit sur{" "}
                  <Link href="/penalites" className="underline">
                    Pénalités
                  </Link>
                  .
                </p>
              )}
              <Champ
                nom="dateVersement"
                libelle="Date du versement"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Selection nom="mode" libelle="Mode" options={MODES_AFFICHES} />
              <Champ nom="reference" libelle="Référence du paiement (facultatif)" requis={false} />
              <Champ nom="note" libelle="Note (facultatif)" requis={false} />
              <ChampJustificatif />
            </FormulaireAction>
          </Panneau>
        </div>
      </div>

      {/*
        * Vide, elle occupait le premier ecran du telephone pour dire « rien a
        * valider » -- ce que l'en-tete dit deja, « aucune declaration en
        * attente ». Elle ne parait que lorsqu'elle a quelque chose a montrer.
        */}
      {peutValider && enAttente.length > 0 && (
        /*
         * La file se traite dans la boite « A valider », avec les reglements de
         * penalites et la caisse : une seule page a ouvrir pour tout viser.
         */
        <Carte titre={`À valider (${nbDeclarations})`}>
          <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
            {nbDeclarations} {accorde(nbDeclarations, "déclaration", "déclarations")} en attente de votre visa.{" "}
            <Link href="/a-valider" className="font-medium underline" style={{ color: "var(--accent)" }}>
              Ouvrir la boîte À valider
            </Link>
          </p>
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
                href={lien(cle, vue)}
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

        {/* Meme principe : un lien, que le rechargement et le partage conservent. */}
        <div className="sans-impression mb-3 flex items-center gap-2 text-xs">
          <span style={{ color: "var(--discret)" }}>Mois affichés</span>
          <div
            className="ml-auto inline-flex overflow-hidden rounded-xl border"
            style={{ borderColor: "var(--bordure)" }}
          >
            {(
              [
                ["passes", "Passés"],
                ["avenir", "À venir"],
              ] as const
            ).map(([cle, libelle]) => (
              <Link
                key={cle}
                href={lien(ordre, cle)}
                scroll={false}
                aria-current={vue === cle ? "true" : undefined}
                className="grid min-h-11 place-items-center px-4 text-[13px] font-semibold"
                style={
                  vue === cle
                    ? { background: "var(--ink)", color: "var(--page)" }
                    : { color: "var(--discret)" }
                }
              >
                {libelle}
              </Link>
            ))}
          </div>
        </div>
        {vue === "avenir" && (
          <p className="mb-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--discret)" }}>
            <GlypheEtat statut="a_venir" entame taille={16} />
            <span>
              À compléter : payé en partie d&apos;avance, le reste est dû avant le {REGLES.jourEcheance}.
            </span>
          </p>
        )}

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
                      {partsRachetees.has(s.membreId) &&
                      fenetre.every((c) => c.statut === "hors_periode") ? (
                        <p className="text-[12px]" style={{ color: "var(--discret)" }}>
                          {avecMontants(debutDeLaPart(s.membreId))}
                        </p>
                      ) : (
                        <Frise cellules={fenetre} taille={18} etiquette={s.nom} />
                      )}
                    </div>
                  </summary>

                  <div
                    className="border-t px-3 py-3"
                    style={{ borderColor: "var(--bordure)", background: "var(--carte)" }}
                  >
                    <ul className="space-y-2.5">
                      {procheDAujourdhui(
                        fenetre.filter(
                          (c) => c.statut !== "hors_periode" && !(c.statut === "a_venir" && c.montant === 0),
                        ),
                      ).map((c) => {
                          const lignes = versementsDuMois.get(`${s.membreId}|${c.mois}`) ?? [];
                          const composition = compositionDuMois(lignes);
                          const note = composition ? null : (lignes.find((v) => v.note)?.note ?? null);
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
                                    {estEntame(c) ? "À compléter" : LIBELLE_STATUT[c.statut]}
                                  </span>
                                  <span className="ml-auto font-semibold whitespace-nowrap tabular-nums">
                                    <Voilable>
                                      {c.manque > 0 && c.montant > 0
                                        ? `${nombre(c.montant)} sur ${fcfa(c.requis)}`
                                        : fcfa(c.montant > 0 ? c.montant : c.requis)}
                                    </Voilable>
                                  </span>
                                </div>
                                <p className="text-[12px]" style={{ color: "var(--discret)" }}>
                                  {avecMontants(composition ?? detailDuMois(c))}
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
                    {peutRelancer && relanceDe(s.membreId)}
                    {/* Le debut de la part ne se repete pas : la ligne fermee le dit deja tant qu'elle n'a aucun mois. */}
                    {partsRachetees.has(s.membreId) && (
                      <div className="text-[12px]" style={{ color: "var(--discret)" }}>
                        {!fenetre.every((c) => c.statut === "hors_periode") && <p>{avecMontants(debutDeLaPart(s.membreId))}</p>}
                        {reprisAuRachat(s.membreId) && <p className="mt-1">{avecMontants(reprisAuRachat(s.membreId))}</p>}
                      </div>
                    )}
                    <p className="mt-3 text-[12px]" style={{ color: "var(--discret)" }}>
                      Versé depuis le début :{" "}
                      <span className="font-semibold tabular-nums" style={{ color: "var(--texte)" }}>
                        <Voilable>{fcfa(s.verse)}</Voilable>
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
        <Carte titre="Déclarer un retard (R3)">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            La résolution R3 impose de signaler son retard sur le groupe
            WhatsApp, en taguant tous les membres, au plus tard le lendemain de
            l&apos;entrée dans le 2e mois. Enregistrez ici la déclaration faite
            : elle préserve votre droit au plan de redressement prévu par R5.
          </p>
          <Depliant titre="Enregistrer ma déclaration">
            <FormulaireAction
              action={declarerRetard}
              libelle="Enregistrer la déclaration"
            >
              <Selection
                nom="mois"
                libelle="Mois concerné"
                options={maSituation.moisEnRetard.map((m) => ({
                  valeur: m,
                  libelle: moisLong(m),
                }))}
              />
              <Champ
                nom="note"
                libelle="Précision (facultatif)"
                requis={false}
              />
            </FormulaireAction>
          </Depliant>
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
       *
       * APRES LE REGISTRE, ET REPLIEE. Elle s'etalait avant lui sur trois pages
       * d'impression -- cinq ecrans de telephone --, si bien que le registre,
       * ce qu'on vient voir, n'arrivait qu'a la fin. Elle reste a portee d'un
       * geste.
       */}
      {corrigibles.length > 0 && (
        <Carte titre="Derniers versements enregistrés">
          <Depliant
            titre={
              peutCorriger
                ? `Afficher les ${corrigibles.length} dernières saisies, pour vérifier ou corriger`
                : `Afficher les ${corrigibles.length} dernières saisies`
            }
          >
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            {peutCorriger
              ? "Les saisies les plus récentes, justificatifs compris. Une erreur n'est pas définitive : la correction ne remplace pas en silence, l'état antérieur reste inscrit sur la ligne et au journal, et le motif est obligatoire."
              : "Les saisies les plus récentes, justificatifs compris. Chacun peut vérifier ce qui a été encaissé, pour lui comme pour les autres : les comptes du club sont ouverts à tous ses membres (art. 12)."}
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
                    Versé le {dateCourte(v.date_versement)} &middot;{" "}
                    {libelleMode(v.mode)}
                    {v.reference ? ` · ${v.reference}` : ""}
                    {v.valide_par_nom
                      ? ` · validé par ${v.valide_par_nom}`
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
                          aide="Le premier du mois. Un mois déjà couvert pour ce membre est refusé."
                        />
                        <Selection
                          nom="mode"
                          libelle="Mode"
                          valeur={v.mode}
                          options={MODES_AFFICHES}
                        />
                        <Champ
                          nom="reference"
                          libelle="Référence"
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
                          été compté deux fois : l&apos;annulation libère le
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
          </Depliant>
        </Carte>
      )}
    </>
  );
}
