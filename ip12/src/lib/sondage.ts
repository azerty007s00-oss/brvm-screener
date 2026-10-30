import "server-only";
import { db } from "./db";
import { avecTables as avecTablesAuto } from "./tables-auto";
import { envoyerAlertes } from "./alertes";
import { adresseDuCompte, envoyerCourriel, type Courriel } from "./courriel";
import { bornes, fichierIcs, type Invitation, type Personne } from "./agenda";
import { fuseauxDesMembres } from "./fuseau-membres";
import { chezSoi, heurePour, precisionLocale, type HeureLocale } from "./fuseaux";
import { listerMembres, type MembreListe } from "./queries";
import { CLUB, lienDuSite } from "./settings";
import {
  CLE_RYTHME,
  RAPPEL_PRESIDENT_APRES_MS,
  RELANCE_AVANT_CLOTURE_MS,
  STATUT_SONDAGE,
  alerteOuverture,
  alertePresident,
  alerteRappelPresident,
  alerteRelance,
  alerteVeille,
  clotureDuSondage,
  decompte,
  duMois,
  jourEnClair,
  jourRetenu,
  joursDuSondage,
  lireRythme,
  moisAOuvrir,
  momentEnClair,
  type Reponse,
  type Rythme,
  type StatutSondage,
  type TexteAlerte,
} from "./calendrier-reunions";

/**
 * LE SONDAGE DE DATE, COTE BASE.
 *
 * Deux tables, creees par le site lui-meme au premier besoin : le president
 * n'a pas de console a ouvrir pour que le sondage de novembre parte le 3.
 * La creation est purement additive (`create table if not exists`) et ne
 * touche a rien d'existant.
 */

/*
 * Le meme texte que scripts/migration-sondages.sql, que la verification des
 * requetes applique a sa base d'essai : qui modifie l'un modifie l'autre.
 */
const TABLES = [
  `create table if not exists meeting_polls (
    id                    uuid primary key default gen_random_uuid(),
    month                 date not null unique,
    closes_at             timestamptz not null,
    status                text not null default 'ouvert',
    chosen_day            date,
    meeting_id            uuid references meetings(id) on delete set null,
    meeting_time          text,
    place                 text,
    reminded_at           timestamptz,
    asked_at              timestamptz,
    president_reminded_at timestamptz,
    eve_sent_at           timestamptz,
    validated_by          uuid references members(id),
    validated_at          timestamptz,
    created_at            timestamptz not null default now()
  )`,
  `create table if not exists meeting_poll_answers (
    poll_id     uuid not null references meeting_polls(id) on delete cascade,
    member_id   uuid not null references members(id) on delete cascade,
    days        smallint[] not null default '{}',
    answered_at timestamptz not null default now(),
    primary key (poll_id, member_id)
  )`,
];

/** Execute `f`, en creant les tables du sondage si elles manquent encore. */
function avecTables<T>(f: () => Promise<T>): Promise<T> {
  return avecTablesAuto(TABLES, f);
}

/* ------------------------------------------------------------------ lecture */

export type Sondage = {
  id: string;
  /** AAAA-MM-01. */
  mois: string;
  jours: string[];
  cloture: Date;
  statut: StatutSondage;
  jourChoisi: string | null;
  reunionId: string | null;
  heure: string | null;
  lieu: string | null;
  demandeLe: Date | null;
  /**
   * Le numero de version de l'invitation d'agenda : l'instant de la derniere
   * validation, en secondes. Il croit a chaque deplacement, sans compteur a
   * tenir, et l'agenda remplace l'ancienne date par la nouvelle.
   */
  sequence: number;
};

type Ligne = Record<string, unknown>;

function versSondage(r: Ligne): Sondage {
  const mois = String(r.mois);
  return {
    id: String(r.id),
    mois,
    jours: joursDuSondage(mois),
    cloture: new Date(String(r.cloture)),
    statut: String(r.statut) as StatutSondage,
    jourChoisi: (r.jour as string | null) ?? null,
    reunionId: (r.reunion as string | null) ?? null,
    heure: (r.heure as string | null) ?? null,
    lieu: (r.lieu as string | null) ?? null,
    demandeLe: r.demande ? new Date(String(r.demande)) : null,
    sequence: Number(r.sequence ?? 0),
  };
}

/*
 * Les instants sortent en texte ISO plutot qu'en objets Date : le pilote les
 * convertirait dans le fuseau du serveur, et la verification des requetes
 * tourne ailleurs qu'en production.
 */
const CHAMPS_SONDAGE = `
  id::text as id,
  to_char(month, 'YYYY-MM-DD') as mois,
  to_char(closes_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as cloture,
  status as statut,
  to_char(chosen_day, 'YYYY-MM-DD') as jour,
  meeting_id::text as reunion,
  meeting_time as heure,
  place as lieu,
  to_char(asked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as demande,
  coalesce(extract(epoch from validated_at), 0)::bigint as sequence
`;

export async function lireRythmeReunions(): Promise<Rythme> {
  const sql = db();
  const r = await sql`select value from settings where key = ${CLE_RYTHME}`.catch(() => []);
  return lireRythme(r[0] ? String(r[0].value) : null);
}

export async function reponsesDu(sondageId: string): Promise<(Reponse & { le: string })[]> {
  const sql = db();
  const rows = await avecTables(() => sql`
    select member_id::text as membre, array_to_string(days, ',') as jours,
           to_char(answered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as le
    from meeting_poll_answers where poll_id = ${sondageId}::uuid
  `);
  return rows.map((r) => ({
    membreId: String(r.membre),
    jours: String(r.jours ?? "").split(",").filter(Boolean).map(Number),
    le: String(r.le),
  }));
}

/**
 * Le sondage a montrer : celui qui est ouvert ou attend le president, ou dont
 * la reunion validee n'a pas encore eu lieu. Le plus recent l'emporte.
 */
export async function sondageEnCours(aujourdhui: string): Promise<Sondage | null> {
  const sql = db();
  const rows = await avecTables(() => sql`
    select ${sql.unsafe(CHAMPS_SONDAGE)} from meeting_polls
    where status in (${STATUT_SONDAGE.ouvert}, ${STATUT_SONDAGE.aValider})
       or (status = ${STATUT_SONDAGE.valide} and chosen_day >= ${aujourdhui}::date)
    order by month desc limit 1
  `);
  return rows[0] ? versSondage(rows[0]) : null;
}

export async function sondageParId(id: string): Promise<Sondage | null> {
  const sql = db();
  const rows = await avecTables(() => sql`select ${sql.unsafe(CHAMPS_SONDAGE)} from meeting_polls where id = ${id}::uuid`);
  return rows[0] ? versSondage(rows[0]) : null;
}

/** L'heure et le lieu de la derniere reunion fixee par sondage : la proposition suivante. */
export async function derniersHeureLieu(): Promise<{ heure: string | null; lieu: string | null }> {
  const sql = db();
  const rows = await avecTables(() => sql`
    select meeting_time as heure, place as lieu from meeting_polls
    where status = ${STATUT_SONDAGE.valide} order by month desc limit 1
  `).catch(() => []);
  return { heure: (rows[0]?.heure as string | null) ?? null, lieu: (rows[0]?.lieu as string | null) ?? null };
}

/** Qui repond : les personnes en activite. Une part rachetee ne se deplace pas. */
export async function participants(): Promise<MembreListe[]> {
  return (await listerMembres()).filter((m) => m.actif && !m.titulaireId);
}

/* ---------------------------------------------------------------- ecriture */

export async function enregistrerReponse(sondageId: string, membreId: string, jours: number[]): Promise<void> {
  const sql = db();
  await avecTables(() => sql`
    insert into meeting_poll_answers (poll_id, member_id, days, answered_at)
    values (${sondageId}::uuid, ${membreId}::uuid, ${jours}::smallint[], now())
    on conflict (poll_id, member_id) do update set days = excluded.days, answered_at = now()
  `);
}

/* ----------------------------------------------------------------- courrier */

async function ecrireATous(
  destinataires: MembreListe[],
  sujet: string,
  corps: (m: MembreListe) => string[],
  agenda?: (m: MembreListe) => Courriel["agenda"],
): Promise<number> {
  let partis = 0;
  for (const m of destinataires) {
    if (!m.email) continue;
    const { ok } = await envoyerCourriel({
      destinataire: m.email,
      sujet,
      texte: [...corps(m), "", `Le suivi du club ${CLUB.nom}`].join("\n"),
      ...(agenda ? { agenda: agenda(m) } : {}),
    }).catch(() => ({ ok: false }));
    if (ok) partis++;
  }
  return partis;
}

function lienReunions(): string {
  const site = lienDuSite();
  return site ? `${site}/reunions` : "la page Réunions du site";
}

export async function courrielOuverture(destinataires: MembreListe[], mois: string, cloture: Date): Promise<number> {
  const fuseaux = await fuseauxDesMembres();
  return ecrireATous(destinataires, `${CLUB.sigle} : quels jours pour la réunion ${duMois(mois)} ?`, (m) => [
    `Bonjour ${m.nom},`,
    "",
    `La réunion ${duMois(mois)} se tiendra entre le 10 et le 17. Cochez sur le site tous les jours qui vous conviennent, ` +
      `avant le ${momentEnClair(cloture)}, heure d'Abidjan${precisionLocale(chezSoi(cloture, fuseaux.get(m.id) ?? null))} : ${lienReunions()}`,
    "",
    "Le président retiendra le jour qui réunit le plus de monde, et chacun en sera prévenu.",
  ]);
}

export async function courrielAuPresident(
  presidents: MembreListe[],
  mois: string,
  texte: string,
): Promise<number> {
  return ecrireATous(presidents, `${CLUB.sigle} : la date de la réunion ${duMois(mois)} attend votre validation`, (m) => [
    `Bonjour ${m.nom},`,
    "",
    texte,
    "",
    `Rien ne part aux membres tant que vous n'avez pas validé : ${lienReunions()}`,
  ]);
}

/**
 * L'evenement d'agenda d'une reunion fixee. Avec un invite, c'est une
 * invitation a laquelle il repond (le courriel) ; sans, un evenement a
 * ajouter (le bouton de la page Reunions).
 */
export function invitationReunion(s: Sondage, invite: Personne | null, emisLe: Date): Invitation | null {
  if (!s.jourChoisi) return null;
  const organisateur = adresseDuCompte();
  return {
    uid: `reunion-${s.id}@ip12`,
    sequence: s.sequence,
    jour: s.jourChoisi,
    heure: s.heure,
    dureeMinutes: 120,
    titre: `Réunion ${CLUB.sigle}`,
    lieu: s.lieu,
    description: `Réunion ${duMois(s.mois)} du club ${CLUB.nom}. Détails : ${lienReunions()}`,
    methode: invite && organisateur ? "REQUEST" : "PUBLISH",
    organisateur: invite && organisateur ? { nom: CLUB.nom, email: organisateur } : null,
    invite: invite && organisateur ? invite : null,
    emisLe,
  };
}

export async function courrielConvocation(destinataires: MembreListe[], s: Sondage, disponibles: number): Promise<number> {
  const jour = s.jourChoisi;
  if (!jour) return 0;
  const heure = s.heure ?? "l'heure prévue";
  const debut = debutReunion(s);
  const fuseaux = await fuseauxDesMembres();
  const emisLe = new Date();
  return ecrireATous(
    destinataires,
    `${CLUB.sigle} : réunion le ${jourEnClair(jour)} à ${debut ? `${heure} GMT` : heure}`,
    (m) => [
      `Bonjour ${m.nom},`,
      "",
      `La réunion ${duMois(s.mois)} aura lieu le ${jourEnClair(jour)} à ${heurePour(heure, debut, fuseaux.get(m.id) ?? null)}` +
        `${s.lieu ? `, ${s.lieu}` : ""}.`,
      disponibles > 0
        ? `${disponibles} ${disponibles > 1 ? "membres s'étaient déclarés disponibles" : "membre s'était déclaré disponible"} ce jour-là.`
        : "Le président a fixé ce jour.",
      "",
      "L'invitation jointe l'inscrit dans votre agenda, à l'heure de chez vous : répondez « Oui » pour l'y ajouter. " +
        "Si la date change, votre agenda suit.",
      "",
      "Si vous ne pouvez pas venir, prévenez le secrétaire avant la séance : une absence excusée ne compte pas pour les pénalités.",
      "",
      `Détails : ${lienReunions()}`,
    ],
    (m) => {
      const inv = invitationReunion(s, { nom: m.nom, email: m.email }, emisLe);
      return inv ? { methode: inv.methode, contenu: fichierIcs(inv) } : undefined;
    },
  );
}

/**
 * Une alerte par membre, a son heure : l'heure GMT d'Abidjan pour tous, et
 * « soit 22 h chez toi (France) » pour qui vit ailleurs. Les membres de meme
 * fuseau partagent le meme texte.
 */
export async function alerterParFuseau(
  membres: string[],
  instant: Date | null,
  texte: (local: HeureLocale | null) => TexteAlerte,
  etiquette: string,
  url = "/reunions",
): Promise<void> {
  const fuseaux = instant ? await fuseauxDesMembres() : new Map<string, string>();
  const groupes = new Map<string, string[]>();
  for (const id of membres) {
    const f = fuseaux.get(id) ?? "";
    groupes.set(f, [...(groupes.get(f) ?? []), id]);
  }
  for (const [fuseau, ids] of groupes) {
    const local = instant && fuseau ? chezSoi(instant, fuseau) : null;
    await envoyerAlertes(ids, { ...texte(local), url, etiquette });
  }
}

/** Le debut d'une reunion fixee, ou null si son heure ne se lit pas. */
export function debutReunion(s: Sondage): Date | null {
  return s.jourChoisi && s.heure ? (bornes({ jour: s.jourChoisi, heure: s.heure, dureeMinutes: 120 })?.debut ?? null) : null;
}

/* ------------------------------------------------------- passage quotidien */

export type BilanPassage = {
  ouvert: string | null;
  relances: number;
  clos: string[];
  rappelsPresident: number;
  veilles: number;
};

/**
 * Le passage du soir : ouvre, relance, clot, rappelle.
 *
 * Chaque etape se reconnait a son horodatage (`reminded_at`, `asked_at`...)
 * pose par une mise a jour conditionnelle : deux passages simultanes, ou un
 * passage rejoue, n'envoient jamais deux fois la meme alerte. Les etapes se
 * deduisent des dates et non du jour du mois : un passage manque se rattrape
 * le lendemain.
 */
export async function passageQuotidien(maintenant: Date): Promise<BilanPassage> {
  const sql = db();
  const bilan: BilanPassage = { ouvert: null, relances: 0, clos: [], rappelsPresident: 0, veilles: 0 };
  /* Les etapes se datent a l'heure du passage, et non a celle de la base : l'une se deduit de l'autre. */
  const instant = maintenant.toISOString();
  const rythme = await lireRythmeReunions();
  const gens = await participants();
  const ids = gens.map((m) => m.id);
  const presidents = gens.filter((m) => m.role === "president");

  /* 1. Ouvrir le sondage du mois. */
  const aOuvrir = moisAOuvrir(maintenant, rythme);
  if (aOuvrir) {
    const cloture = clotureDuSondage(aOuvrir);
    const cree = await avecTables(() => sql`
      insert into meeting_polls (month, closes_at) values (${aOuvrir}::date, ${cloture.toISOString()}::timestamptz)
      on conflict (month) do nothing returning id
    `);
    if (cree.length > 0) {
      bilan.ouvert = aOuvrir;
      await alerterParFuseau(ids, cloture, (local) => alerteOuverture(cloture, maintenant, local), `sondage-${aOuvrir}`);
      await courrielOuverture(gens, aOuvrir, cloture);
    }
  }

  /* 2. Les sondages en vie. */
  const vivants = await avecTables(() => sql`
    select ${sql.unsafe(CHAMPS_SONDAGE)}, reminded_at is not null as relance,
           president_reminded_at is not null as rappele, eve_sent_at is not null as veille
    from meeting_polls where status in (${STATUT_SONDAGE.ouvert}, ${STATUT_SONDAGE.aValider}, ${STATUT_SONDAGE.valide})
  `);

  for (const r of vivants) {
    const s = versSondage(r);

    if (s.statut === STATUT_SONDAGE.ouvert) {
      if (maintenant >= s.cloture) {
        const pris = await sql`
          update meeting_polls set status = ${STATUT_SONDAGE.aValider}, asked_at = ${instant}::timestamptz
          where id = ${s.id}::uuid and status = ${STATUT_SONDAGE.ouvert} returning id
        `;
        if (pris.length === 0) continue;
        bilan.clos.push(s.mois);
        const reponses = await reponsesDu(s.id);
        const retenu = jourRetenu(decompte(s.jours, reponses));
        const texte = alertePresident(retenu, gens.length);
        await envoyerAlertes(presidents.map((p) => p.id), { ...texte, url: "/reunions", etiquette: `sondage-${s.mois}` });
        await courrielAuPresident(
          presidents,
          s.mois,
          retenu
            ? `Le sondage est clos : ${retenu.n} ${retenu.n > 1 ? "membres" : "membre"} sur ${gens.length} ` +
                `${retenu.n > 1 ? "sont disponibles" : "est disponible"} le ${jourEnClair(retenu.jour)}, le jour qui réunit le plus de monde. ` +
                "Validez ce jour, ou choisissez-en un autre, en fixant l'heure et le lieu."
            : "Le sondage est clos sans qu'aucun jour ait été coché. Fixez vous-même le jour, l'heure et le lieu.",
        );
      } else if (!r.relance && s.cloture.getTime() - maintenant.getTime() <= RELANCE_AVANT_CLOTURE_MS) {
        const pris = await sql`
          update meeting_polls set reminded_at = ${instant}::timestamptz where id = ${s.id}::uuid and reminded_at is null returning id
        `;
        if (pris.length === 0) continue;
        const ontRepondu = new Set((await reponsesDu(s.id)).map((x) => x.membreId));
        const muets = ids.filter((id) => !ontRepondu.has(id));
        bilan.relances = muets.length;
        await alerterParFuseau(muets, s.cloture, (local) => alerteRelance(s.cloture, maintenant, local), `sondage-${s.mois}`);
      }
    } else if (s.statut === STATUT_SONDAGE.aValider) {
      if (!r.rappele && s.demandeLe && maintenant.getTime() - s.demandeLe.getTime() >= RAPPEL_PRESIDENT_APRES_MS) {
        const pris = await sql`
          update meeting_polls set president_reminded_at = ${instant}::timestamptz
          where id = ${s.id}::uuid and president_reminded_at is null returning id
        `;
        if (pris.length === 0) continue;
        const retenu = jourRetenu(decompte(s.jours, await reponsesDu(s.id)));
        bilan.rappelsPresident = presidents.length;
        await envoyerAlertes(presidents.map((p) => p.id), {
          ...alerteRappelPresident(s.mois, retenu),
          url: "/reunions",
          etiquette: `sondage-${s.mois}`,
        });
      }
    } else if (s.statut === STATUT_SONDAGE.valide && s.jourChoisi && !r.veille) {
      const demain = new Date(maintenant.getTime() + 86_400_000).toISOString().slice(0, 10);
      if (s.jourChoisi !== demain) continue;
      const pris = await sql`
        update meeting_polls set eve_sent_at = ${instant}::timestamptz where id = ${s.id}::uuid and eve_sent_at is null returning id
      `;
      if (pris.length === 0) continue;
      bilan.veilles = ids.length;
      const debut = debutReunion(s);
      await alerterParFuseau(
        ids,
        debut,
        (local) => alerteVeille(s.heure ?? "l'heure prévue", s.lieu, debut !== null, local),
        `reunion-${s.jourChoisi}`,
      );
    }
  }
  return bilan;
}

/* ------------------------------------------------------------------ accueil */

export type AppelSondage = {
  titre: string;
  /** Le texte jusqu'a l'heure dite, que la page complete par l'heure du membre. */
  texte: string;
  /** La fin de la phrase, apres l'heure du membre. */
  suite: string;
  bouton: string;
  /** L'instant dont l'heure est dite, pour donner au membre la sienne. */
  instant?: string;
};

/**
 * Ce que l'accueil dit du sondage a ce membre, s'il a quelque chose a faire
 * ou a savoir : cocher ses jours, valider la date (le president), ou noter
 * la prochaine seance dans la semaine qui la precede.
 */
export async function appelDuSondage(membreId: string, fixeLaDate: boolean, maintenant: Date): Promise<AppelSondage | null> {
  const s = await sondageEnCours(maintenant.toISOString().slice(0, 10));
  if (!s) return null;
  const titre = `Réunion ${duMois(s.mois)}`;

  if (s.statut === STATUT_SONDAGE.valide && s.jourChoisi) {
    const dans = (Date.parse(`${s.jourChoisi}T00:00:00Z`) - Date.parse(`${maintenant.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000;
    if (dans > 7) return null;
    const quand = dans === 0 ? "Aujourd'hui" : dans === 1 ? "Demain" : `Le ${jourEnClair(s.jourChoisi)}`;
    const debut = debutReunion(s);
    return {
      titre,
      texte: `${quand} à ${s.heure}${debut ? " GMT, heure d'Abidjan" : ""}`,
      suite: `${s.lieu ? `, ${s.lieu}` : ""}.`,
      bouton: "Voir la réunion",
      instant: debut?.toISOString(),
    };
  }

  const ouvert = s.statut === STATUT_SONDAGE.ouvert && maintenant < s.cloture;
  if (ouvert) {
    const reponses = await reponsesDu(s.id);
    if (reponses.some((r) => r.membreId === membreId)) return null;
    return {
      titre,
      texte: `Quels jours, entre le 10 et le 17, pouvez-vous venir ? Le sondage ferme le ${momentEnClair(s.cloture)}, heure d'Abidjan`,
      suite: ".",
      bouton: "Cocher mes jours",
      instant: s.cloture.toISOString(),
    };
  }

  if (!fixeLaDate) return null;
  const retenu = jourRetenu(decompte(s.jours, await reponsesDu(s.id)));
  return {
    titre,
    texte: retenu
      ? `Le sondage est clos : le ${jourEnClair(retenu.jour)} réunit ${retenu.n} ${retenu.n > 1 ? "membres" : "membre"}. La date attend votre validation.`
      : "Le sondage est clos sans qu'aucun jour ait été coché. Fixez la date.",
    suite: "",
    bouton: "Fixer la date",
  };
}
