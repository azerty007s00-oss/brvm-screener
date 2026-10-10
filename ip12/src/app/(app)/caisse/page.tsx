import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerMouvementsCaisse, synthese } from "@/lib/queries";
import {
  enregistrerMouvement,
  regulariserCaisse,
  rejeterMouvement,
  validerMouvement,
} from "@/app/actions/caisse";
import { dateCourte, fcfa } from "@/lib/settings";
import {
  CATEGORIES_DEPENSE,
  CATEGORIES_RECETTE,
  SENS_CAISSE,
  STATUT_CAISSE,
  libelleCategorie,
} from "@/lib/valeurs";
import {
  Champ,
  ChampCache,
  FormulaireAction,
  Selection,
} from "@/components/formulaires";
import {
  Badge,
  Carte,
  CarteEtat,
  EnTeteEcran,
  GroupeReplie,
  Vide,
} from "@/components/ui";
import { Panneau } from "@/components/panneau";
import { ChampMenu, MenuLigne } from "@/components/menu-ligne";
import {
  EcranInitialisation,
  estTableAbsente,
} from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Caisse" };

export default async function PageCaisse() {
  const membre = await exigerMembre();
  const gere = peut(membre, "gererCaisse");
  /*
   * `gere` ouvre la saisie et l'annulation : c'est le meme titre, celui qui
   * tient la caisse. Le visa d'une ecriture restee en attente demeure au
   * president -- il n'en arrive plus de nouvelle, mais la base en porte peut-etre.
   */
  const valide = peut(membre, "gererReglages");

  let mouvements, s;
  try {
    [mouvements, s] = await Promise.all([listerMouvementsCaisse(), synthese()]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const enAttente = mouvements.filter(
    (m) => m.statut === STATUT_CAISSE.enAttente,
  );

  /*
   * Le journal se lit par nature, non ligne a ligne.
   *
   * Dix-huit frais bancaires de quelques centaines de francs noyaient deux
   * ecritures importantes. Les mouvements de meme categorie et de meme sens se
   * rassemblent donc sous une ligne de total, l'ordre restant celui du mouvement
   * le plus recent de chaque groupe : la chronologie survit au regroupement.
   *
   * Un groupe d'une seule ligne s'affiche tel quel, sans repli.
   */
  const parNature = new Map<string, typeof mouvements>();
  for (const m of mouvements) {
    const cle = `${m.sens}|${m.categorie}`;
    const liste = parNature.get(cle);
    if (liste) liste.push(m);
    else parNature.set(cle, [m]);
  }
  const groupes = [...parNature.entries()]
    .map(([cle, lignes]) => {
      const dates = lignes.map((m) => m.date_mouvement).sort();
      const signe = lignes[0].sens === SENS_CAISSE.depense ? -1 : 1;
      return {
        cle,
        libelle: libelleCategorie(lignes[0].categorie),
        lignes,
        total: signe * lignes.reduce((t, m) => t + m.montant, 0),
        depuis: dateCourte(dates[0]),
        jusqua: dateCourte(dates[dates.length - 1]),
        recent: dates[dates.length - 1],
      };
    })
    .sort((a, b) => b.recent.localeCompare(a.recent));

  /*
   * Trois saisies, trois panneaux : le journal n'est plus repousse sous deux
   * formulaires qu'on ouvre une fois par mois.
   */
  const saisies = gere ? (
    <>
      <Panneau
        libelle="Aligner sur le solde réel"
        titre="Régulariser la caisse"
        variante="secondaire"
        introduction={`Quand la caisse réelle ne correspond pas au calcul (le plus souvent, des pénalités anciennes encaissées sans trace nominative), annoncez le solde que vous constatez. L'outil écrit l'écart dans le bon sens et en garde le motif. Solde calculé à cet instant : ${fcfa(s.totalEnCaisse)}.`}
      >
        <FormulaireAction action={regulariserCaisse} libelle="Inscrire l'écart">
          <Champ
            nom="soldeReel"
            libelle="Solde réellement constaté (FCFA)"
            type="number"
            min={0}
            valeur={Math.max(0, Math.round(s.totalEnCaisse))}
            aide="Ce que vous comptez en caisse, ou ce qu'affiche votre relevé."
          />
          <Champ nom="motif" libelle="Motif" aide="Restera inscrit au journal." />
        </FormulaireAction>
      </Panneau>

      {[
        {
          sens: SENS_CAISSE.recette,
          titre: "Enregistrer une recette",
          categories: CATEGORIES_RECETTE,
          aide: "Ce que vous voudrez relire dans six mois : d'où vient cet argent.",
          variante: "secondaire" as const,
        },
        {
          sens: SENS_CAISSE.depense,
          titre: "Enregistrer une dépense",
          categories: CATEGORIES_DEPENSE,
          aide: "Ce que vous voudrez relire dans six mois : à quoi cet argent a servi.",
          variante: "principal" as const,
        },
      ].map((f) => (
        <Panneau
          key={f.sens}
          libelle={f.titre}
          titre={f.titre}
          variante={f.variante}
          introduction="Votre saisie vaut validation : vous tenez la caisse, vous constatez ce qui en sort et ce qui y entre. Une écriture fautive s'annule depuis le journal, motif à l'appui. Pour une somme dont le détail est perdu, choisissez la catégorie la plus proche et décrivez-la dans le motif : le solde tombera juste, et la provenance restera lisible."
        >
          <FormulaireAction action={enregistrerMouvement} libelle="Enregistrer">
            <ChampCache nom="sens" valeur={f.sens} />
            <Selection nom="categorie" libelle="Catégorie" options={f.categories} />
            <Champ nom="montant" libelle="Montant (FCFA)" type="number" min={1} />
            <Champ nom="date" libelle="Date" type="date" valeur={new Date().toISOString().slice(0, 10)} />
            <Champ nom="note" libelle="Motif" requis={false} aide={f.aide} />
          </FormulaireAction>
        </Panneau>
      ))}
    </>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <EnTeteEcran
          titre="Solde en caisse"
          sous={`arrêté au ${dateCourte(new Date().toISOString().slice(0, 10))}`}
          brut={s.totalEnCaisse}
          unite="FCFA"
          detail="Hors cotisations placées en bourse. Comparez-le à votre relevé : ce qui manque se voit là."
        />
        <div className="sans-impression flex flex-wrap gap-2.5">{saisies}</div>
      </div>

      <CarteEtat
        chiffres={[
          { libelle: "Recettes", brut: s.recettes, unite: "FCFA" },
          { libelle: "Dépenses", brut: s.depenses, unite: "FCFA" },
          {
            libelle: "Pénalités encaissées",
            brut: s.penalitesEncaissees,
            unite: "FCFA",
            contexte: "comptées dans le solde",
          },
        ]}
      />

      <Carte titre="Composition du solde">
        <ul className="space-y-1 text-sm">
          {[
            ["Cotisations validées", s.totalVerse, "+"],
            ["Pénalités encaissées", s.penalitesEncaissees, "+"],
            ["Recettes exceptionnelles", s.recettes, "+"],
            ["Dépenses de fonctionnement", s.depenses, "−"],
            ["Net viré au compte-titres", s.totalApports, "−"],
          ].map(([libelle, montant, signe]) => (
            <li key={String(libelle)} className="flex justify-between gap-2">
              <span style={{ color: "var(--discret)" }}>
                {signe as string} {libelle as string}
              </span>
              <span className="whitespace-nowrap tabular-nums">
                {fcfa(montant as number)}
              </span>
            </li>
          ))}
          <li
            className="flex justify-between gap-2 border-t pt-1 font-semibold"
            style={{ borderColor: "var(--bordure)" }}
          >
            <span>Solde disponible</span>
            <span className="whitespace-nowrap tabular-nums">
              {fcfa(s.totalEnCaisse)}
            </span>
          </li>
        </ul>
        <p className="mt-3 text-[11px]" style={{ color: "var(--discret)" }}>
          Un retrait depuis la SGI revient en caisse : le net viré tient compte
          des deux sens. Comparez ce solde à votre relevé pour vérifier que rien
          ne manque.
        </p>
      </Carte>

      {valide && enAttente.length > 0 && (
        <Carte titre={`À valider (${enAttente.length})`}>
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {enAttente.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-start justify-between gap-2 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {m.sens === SENS_CAISSE.depense ? "−" : "+"}{" "}
                    {fcfa(m.montant)} &middot; {libelleCategorie(m.categorie)}
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {dateCourte(m.date_mouvement)}
                    {m.saisi_par ? ` · saisi par ${m.saisi_par}` : ""}
                  </p>
                  {m.note && <p className="mt-0.5 text-xs italic">{m.note}</p>}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <FormulaireAction
                    action={validerMouvement}
                    libelle="Valider"
                    compact
                  >
                    <ChampCache nom="id" valeur={m.id} />
                  </FormulaireAction>
                  <FormulaireAction
                    action={rejeterMouvement}
                    libelle="Rejeter"
                    variante="danger"
                    compact
                    confirmation="Rejeter ce mouvement ?"
                  >
                    <ChampCache nom="id" valeur={m.id} />
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
              </li>
            ))}
          </ul>
        </Carte>
      )}

      <Carte titre={`Journal de caisse (${mouvements.length})`}>
        {mouvements.length === 0 ? (
          <Vide>Aucun mouvement enregistré.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {groupes.map(({ cle, libelle, lignes, total, depuis, jusqua }) => (
              <li key={cle}>
                <GroupeReplie
                  libelle={libelle}
                  nombre={lignes.length}
                  detail={
                    depuis === jusqua ? depuis : `de ${depuis} à ${jusqua}`
                  }
                  /*
                   * LE SIGNE DIT LE SENS, non la couleur.
                   *
                   * Recettes en vert et depenses en rouge, sur chaque ligne
                   * d'un journal qui n'est fait que de recettes et de
                   * depenses : la couleur n'y signalait plus rien, sinon que
                   * de l'argent avait bouge. Une depense prevue n'est pas une
                   * alerte. Le rouge est garde pour ce qui manque.
                   */
                  total={
                    <span>
                      {total < 0 ? "\u2212" : "+"} {fcfa(Math.abs(total))}
                    </span>
                  }
                >
                  <ul
                    className="divide-y"
                    style={{ borderColor: "var(--bordure)" }}
                  >
                    {lignes.map((m) => {
                      const depense = m.sens === SENS_CAISSE.depense;
                      return (
                        <li
                          key={m.id}
                          className="flex flex-wrap items-start justify-between gap-2 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                              <span className="tabular-nums">
                                {depense ? "\u2212" : "+"} {fcfa(m.montant)}
                              </span>
                              {m.statut === STATUT_CAISSE.enAttente && (
                                <Badge ton="ambre">En attente</Badge>
                              )}
                              {m.statut === STATUT_CAISSE.rejete && (
                                <Badge ton="rouge">Rejeté</Badge>
                              )}
                            </p>
                            <p
                              className="text-xs"
                              style={{ color: "var(--discret)" }}
                            >
                              {libelleCategorie(m.categorie)} &middot;{" "}
                              {dateCourte(m.date_mouvement)}
                              {m.valide_par
                                ? ` · validé par ${m.valide_par}`
                                : ""}
                            </p>
                            {m.note && (
                              <p className="mt-0.5 text-xs italic">{m.note}</p>
                            )}
                            {m.motif_refus && (
                              <p
                                className="mt-0.5 text-xs italic"
                                style={{ color: "var(--etat-manque)" }}
                              >
                                Rejet : {m.motif_refus}
                              </p>
                            )}
                          </div>
                          {/*
                           * Annuler une ecriture close. Sans cette commande,
                           * corriger une ligne validee demandait de lui opposer
                           * une ecriture inverse, qui decrivait a son tour un
                           * mouvement n'ayant pas eu lieu : le journal finissait
                           * par raconter le contraire de ce qui s'etait passe.
                           *
                           * Elle vit derriere les trois points, comme sur le
                           * portefeuille : vingt ecritures donnaient vingt
                           * boutons « Annuler » et vingt boites a motif, poses
                           * a demeure sur une page qu'on vient lire.
                           */}
                          {gere && m.statut === STATUT_CAISSE.valide && (
                            <MenuLigne
                              etiquette={`Actions sur l'écriture du ${dateCourte(m.date_mouvement)}`}
                              actions={[
                                {
                                  libelle: "Annuler ce mouvement",
                                  action: rejeterMouvement,
                                  champs: (
                                    <>
                                      <ChampCache nom="id" valeur={m.id} />
                                      <ChampMenu
                                        nom="motif"
                                        libelle="Motif de l'annulation"
                                        indication="Erreur de saisie, doublon..."
                                      />
                                    </>
                                  ),
                                  confirmation:
                                    "Annuler ce mouvement déjà validé ? Il cessera de compter dans la caisse, et l'opération restera au journal.",
                                  confirmer: "Annuler le mouvement",
                                },
                              ]}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </GroupeReplie>
              </li>
            ))}
          </ul>
        )}
      </Carte>
    </>
  );
}
