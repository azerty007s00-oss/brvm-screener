import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerMembres, listerReunions, presencesParReunion } from "@/lib/queries";
import { creerReunion, enregistrerPresences, supprimerReunion } from "@/app/actions/reunions";
import { dateCourte } from "@/lib/settings";
import { Champ, ChampCache, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Badge, Carte, EnTeteEcran, Vide } from "@/components/ui";
import { Panneau } from "@/components/panneau";
import { MenuLigne } from "@/components/menu-ligne";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Réunions" };

const OPTIONS_PRESENCE = [
  { valeur: "present", libelle: "Présent" },
  { valeur: "absent", libelle: "Absent" },
  { valeur: "excuse", libelle: "Excusé" },
];

export default async function PageReunions() {
  const membre = await exigerMembre();
  const gere = peut(membre, "gererReunions");

  let reunions, membres, presences;
  try {
    [reunions, membres, presences] = await Promise.all([
      listerReunions(),
      listerMembres(),
      presencesParReunion(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const derniere = reunions[0] ?? null;
  const pointesDerniere = derniere
    ? derniere.presents + derniere.absents + derniere.excuses
    : 0;
  const tauxPresence = pointesDerniere > 0 ? derniere!.presents / pointesDerniere : null;

  const saisie = gere ? (
    <Panneau
      libelle="Convoquer une séance"
      titre="Nouvelle réunion"
      introduction="Les réunions et la feuille de présence sont tenues par le secrétaire. Une absence peut être sanctionnée depuis la page Pénalités."
    >
        <FormulaireAction action={creerReunion} libelle="Créer la réunion">
          <Champ
            nom="date"
            libelle="Date"
            type="date"
            valeur={new Date().toISOString().slice(0, 10)}
          />
          <Champ
            nom="titre"
            libelle="Intitulé"
            requis={false}
            aide="Par exemple : assemblée générale."
          />
          <Champ nom="note" libelle="Ordre du jour ou note" requis={false} />
        </FormulaireAction>
    </Panneau>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <EnTeteEcran
          titre="Réunions tenues"
          brut={reunions.length}

          detail={
            derniere
              ? `Dernière séance le ${dateCourte(derniere.date_reunion)}${tauxPresence === null ? "" : `, ${Math.round(tauxPresence * 100)} % de présence`}.`
              : "Aucune séance enregistrée."
          }
        />
        <div className="sans-impression">{saisie}</div>
      </div>

      <Carte titre={`Séances (${reunions.length})`}>
        {reunions.length === 0 ? (
          <Vide>Aucune réunion enregistrée.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {reunions.map((r) => {
              const pointees = presences.get(r.id) ?? new Map<string, string>();
              const pointee = pointees.size > 0;
              return (
                <li key={r.id} className="py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {r.titre ?? "Séance"} &middot; {dateCourte(r.date_reunion)}
                      {!pointee && <Badge ton="ambre">Non pointée</Badge>}
                    </p>
                    <p className="text-xs" style={{ color: "var(--discret)" }}>
                      {pointee
                        ? `${r.presents} présents · ${r.absents} absents · ${r.excuses} excusés`
                        : "Feuille de présence à remplir"}
                      {r.cree_par ? ` · ${r.cree_par}` : ""}
                    </p>
                    {r.note && <p className="mt-0.5 text-xs italic">{r.note}</p>}
                  </div>

                  {gere ? (
                    <div className="mt-2 space-y-2">
                      <Depliant titre={pointee ? "Corriger la feuille" : "Pointer les présences"}>
                        <FormulaireAction
                          action={enregistrerPresences}
                          libelle="Enregistrer la feuille"
                        >
                          <ChampCache nom="reunionId" valeur={r.id} />
                          {membres.map((m) => (
                            <Selection
                              key={m.id}
                              nom={`statut_${m.id}`}
                              libelle={m.nom}
                              valeur={pointees.get(m.id) ?? "present"}
                              options={OPTIONS_PRESENCE}
                            />
                          ))}
                        </FormulaireAction>
                      </Depliant>
                      {/*
                        * La suppression d'une seance passe derriere les trois
                        * points : elle emporte la feuille de presence avec
                        * elle, et n'a pas a cotoyer le bouton de pointage.
                        */}
                      <MenuLigne
                        etiquette={`Actions sur la séance du ${dateCourte(r.date_reunion)}`}
                        actions={[
                          {
                            libelle: "Supprimer la séance",
                            action: supprimerReunion,
                            champs: <ChampCache nom="id" valeur={r.id} />,
                            confirmation:
                              "Supprimer cette réunion et sa feuille de présence ?",
                            confirmer: "Supprimer",
                          },
                        ]}
                      />
                    </div>
                  ) : (
                    pointee && (
                      <p className="mt-1 text-xs" style={{ color: "var(--discret)" }}>
                        Vous y étiez note{" "}
                        <strong>{pointees.get(membre.id) ?? "non pointé"}</strong>.
                      </p>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-[11px]" style={{ color: "var(--discret)" }}>
          Les réunions et la feuille de présence sont tenues par le secrétaire. Une absence peut
          être sanctionnée depuis la page Pénalités.
        </p>
      </Carte>
    </>
  );
}
