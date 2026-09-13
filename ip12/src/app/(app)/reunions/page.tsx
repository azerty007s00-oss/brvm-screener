import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerMembres, listerReunions, presencesParReunion } from "@/lib/queries";
import { creerReunion, enregistrerPresences, supprimerReunion } from "@/app/actions/reunions";
import { dateCourte } from "@/lib/settings";
import { Champ, ChampCache, Depliant, FormulaireAction, Selection } from "@/components/formulaires";
import { Badge, Carte, Statistique, Vide } from "@/components/ui";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";

const OPTIONS_PRESENCE = [
  { valeur: "present", libelle: "Present" },
  { valeur: "absent", libelle: "Absent" },
  { valeur: "excuse", libelle: "Excuse" },
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

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Statistique libelle="Reunions tenues" valeur={reunions.length} />
        <Statistique
          libelle="Derniere seance"
          valeur={derniere ? dateCourte(derniere.date_reunion) : "--"}
        />
        <Statistique
          libelle="Presence"
          valeur={tauxPresence === null ? "--" : `${Math.round(tauxPresence * 100)} %`}
          detail={derniere ? `${derniere.presents} presents` : undefined}
          accent={tauxPresence !== null && tauxPresence < 0.5 ? "rouge" : "vert"}
        />
      </div>

      {gere && (
        <Carte titre="Nouvelle reunion">
          <Depliant titre="Convoquer une seance">
            <FormulaireAction action={creerReunion} libelle="Creer la reunion">
              <Champ
                nom="date"
                libelle="Date"
                type="date"
                valeur={new Date().toISOString().slice(0, 10)}
              />
              <Champ
                nom="titre"
                libelle="Intitule"
                requis={false}
                aide="Par exemple : assemblee generale."
              />
              <Champ nom="note" libelle="Ordre du jour ou note" requis={false} />
            </FormulaireAction>
          </Depliant>
        </Carte>
      )}

      <Carte titre={`Seances (${reunions.length})`}>
        {reunions.length === 0 ? (
          <Vide>Aucune reunion enregistree.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {reunions.map((r) => {
              const pointees = presences.get(r.id) ?? new Map<string, string>();
              const pointee = pointees.size > 0;
              return (
                <li key={r.id} className="py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {r.titre ?? "Seance"} &middot; {dateCourte(r.date_reunion)}
                      {!pointee && <Badge ton="ambre">Non pointee</Badge>}
                    </p>
                    <p className="text-xs" style={{ color: "var(--discret)" }}>
                      {pointee
                        ? `${r.presents} presents · ${r.absents} absents · ${r.excuses} excuses`
                        : "Feuille de presence a remplir"}
                      {r.cree_par ? ` · ${r.cree_par}` : ""}
                    </p>
                    {r.note && <p className="mt-0.5 text-xs italic">{r.note}</p>}
                  </div>

                  {gere ? (
                    <div className="mt-2 space-y-2">
                      <Depliant titre={pointee ? "Corriger la feuille" : "Pointer les presences"}>
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
                      <FormulaireAction
                        action={supprimerReunion}
                        libelle="Supprimer la seance"
                        variante="danger"
                        compact
                        confirmation="Supprimer cette reunion et sa feuille de presence ?"
                      >
                        <ChampCache nom="id" valeur={r.id} />
                      </FormulaireAction>
                    </div>
                  ) : (
                    pointee && (
                      <p className="mt-1 text-xs" style={{ color: "var(--discret)" }}>
                        Vous y etiez note{" "}
                        <strong>{pointees.get(membre.id) ?? "non pointe"}</strong>.
                      </p>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-[11px]" style={{ color: "var(--discret)" }}>
          Les reunions et la feuille de presence sont tenues par le secretaire. Une absence peut
          etre sanctionnee depuis la page Penalites.
        </p>
      </Carte>
    </>
  );
}
