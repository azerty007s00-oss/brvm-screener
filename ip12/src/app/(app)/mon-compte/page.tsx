import { exigerMembre } from "@/lib/auth";
import { listerVersements, situationsClub, synthese } from "@/lib/queries";
import { changerMotDePasse } from "@/app/actions/auth";
import { ROLES, dateCourte, fcfa, moisLong } from "@/lib/settings";
import { Champ, FormulaireAction } from "@/components/formulaires";
import { libelleMode } from "@/lib/valeurs";
import { Alerte, Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

export default async function PageMonCompte() {
  const membre = await exigerMembre();

  let mesVersements, situations, s;
  try {
    [mesVersements, situations, s] = await Promise.all([
      listerVersements({ membreId: membre.id }),
      situationsClub(),
      synthese(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const maSituation = situations.find((x) => x.membreId === membre.id);
  const maPart = s.parts.find((p) => p.membreId === membre.id);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Statistique libelle="J'ai verse" valeur={fcfa(maPart?.verse ?? 0)} />
        <Statistique
          libelle="Ma part"
          valeur={maPart ? `${(maPart.part * 100).toFixed(1).replace(".", ",")} %` : "--"}
        />
        <Statistique libelle="Valeur de ma part" valeur={maPart ? fcfa(maPart.valeur) : "--"} accent="or" />
        <Statistique
          libelle="Plus-value"
          valeur={maPart ? fcfa(maPart.plusValue) : "--"}
          accent={maPart && maPart.plusValue < 0 ? "rouge" : "vert"}
        />
      </div>

      <Carte titre="Mon profil">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase" style={{ color: "var(--discret)" }}>Nom</dt>
            <dd>{membre.nom}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase" style={{ color: "var(--discret)" }}>E-mail</dt>
            <dd className="break-all">{membre.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase" style={{ color: "var(--discret)" }}>Role</dt>
            <dd>{ROLES[membre.role]}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase" style={{ color: "var(--discret)" }}>Adhesion</dt>
            <dd>{dateCourte(membre.date_adhesion)}</dd>
          </div>
        </dl>
      </Carte>

      <Carte titre="Changer mon mot de passe">
        {membre.must_change_password && (
          <div className="mb-3">
            <Alerte ton="ambre">
              Votre mot de passe actuel est provisoire. Choisissez-en un nouveau : l&apos;ancien ne vous
              sera pas demande.
            </Alerte>
          </div>
        )}
        <FormulaireAction action={changerMotDePasse} libelle="Mettre a jour">
          {!membre.must_change_password && (
            <Champ nom="actuel" libelle="Mot de passe actuel" type="password" autoComplete="current-password" />
          )}
          <Champ
            nom="nouveau"
            libelle="Nouveau mot de passe"
            type="password"
            autoComplete="new-password"
            aide="8 caracteres minimum."
          />
          <Champ nom="confirmation" libelle="Confirmer" type="password" autoComplete="new-password" />
        </FormulaireAction>
      </Carte>

      <Carte titre={`Mes versements (${mesVersements.length})`}>
        {maSituation && maSituation.nbMoisRetard > 0 && (
          <div className="mb-3">
            <Alerte ton={maSituation.exclusionEncourue ? "rouge" : "ambre"}>
              {maSituation.nbMoisRetard} mois en retard &middot; penalites dues{" "}
              {fcfa(maSituation.totalPenalites)}.
            </Alerte>
          </div>
        )}
        {mesVersements.length === 0 ? (
          <Vide>Aucun versement enregistre.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {mesVersements.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {moisLong(v.mois)} &middot; {fcfa(v.montant)}
                  </p>
                  <p className="text-xs" style={{ color: "var(--discret)" }}>
                    Verse le {dateCourte(v.date_versement)} &middot; {libelleMode(v.mode)}
                    {v.motif_rejet ? ` · rejet : ${v.motif_rejet}` : ""}
                  </p>
                </div>
                <Badge
                  ton={v.statut === "valide" ? "vert" : v.statut === "en_attente" ? "ambre" : "rouge"}
                >
                  {v.statut === "valide" ? "Valide" : v.statut === "en_attente" ? "En attente" : "Rejete"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Carte>
    </>
  );
}
