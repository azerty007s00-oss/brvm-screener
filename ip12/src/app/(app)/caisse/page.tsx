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
import { Champ, ChampCache, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Alerte, Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

export default async function PageCaisse() {
  const membre = await exigerMembre();
  const gere = peut(membre, "gererCaisse");
  const valide = peut(membre, "gererReglages");

  let mouvements, s;
  try {
    [mouvements, s] = await Promise.all([listerMouvementsCaisse(), synthese()]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const enAttente = mouvements.filter((m) => m.statut === STATUT_CAISSE.enAttente);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Statistique
          libelle="Solde en caisse"
          valeur={fcfa(s.totalEnCaisse)}
          accent={s.totalEnCaisse < 0 ? "rouge" : "or"}
        />
        <Statistique libelle="Recettes" valeur={fcfa(s.recettes)} accent="vert" />
        <Statistique libelle="Depenses" valeur={fcfa(s.depenses)} accent="rouge" />
        <Statistique
          libelle="Penalites encaissees"
          valeur={fcfa(s.penalitesEncaissees)}
          detail="comptees dans le solde"
        />
      </div>

      <Carte titre="Composition du solde">
        <ul className="space-y-1 text-sm">
          {[
            ["Cotisations validees", s.totalVerse, "+"],
            ["Penalites encaissees", s.penalitesEncaissees, "+"],
            ["Recettes exceptionnelles", s.recettes, "+"],
            ["Depenses de fonctionnement", s.depenses, "−"],
            ["Net vire au compte-titres", s.totalApports, "−"],
          ].map(([libelle, montant, signe]) => (
            <li key={String(libelle)} className="flex justify-between gap-2">
              <span style={{ color: "var(--discret)" }}>
                {signe as string} {libelle as string}
              </span>
              <span className="whitespace-nowrap tabular-nums">{fcfa(montant as number)}</span>
            </li>
          ))}
          <li
            className="flex justify-between gap-2 border-t pt-1 font-semibold"
            style={{ borderColor: "var(--bordure)" }}
          >
            <span>Solde disponible</span>
            <span className="whitespace-nowrap tabular-nums">{fcfa(s.totalEnCaisse)}</span>
          </li>
        </ul>
        <p className="mt-3 text-[11px]" style={{ color: "var(--discret)" }}>
          Un retrait depuis la SGI revient en caisse : le net vire tient compte des deux sens.
          Comparez ce solde a votre releve pour verifier que rien ne manque.
        </p>
      </Carte>

      {valide && enAttente.length > 0 && (
        <Carte titre={`A valider (${enAttente.length})`}>
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {enAttente.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {m.sens === SENS_CAISSE.depense ? "−" : "+"} {fcfa(m.montant)} &middot;{" "}
                    {libelleCategorie(m.categorie)}
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    {dateCourte(m.date_mouvement)}
                    {m.saisi_par ? ` · saisi par ${m.saisi_par}` : ""}
                  </p>
                  {m.note && <p className="mt-0.5 text-xs italic">{m.note}</p>}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <FormulaireAction action={validerMouvement} libelle="Valider" compact>
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

      {gere && (
        <Carte titre="Nouveau mouvement">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            {valide
              ? "Votre saisie vaut validation."
              : "Votre saisie attendra la validation du president."}
          </p>
          {/*
            * Un formulaire par sens, plutot qu'une liste unique.
            * Les deux nomenclatures partagent « regularisation » et « autre » :
            * concatenees, elles affichaient deux fois la meme entree. Et rien
            * n'empechait d'enregistrer des frais SGI en recette.
            */}
          {[
            {
              sens: SENS_CAISSE.depense,
              titre: "Enregistrer une depense",
              categories: CATEGORIES_DEPENSE,
              aide: "Ce que vous voudrez relire dans six mois : a quoi cet argent a servi.",
            },
            {
              sens: SENS_CAISSE.recette,
              titre: "Enregistrer une recette",
              categories: CATEGORIES_RECETTE,
              aide: "Ce que vous voudrez relire dans six mois : d'ou vient cet argent.",
            },
          ].map((f) => (
            <Depliant key={f.sens} titre={f.titre}>
              <FormulaireAction action={enregistrerMouvement} libelle="Enregistrer">
                <ChampCache nom="sens" valeur={f.sens} />
                <Selection nom="categorie" libelle="Categorie" options={f.categories} />
                <Champ nom="montant" libelle="Montant (FCFA)" type="number" min={1} />
                <Champ
                  nom="date"
                  libelle="Date"
                  type="date"
                  valeur={new Date().toISOString().slice(0, 10)}
                />
                <Champ nom="note" libelle="Motif" requis={false} aide={f.aide} />
              </FormulaireAction>
            </Depliant>
          ))}
          <div className="mt-3">
            <Alerte ton="ambre">
              Pour une somme dont le detail est perdu — des penalites anciennes deja encaissees, par
              exemple — choisissez la recette correspondante et decrivez-la dans le motif. Le solde
              tombera juste, et la provenance restera lisible.
            </Alerte>
          </div>
        </Carte>
      )}

      {gere && (
        <Carte titre="Regulariser la caisse">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Quand la caisse reelle ne correspond pas au calcul — des penalites anciennes encaissees
            sans trace nominative, le plus souvent — annoncez le solde que vous constatez. L&apos;outil
            ecrit l&apos;ecart dans le bon sens et en garde le motif. Solde calcule a cet instant :{" "}
            <strong>{fcfa(s.totalEnCaisse)}</strong>.
          </p>
          <Depliant titre="Aligner sur le solde reel">
            <FormulaireAction
              action={regulariserCaisse}
              libelle="Inscrire l'ecart"
              confirmation="Inscrire l'ecart entre le solde calcule et le solde constate ?"
            >
              <Champ
                nom="soldeReel"
                libelle="Solde reellement constate (FCFA)"
                type="number"
                min={0}
                valeur={Math.max(0, Math.round(s.totalEnCaisse))}
                aide="Ce que vous comptez en caisse, ou ce qu'affiche votre releve."
              />
              <Champ
                nom="date"
                libelle="Date du constat"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Champ
                nom="motif"
                libelle="Motif"
                valeur="Penalites historiques non documentees"
                requis={false}
              />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}

      <Carte titre={`Journal de caisse (${mouvements.length})`}>
        {mouvements.length === 0 ? (
          <Vide>Aucun mouvement enregistre.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {mouvements.map((m) => {
              const depense = m.sens === SENS_CAISSE.depense;
              return (
                <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <span
                        style={{
                          color: depense ? "var(--color-rouge-600)" : "var(--color-vert-600)",
                        }}
                      >
                        {depense ? "−" : "+"} {fcfa(m.montant)}
                      </span>
                      {m.statut === STATUT_CAISSE.enAttente && <Badge ton="ambre">En attente</Badge>}
                      {m.statut === STATUT_CAISSE.rejete && <Badge ton="rouge">Rejete</Badge>}
                    </p>
                    <p className="text-xs" style={{ color: "var(--discret)" }}>
                      {libelleCategorie(m.categorie)} &middot; {dateCourte(m.date_mouvement)}
                      {m.valide_par ? ` · valide par ${m.valide_par}` : ""}
                    </p>
                    {m.note && <p className="mt-0.5 text-xs italic">{m.note}</p>}
                    {m.motif_refus && (
                      <p className="mt-0.5 text-xs italic" style={{ color: "var(--color-rouge-600)" }}>
                        Rejet : {m.motif_refus}
                      </p>
                    )}
                  </div>
                  {/*
                    * Annuler une ecriture close. Sans ce bouton, corriger une
                    * ligne validee demandait de lui opposer une ecriture
                    * inverse, qui decrivait a son tour un mouvement n'ayant pas
                    * eu lieu : le journal finissait par raconter le contraire de
                    * ce qui s'etait passe.
                    */}
                  {valide && m.statut === STATUT_CAISSE.valide && (
                    <FormulaireAction
                      action={rejeterMouvement}
                      libelle="Annuler"
                      variante="danger"
                      compact
                      confirmation="Annuler ce mouvement deja valide ? Il cessera de compter dans la caisse, et l'operation restera au journal."
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
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Carte>
    </>
  );
}
