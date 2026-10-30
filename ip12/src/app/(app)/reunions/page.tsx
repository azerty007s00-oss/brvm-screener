import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerMembres, listerReunions, presencesParReunion } from "@/lib/queries";
import { creerReunion, enregistrerPresences, supprimerReunion } from "@/app/actions/reunions";
import { accorde, dateCourte, debutMois, decalerMois, jourIso } from "@/lib/settings";
import {
  derniersHeureLieu,
  invitationReunion,
  lireRythmeReunions,
  participants,
  reponsesDu,
  sondageEnCours,
  type Sondage,
} from "@/lib/sondage";
import { bornes, lienGoogleAgenda } from "@/lib/agenda";
import { HeureChezVous } from "@/components/fuseau";
import { styleBouton } from "@/components/boutons";
import {
  FENETRE,
  HEURE_HABITUELLE,
  STATUT_SONDAGE,
  decompte,
  duMois,
  jourCourt,
  jourEnClair,
  jourRetenu,
  momentEnClair,
  nomDuMois,
  prochainMoisDeReunion,
} from "@/lib/calendrier-reunions";
import { DecompteSondage, ReponseSondage, ValidationDate, type JourSondage } from "@/components/sondage-reunion";
import type { Membre } from "@/lib/auth";
import type { ReactNode } from "react";
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

  /* Le sondage se lit en meme temps que les seances, et ne fait jamais tomber la page. */
  const enCours = sectionSondage({ membre }).catch(() => ({ section: null, prochain: null }));

  let reunions, membres, presences;
  try {
    [reunions, membres, presences] = await Promise.all([
      listerReunions(),
      // Une part rachetee n'assiste a rien : seules les personnes sont pointees.
      listerMembres().then((l) => l.filter((m) => !m.titulaireId)),
      presencesParReunion(),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const sondage = await enCours;
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

      {sondage.section}

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
                        ? `${r.presents} ${accorde(r.presents, "présent")} · ` +
                          `${r.absents} ${accorde(r.absents, "absent")} · ` +
                          `${r.excuses} ${accorde(r.excuses, "excusé")}`
                        : "Feuille de présence à remplir"}
                      {r.cree_par ? ` · saisie par ${r.cree_par}` : ""}
                    </p>
                    {r.note && <p className="mt-0.5 text-xs italic">{r.note}</p>}
                    <p className="mt-1 text-[13px]">
                      <Link href={`/reunions/${r.id}`} className="font-medium underline" style={{ color: "var(--accent)" }}>
                        {r.date_reunion >= new Date().toISOString().slice(0, 10) ? "Préparer : ordre du jour et rapport" : "Rapport de la séance"}
                      </Link>
                    </p>
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
                      /*
                        * « Vous y etiez note present » : le code brut de la base, sans
                        * accent, dans une phrase a laquelle il manquait le sien.
                        */
                      <p className="mt-1 text-xs" style={{ color: "var(--discret)" }}>
                        {pointees.has(membre.id) ? (
                          <>
                            Vous y êtes noté{" "}
                            <strong>
                              {(
                                OPTIONS_PRESENCE.find((o) => o.valeur === pointees.get(membre.id))?.libelle ??
                                String(pointees.get(membre.id))
                              ).toLowerCase()}
                            </strong>
                            .
                          </>
                        ) : (
                          "Vous n'êtes pas sur la feuille de cette séance."
                        )}
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
          {sondage.prochain && ` ${sondage.prochain}`}
        </p>
      </Carte>
    </>
  );
}

/* ------------------------------------------------------------------ sondage */

const premiereMajuscule = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const classeBouton =
  "tapable inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-[14px] font-medium whitespace-nowrap lg:h-8 lg:px-3.5 lg:text-[13px]";

/**
 * Le sondage de date, en tete de page tant qu'il a quelque chose a dire :
 * ouvert, il demande ses jours au membre ; clos, il attend le president ;
 * valide, il annonce la prochaine seance jusqu'a ce qu'elle ait eu lieu.
 *
 * Une panne de lecture n'empeche pas d'afficher les seances : la section se
 * tait, et la page reste ce qu'elle etait avant le sondage.
 */
async function sectionSondage({ membre }: { membre: Membre }): Promise<{ section: ReactNode; prochain: string | null }> {
  const maintenant = new Date();
  const aujourdhui = jourIso(maintenant);
  let s: Sondage | null;
  try {
    s = await sondageEnCours(aujourdhui);
  } catch {
    return { section: null, prochain: null };
  }

  if (!s) {
    const rythme = await lireRythmeReunions();
    /* Le jour de la cloture passe, le sondage du mois en cours n'aura plus lieu : on regarde plus loin. */
    const depuis = maintenant.getUTCDate() < FENETRE.cloture ? debutMois(maintenant) : decalerMois(debutMois(maintenant), 1);
    const mois = prochainMoisDeReunion(depuis, rythme);
    return {
      section: null,
      prochain: `Prochaine réunion en ${nomDuMois(mois)} : le sondage de date s'ouvrira le ${FENETRE.ouverture}/${mois.slice(5, 7)}.`,
    };
  }

  const [reponses, gens, derniers] = await Promise.all([reponsesDu(s.id), participants(), derniersHeureLieu()]);
  const total = gens.length;
  const comptes = decompte(s.jours, reponses);
  const retenu = jourRetenu(comptes);
  const jours: JourSondage[] = comptes.map((c) => ({ iso: c.jour, court: jourCourt(c.jour), clair: jourEnClair(c.jour), n: c.n }));
  const ontRepondu = new Set(reponses.map((r) => r.membreId));
  const muets = gens.filter((m) => !ontRepondu.has(m.id));
  const president = peut(membre, "fixerDateReunion");
  const participe = gens.some((m) => m.id === membre.id);
  const miens = reponses.find((r) => r.membreId === membre.id)?.jours ?? null;
  const ouvert = s.statut === STATUT_SONDAGE.ouvert && maintenant < s.cloture;
  const heure = s.heure ?? derniers.heure ?? HEURE_HABITUELLE;
  const lieu = s.lieu ?? derniers.lieu ?? "";
  const titre = `Réunion ${duMois(s.mois)}`;

  const discret = { color: "var(--ink-2)" };
  const reponsesTexte =
    `${reponses.length} ${accorde(reponses.length, "réponse")} sur ${total}.` +
    (muets.length > 0 && muets.length < total ? ` Pas encore répondu : ${muets.map((m) => m.nom).join(", ")}.` : "");

  let corps: ReactNode;
  if (s.statut === STATUT_SONDAGE.valide && s.jourChoisi) {
    const invitation = invitationReunion(s, null, maintenant);
    const debut = invitation ? (bornes(invitation)?.debut ?? null) : null;
    const dispo = comptes.find((c) => c.jour === s.jourChoisi)?.n ?? 0;
    corps = (
      <>
        <p className="text-[13px]" style={discret}>Prochaine réunion</p>
        <p className="mt-1 text-[24px] font-semibold leading-tight">
          {premiereMajuscule(jourEnClair(s.jourChoisi))} à {s.heure}
          {debut && " GMT"}
        </p>
        {debut && (
          <p className="text-[14px]" style={discret}>
            Heure d&apos;Abidjan
            <HeureChezVous instant={debut.toISOString()} avant=" · " apres="" />
          </p>
        )}
        {s.lieu && <p className="mt-1 text-[15px]">{s.lieu}</p>}
        <p className="mt-2 text-[13px] leading-relaxed" style={discret}>
          {dispo > 0
            ? `${dispo} ${dispo > 1 ? "membres s'étaient déclarés disponibles" : "membre s'était déclaré disponible"} ce jour-là. `
            : ""}
          Tout le monde a été prévenu ; un rappel part la veille.
        </p>
        {invitation && (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              {/* Un lien ordinaire : un Link de Next prechargerait le fichier a l'affichage. */}
              <a href={`/reunions/agenda?s=${s.id}`} className={classeBouton} style={styleBouton("principal")}>
                Ajouter à mon agenda
              </a>
              <a href={lienGoogleAgenda(invitation)} target="_blank" rel="noopener noreferrer" className={classeBouton} style={styleBouton("secondaire")}>
                Google Agenda
              </a>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
              Sur iPhone, « Ajouter à mon agenda » ; sur Android, « Google Agenda ». L&apos;invitation reçue par courriel fait la
              même chose, et suit la réunion si elle est déplacée.
            </p>
          </>
        )}
        {president && (
          <div className="mt-3">
            <Depliant titre="Changer le jour, l'heure ou le lieu">
              <ValidationDate sondageId={s.id} jours={jours} defaut={s.jourChoisi} heure={heure} lieu={lieu} correction />
            </Depliant>
          </div>
        )}
      </>
    );
  } else if (ouvert) {
    corps = (
      <>
        <p className="text-[13px]" style={discret}>
          Sondage ouvert jusqu&apos;au {momentEnClair(s.cloture)}, heure d&apos;Abidjan
          <HeureChezVous instant={s.cloture.toISOString()} />
        </p>
        <h3 className="mt-1 text-[19px] font-semibold leading-snug">Quels jours pouvez-vous venir ?</h3>
        <p className="mt-1 mb-4 text-[14px] leading-relaxed" style={discret}>
          Cochez tous les jours qui vous vont. La réunion se tient d&apos;habitude à {HEURE_HABITUELLE} GMT, heure
          d&apos;Abidjan
          <HeureChezVous instant={`${s.jours[0]}T21:00:00Z`} />. Le président fixe ensuite la date, l&apos;heure et le
          lieu, et chacun est prévenu.
        </p>
        {participe ? (
          <ReponseSondage sondageId={s.id} jours={jours} miens={miens} total={total} />
        ) : (
          <DecompteSondage jours={jours} total={total} retenu={retenu?.jour ?? null} />
        )}
        <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          {reponsesTexte}
        </p>
        {president && (
          <div className="mt-3">
            <Depliant titre="Fixer la date sans attendre la clôture">
              <ValidationDate sondageId={s.id} jours={jours} defaut={retenu?.jour ?? s.jours[0]} heure={heure} lieu={lieu} correction={false} />
            </Depliant>
          </div>
        )}
      </>
    );
  } else {
    const absents = retenu ? gens.filter((m) => ontRepondu.has(m.id) && !retenu.membres.includes(m.id)) : [];
    corps = (
      <>
        <p className="text-[13px]" style={discret}>
          Sondage clos · {reponses.length} {accorde(reponses.length, "réponse")} sur {total}
        </p>
        {retenu ? (
          <>
            <p className="mt-2 text-[13px]" style={discret}>Le jour qui réunit le plus de monde</p>
            <p className="text-[24px] font-semibold leading-tight">{premiereMajuscule(jourEnClair(retenu.jour))}</p>
            <p className="mt-1 text-[14px]" style={discret}>
              {retenu.n} {retenu.n > 1 ? "disponibles" : "disponible"} sur {total}
              {absents.length > 0 && ` · pas disponible : ${absents.map((m) => m.nom).join(", ")}`}
              {muets.length > 0 && ` · sans réponse : ${muets.map((m) => m.nom).join(", ")}`}
            </p>
          </>
        ) : (
          <p className="mt-2 text-[14px]">Aucun jour n&apos;a été coché.</p>
        )}
        <div className="mt-3">
          <DecompteSondage jours={jours} total={total} retenu={retenu?.jour ?? null} />
        </div>
        {president ? (
          <div className="mt-4">
            <ValidationDate sondageId={s.id} jours={jours} defaut={retenu?.jour ?? s.jours[0]} heure={heure} lieu={lieu} correction={false} />
            <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
              Rien ne part aux membres tant que vous n&apos;avez pas validé. Vous pouvez choisir un autre jour que celui de la
              majorité.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[13px] leading-relaxed" style={discret}>
            Le président fixe la date ; vous serez prévenu par alerte et par courriel.
          </p>
        )}
      </>
    );
  }

  return { section: <Carte titre={titre}>{corps}</Carte>, prochain: null };
}
