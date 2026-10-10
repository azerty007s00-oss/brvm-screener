import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { listerVersements, situationsClub, synthese } from "@/lib/queries";
import { changerMotDePasse, seDeconnecter } from "@/app/actions/auth";
import { joindreJustificatif } from "@/app/actions/versements";
import { ChampJustificatif } from "@/components/justificatif";
import { justificatifsParLot } from "@/lib/justificatifs";
import { penalitesNonInscrites } from "@/lib/constat";
import { ROLES, dateCourte, fcfa, moisLong, nombre } from "@/lib/settings";
import { couleurSigne } from "@/lib/perf";
import { Champ, ChampCache, Depliant, FormulaireAction } from "@/components/formulaires";
import { libelleMode } from "@/lib/valeurs";
import { Alerte, Badge, Carte, CarteEtat, EnTeteEcran, Vide } from "@/components/ui";
import { Bouton } from "@/components/boutons";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mon compte" };

export default async function PageMonCompte() {
  const membre = await exigerMembre();

  let mesVersements, situations, s, pieces;
  try {
    [mesVersements, situations, s, pieces] = await Promise.all([
      listerVersements({ membreId: membre.id }),
      situationsClub(),
      synthese(),
      justificatifsParLot(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }
  /* Apres `situations`, dont elle a besoin. Elle rend `null` si le registre resiste. */
  const courues = await penalitesNonInscrites(situations);

  const maSituation = situations.find((x) => x.membreId === membre.id);
  const maPart = s.parts.find((p) => p.membreId === membre.id);

  /*
   * MA DETTE DE PENALITES, LA MEME QUE CELLE DU COURRIER.
   *
   * Cette page en affichait deux, contradictoires : « capital diminue de 7 500
   * FCFA de penalites dues » au bandeau -- le registre -- et « penalites dues
   * 1 000 FCFA » sous les versements -- le calcul du mois. Et la relance en
   * annoncait une troisieme, la somme des deux. Un membre croit son compte avant
   * de croire un courriel : c'est le chiffre du site qui devait etre juste.
   *
   * Les deux sont dues, et la somme est celle que le tresorier reclame.
   */
  const monCourant = courues?.get(membre.id) ?? { nb: 0, montant: 0, mois: [] };
  const maDette = (maPart?.dues ?? 0) + monCourant.montant;

  // Un lot peut couvrir plusieurs mois : on ne propose la piece qu'une fois par lot.
  const lotsSansPiece = [...new Map(
    mesVersements
      .filter((v) => v.statut !== "rejete" && (pieces.get(v.lot) ?? []).length === 0)
      .map((v) => [v.lot, v]),
  ).values()];

  return (
    <>
      <div className="flex justify-end">
        <Link
          href={`/releve/${membre.id}`}
          className="rounded-lg px-3 py-1.5 text-xs font-medium"
          style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
        >
          Éditer mon relevé
        </Link>
      </div>

      <EnTeteEcran
        titre="Valeur de ma part"
        chiffre={maPart ? undefined : "--"}
        brut={maPart ? maPart.valeur : undefined}
        unite={maPart ? "FCFA" : undefined}
        detail={
          maPart
            ? `${(maPart.part * 100).toFixed(1).replace(".", ",")} % au prorata du capital échu${
                maPart.dues > 0 ? ` \u00b7 capital diminué de ${fcfa(maPart.dues)} de pénalités dues` : ""
              }`
            : "Votre part se calcule dès votre premier versement validé."
        }
      />

      <CarteEtat
        chiffres={[
          {
            libelle: "J'ai versé",
            brut: maPart?.verse ?? 0,
            unite: "FCFA",
            contexte:
              maPart && maPart.avance > 0 ? `dont ${fcfa(maPart.avance)} d'avance, en dépôt` : undefined,
          },
          /*
           * Le pourcentage est deja dit sous le montant : cette case le
           * repetait. Elle donne a la place ce que la part a gagne -- ou perdu
           * -- sur ce qui a ete verse, signe et teinte comme au portefeuille.
           */
          {
            libelle: "Plus-value",
            valeur: maPart
              ? `${maPart.plusValue >= 0 ? "+" : "\u2212"}${nombre(Math.abs(maPart.plusValue))}`
              : "--",
            unite: maPart ? "FCFA" : undefined,
            encre: maPart ? couleurSigne(maPart.plusValue) : undefined,
            contexte: "valeur de ma part moins ce que j'ai versé",
          },
        ]}
      />

      <Carte titre="Mon profil">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs" style={{ color: "var(--discret)" }}>Nom</dt>
            <dd>{membre.nom}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--discret)" }}>E-mail</dt>
            <dd className="break-all">{membre.email}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--discret)" }}>Rôle</dt>
            <dd>{ROLES[membre.role]}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--discret)" }}>Adhésion</dt>
            <dd>{dateCourte(membre.date_adhesion)}</dd>
          </div>
        </dl>
      </Carte>

      <Carte titre="Changer mon mot de passe">
        {membre.must_change_password && (
          <div className="mb-3">
            <Alerte ton="ambre">
              Votre mot de passe actuel est provisoire. Choisissez-en un nouveau : l&apos;ancien ne vous
              sera pas demandé.
            </Alerte>
          </div>
        )}
        <FormulaireAction action={changerMotDePasse} libelle="Mettre à jour">
          {!membre.must_change_password && (
            <Champ nom="actuel" libelle="Mot de passe actuel" type="password" autoComplete="current-password" />
          )}
          <Champ
            nom="nouveau"
            libelle="Nouveau mot de passe"
            type="password"
            autoComplete="new-password"
            aide="8 caractères minimum."
          />
          <Champ nom="confirmation" libelle="Confirmer" type="password" autoComplete="new-password" />
        </FormulaireAction>
      </Carte>

      <Carte titre={`Mes versements (${mesVersements.length})`}>
        {/*
          * L'ALERTE PARAIT AUSSI SANS MOIS EN RETARD.
          *
          * Elle etait conditionnee au seul retard de cotisation : un membre a jour
          * de ses versements mais devant des penalites -- d'absence, ou de mois
          * anciens regles en retard -- ne lisait rien ici, alors que la relance
          * les lui reclamait. C'est precisement le profil que l'assemblee a visé.
          */}
        {maSituation && (maSituation.nbMoisRetard > 0 || maDette > 0) && (
          <div className="mb-3">
            <Alerte ton={maSituation.exclusionEncourue ? "rouge" : "ambre"}>
              {maSituation.nbMoisRetard > 0 && (
                <>
                  {maSituation.nbMoisRetard} mois en retard
                  {maDette > 0 ? " · " : "."}
                </>
              )}
              {maDette > 0 && <>pénalités dues {fcfa(maDette)}.</>}
            </Alerte>
          </div>
        )}
        {mesVersements.length === 0 ? (
          <Vide>Aucun versement enregistré.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {mesVersements.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {moisLong(v.mois)} &middot; {fcfa(v.montant)}
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    Versé le {dateCourte(v.date_versement)} &middot; {libelleMode(v.mode)}
                    {v.motif_rejet ? ` · rejet : ${v.motif_rejet}` : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    ton={v.statut === "valide" ? "vert" : v.statut === "en_attente" ? "ambre" : "rouge"}
                  >
                    {v.statut === "valide" ? "Validé" : v.statut === "en_attente" ? "En attente" : "Rejeté"}
                  </Badge>
                  {(pieces.get(v.lot) ?? []).map((j) => (
                    <a
                      key={j.id}
                      href={`/api/justificatif/${j.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs underline"
                      style={{ color: "var(--etat-ok)" }}
                    >
                      {j.mime === "application/pdf" ? "Bordereau" : "Reçu"}
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {lotsSansPiece.length > 0 && (
          <div className="mt-4">
            <Depliant titre={`Joindre un justificatif (${lotsSansPiece.length} versement(s) sans pièce)`}>
              {lotsSansPiece.map((lot) => (
                <div key={lot.lot} className="mt-3 border-t pt-3" style={{ borderColor: "var(--bordure)" }}>
                  <p className="text-xs font-medium">
                    {moisLong(lot.mois)} &middot; {fcfa(lot.montant)}
                  </p>
                  <FormulaireAction action={joindreJustificatif} libelle="Joindre" compact>
                    <ChampCache nom="lot" valeur={lot.lot} />
                    <ChampJustificatif />
                  </FormulaireAction>
                </div>
              ))}
            </Depliant>
          </div>
        )}
      </Carte>

      {/*
        * La sortie, sur telephone.
        *
        * La barre laterale porte son bouton « Quitter la session » ; elle
        * n'existe qu'a partir de 1 024 px. En deca, c'est ici -- au bas de la
        * seule page qui parle de la personne -- que la deconnexion se trouve,
        * et non dans la navigation basse, qui sert a aller quelque part.
        */}
      <form action={seDeconnecter} className="sans-impression pt-2">
        <Bouton type="submit" variante="secondaire">
          Se déconnecter
        </Bouton>
      </form>
    </>
  );
}
