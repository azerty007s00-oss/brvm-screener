import { exigerMembre } from "@/lib/auth";
import { listerMembres, situationsClub, synthese } from "@/lib/queries";
import { basculerActivite, creerMembre, modifierMembre, reinitialiserMotDePasse } from "@/app/actions/membres";
import { CLUB, ROLES, dateCourte, fcfa } from "@/lib/settings";
import { Champ, ChampCache, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Badge, Carte, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

const OPTIONS_ROLE = [
  { valeur: "membre", libelle: "Membre" },
  { valeur: "tresorier", libelle: "Tresorier" },
  { valeur: "president", libelle: "President" },
];

export default async function PageMembres() {
  const membre = await exigerMembre();
  const estPresident = membre.role === "president";

  let membres, situations, s;
  try {
    [membres, situations, s] = await Promise.all([
      listerMembres(estPresident),
      situationsClub(),
      synthese(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  return (
    <>
      <Carte titre={`Effectif (${membres.filter((m) => m.actif).length} / ${CLUB.membresMax})`}>
        {membres.length === 0 ? (
          <Vide>Aucun membre enregistre.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {membres.map((m) => {
              const situation = situations.find((x) => x.membreId === m.id);
              const part = s.parts.find((p) => p.membreId === m.id);
              return (
                <li key={m.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                        {m.nom}
                        {m.role !== "membre" && <Badge ton="or">{ROLES[m.role]}</Badge>}
                        {!m.actif && <Badge ton="neutre">Inactif</Badge>}
                        {situation && situation.nbMoisRetard > 0 && (
                          <Badge ton="rouge">{situation.nbMoisRetard} mois de retard</Badge>
                        )}
                        {situation?.voteSuspendu && <Badge ton="rouge">Vote suspendu</Badge>}
                      </p>
                      <p className="truncate text-xs" style={{ color: "var(--discret)" }}>
                        {m.email}
                        {m.telephone ? ` · ${m.telephone}` : ""} &middot; adhesion{" "}
                        {dateCourte(m.date_adhesion)}
                      </p>
                      {part && (
                        <p className="mt-0.5 text-xs" style={{ color: "var(--discret)" }}>
                          Verse {fcfa(part.verse)} &middot; part{" "}
                          {(part.part * 100).toFixed(1).replace(".", ",")} % &middot; valeur{" "}
                          {fcfa(part.valeur)}
                        </p>
                      )}
                    </div>
                  </div>

                  {estPresident && (
                    <div className="mt-2">
                      <Depliant titre="Gerer">
                        <FormulaireAction action={modifierMembre} libelle="Enregistrer les modifications">
                          <ChampCache nom="id" valeur={m.id} />
                          <Champ nom="nom" libelle="Nom" valeur={m.nom} />
                          <Champ nom="email" libelle="E-mail" type="email" valeur={m.email} />
                          <Champ nom="telephone" libelle="Telephone" valeur={m.telephone ?? ""} requis={false} />
                          <Selection nom="role" libelle="Role" valeur={m.role} options={OPTIONS_ROLE} />
                        </FormulaireAction>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <FormulaireAction
                            action={reinitialiserMotDePasse}
                            libelle="Reinitialiser le mot de passe"
                            variante="discret"
                            compact
                            confirmation={`Generer un nouveau mot de passe provisoire pour ${m.nom} ?`}
                          >
                            <ChampCache nom="id" valeur={m.id} />
                          </FormulaireAction>
                          {m.id !== membre.id && (
                            <FormulaireAction
                              action={basculerActivite}
                              libelle={m.actif ? "Desactiver" : "Reactiver"}
                              variante="danger"
                              compact
                              confirmation={`${m.actif ? "Desactiver" : "Reactiver"} ${m.nom} ?`}
                            >
                              <ChampCache nom="id" valeur={m.id} />
                            </FormulaireAction>
                          )}
                        </div>
                      </Depliant>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Carte>

      {estPresident && (
        <Carte titre="Ajouter un membre">
          <p className="mb-3 text-xs" style={{ color: "var(--discret)" }}>
            Un mot de passe provisoire est genere : transmettez-le au membre, qui devra le remplacer a
            sa premiere connexion. Statuts : de {CLUB.membresMin} a {CLUB.membresMax} membres.
          </p>
          <Depliant titre="Nouveau profil">
            <FormulaireAction action={creerMembre} libelle="Creer le profil">
              <Champ nom="nom" libelle="Nom et prenoms" />
              <Champ nom="email" libelle="Adresse e-mail" type="email" />
              <Champ nom="telephone" libelle="Telephone" requis={false} />
              <Selection nom="role" libelle="Role" valeur="membre" options={OPTIONS_ROLE} />
              <Champ nom="dateAdhesion" libelle="Date d'adhesion" type="date" valeur={CLUB.dateCreation} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}
    </>
  );
}
