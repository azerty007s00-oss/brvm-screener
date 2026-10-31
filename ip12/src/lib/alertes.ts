import "server-only";
import webpush from "web-push";
import { after } from "next/server";
import { db } from "./db";
import { adresseDuCompte } from "./courriel";
import { listerMembres } from "./queries";
import { lienDuSite, variable } from "./settings";
import { DROITS, type Droit } from "./droits";
import type { Role } from "./settings";
import { STATUT_REGLEMENT, STATUT_VERSEMENT } from "./valeurs";

/**
 * LES ALERTES SUR LE TELEPHONE.
 *
 * Le courriel arrive, mais on le lit le soir, ou jamais : un versement refuse
 * le lundi se decouvrait a la relance du 9. Une alerte s'affiche sur l'ecran
 * verrouille, comme celle d'une application de paiement, et un toucher ouvre
 * la bonne page du site.
 *
 * Le protocole est celui du web (Web Push) : le telephone donne une adresse
 * d'abonnement a son service de notifications (Google, Apple, Mozilla), le
 * site y depose un message chiffre et signe. Rien a installer d'autre que le
 * site lui-meme ; sur iPhone, celui-ci doit avoir ete ajoute a l'ecran
 * d'accueil, condition d'Apple.
 *
 * Une alerte ne fait jamais echouer ce qui l'a declenchee : table absente,
 * telephone eteint, service indisponible, tout se rattrape ici en silence.
 * Le courriel reste le canal de reference.
 */

export type Alerte = {
  titre: string;
  corps: string;
  /**
   * Le meme message sans montant, pour le telephone dont le voile est mis :
   * l'ecran verrouille se lit par-dessus l'epaule aussi bien que le site.
   */
  corpsVoile?: string;
  /** La page ouverte au toucher, chemin du site : « /historique ». */
  url: string;
  /** Une alerte de meme etiquette remplace la precedente au lieu de s'empiler. */
  etiquette?: string;
};

/* ------------------------------------------------------------------ cles VAPID */

/**
 * La paire de cles qui signe les alertes (VAPID).
 *
 * Fournie par l'environnement si `ALERTES_CLE_PUBLIQUE` et `ALERTES_CLE_PRIVEE`
 * y sont ; sinon creee au premier besoin et gardee dans `settings`, d'une
 * seule ligne pour que les deux moities ne puissent jamais se desassortir.
 * Deux creations simultanees ecriraient deux lignes : la lecture prend
 * toujours la meme (la plus petite), et tout le monde signe avec elle.
 */
const CLE_REGLAGE = "alertes_vapid";

export async function clesAlertes(): Promise<{ publique: string; privee: string } | null> {
  const publique = variable("ALERTES_CLE_PUBLIQUE", "");
  const privee = variable("ALERTES_CLE_PRIVEE", "");
  if (publique && privee) return { publique, privee };
  try {
    const sql = db();
    const lire = async () => {
      const rows = await sql`select value from settings where key = ${CLE_REGLAGE} order by value limit 1`;
      if (!rows[0]) return null;
      const v = JSON.parse(String(rows[0].value)) as { publique?: string; privee?: string };
      return v.publique && v.privee ? { publique: v.publique, privee: v.privee } : null;
    };
    const lues = await lire();
    if (lues) return lues;
    const neuves = webpush.generateVAPIDKeys();
    const valeur = JSON.stringify({ publique: neuves.publicKey, privee: neuves.privateKey });
    await sql`
      insert into settings (key, value)
      select ${CLE_REGLAGE}, ${valeur}
      where not exists (select 1 from settings where key = ${CLE_REGLAGE})
    `;
    return await lire();
  } catch {
    return null;
  }
}

/** Le circuit des alertes est-il en place ? La table vient de `scripts/migration-alertes.sql`. */
export async function alertesPretes(): Promise<boolean> {
  try {
    await db()`select 1 from push_subscriptions limit 1`;
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- abonnements */

/**
 * Les services de notification connus. Le site depose ses alertes a l'adresse
 * que le telephone lui donne : sans cette liste, n'importe qui pourrait lui
 * faire appeler une adresse de son choix.
 */
const SERVICES = [
  /(^|\.)googleapis\.com$/, // Chrome et Android : fcm.googleapis.com
  /(^|\.)google\.com$/, // Chrome recent : jmt17.google.com
  /(^|\.)mozilla\.com$/, // Firefox : updates.push.services.mozilla.com
  /(^|\.)mozaws\.net$/,
  /(^|\.)push\.apple\.com$/, // Safari et iPhone : web.push.apple.com
  /(^|\.)notify\.windows\.com$/, // Edge
];

export type Abonnement = { endpoint: string; p256dh: string; auth: string };

/** Lit l'abonnement envoye par le navigateur, ou null s'il n'en est pas un. */
export function lireAbonnement(brut: unknown): Abonnement | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof o.endpoint !== "string" || o.endpoint.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(o.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !SERVICES.some((s) => s.test(url.hostname))) return null;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,60}$/.test(auth)) return null;
  return { endpoint: o.endpoint, p256dh, auth };
}

export type Appareil = { endpoint: string; depuis: string };

/** Les telephones d'un membre ou les alertes sont activees. */
export async function appareilsDe(membreId: string): Promise<Appareil[]> {
  try {
    const rows = await db()`
      select endpoint, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as depuis
      from push_subscriptions where member_id = ${membreId}::uuid
      order by created_at
    `;
    return rows.map((r) => ({ endpoint: String(r.endpoint), depuis: String(r.depuis) }));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------- envoi */

/** Apple exige une adresse de contact : le site lui-meme, sinon le compte qui envoie les courriels. */
function signataire(): string {
  const site = lienDuSite();
  const adresse = adresseDuCompte();
  return variable(
    "ALERTES_CONTACT",
    site.startsWith("https://") ? site : adresse ? `mailto:${adresse}` : "https://ip12-alpha.vercel.app",
  );
}

/**
 * Depose l'alerte sur chaque telephone des membres nommes.
 *
 * Un abonnement que le service declare perime (404, 410) est supprime : le
 * membre a desinstalle le site ou retire l'autorisation. Les autres echecs se
 * comptent, et un abonnement qui echoue dix fois de suite est retire.
 */
export async function envoyerAlertes(membreIds: string[], a: Alerte): Promise<{ envoyees: number; echecs: number }> {
  const bilan = { envoyees: 0, echecs: 0 };
  if (membreIds.length === 0) return bilan;
  const cles = await clesAlertes();
  if (!cles) return bilan;
  let abonnements: { id: string; endpoint: string; p256dh: string; auth: string }[];
  try {
    abonnements = (await db()`
      select id::text as id, endpoint, p256dh, auth
      from push_subscriptions where member_id = any(${[...new Set(membreIds)]}::uuid[])
    `) as typeof abonnements;
  } catch {
    return bilan;
  }
  const charge = JSON.stringify({
    titre: a.titre,
    corps: a.corps,
    corpsVoile: a.corpsVoile ?? null,
    url: a.url,
    etiquette: a.etiquette ?? null,
  });
  const sql = db();
  await Promise.all(
    abonnements.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, charge, {
          TTL: 60 * 60 * 24,
          urgency: "normal",
          vapidDetails: { subject: signataire(), publicKey: cles.publique, privateKey: cles.privee },
        });
        bilan.envoyees++;
        await sql`update push_subscriptions set last_ok_at = now(), failures = 0 where id = ${s.id}::uuid`.catch(() => null);
      } catch (e) {
        bilan.echecs++;
        const statut = (e as { statusCode?: number }).statusCode;
        if (statut === 404 || statut === 410) {
          await sql`delete from push_subscriptions where id = ${s.id}::uuid`.catch(() => null);
        } else {
          await sql`
            delete from push_subscriptions where id = ${s.id}::uuid and failures >= 9
          `.catch(() => null);
          await sql`update push_subscriptions set failures = failures + 1 where id = ${s.id}::uuid`.catch(() => null);
        }
      }
    }),
  );
  return bilan;
}

/**
 * Les personnes a prevenir : une part rachetee non fusionnee n'a pas de
 * telephone, c'est son detenteur qui recoit l'alerte.
 */
async function personnes(membreIds: string[]): Promise<string[]> {
  const membres = await listerMembres().catch(() => []);
  return membreIds.map((id) => membres.find((m) => m.id === id)?.titulaireId ?? id);
}

/**
 * Alerter apres la reponse : le tresorier qui valide ne doit pas attendre que
 * dix telephones aient ete joints pour voir sa page se mettre a jour.
 */
export function alerter(membreIds: string[], a: Alerte): void {
  try {
    after(async () => {
      try {
        await envoyerAlertes(await personnes(membreIds), a);
      } catch {
        // Une alerte perdue ne fait rien tomber : le courriel est parti.
      }
    });
  } catch {
    // Hors requete (verification) : rien a differer, rien a envoyer.
  }
}

/**
 * Une declaration attend le bureau : l'alerte dit combien il y en a en tout.
 *
 * Toutes portent la meme etiquette : la nouvelle remplace la precedente sur
 * l'ecran du tresorier, qui lit « 3 versements a valider » plutot que trois
 * alertes empilees, dont deux deja perimees.
 */
export function alerterAValider(params: {
  droit: Droit;
  auteurId: string;
  declarant: string;
  objet: string;
}): void {
  try {
    after(async () => {
      try {
        const sql = db();
        const [{ v }] = (await sql`
          select count(distinct coalesce(batch_id, id))::int as v
          from contributions where status = ${STATUT_VERSEMENT.enAttente}
        `) as { v: number }[];
        const r = await sql`
          select count(distinct batch_id)::int as r from penalty_settlements where status = ${STATUT_REGLEMENT.enAttente}
        `.then((x) => Number(x[0]?.r ?? 0)).catch(() => 0);
        const n = Number(v) + r;
        const titre =
          n <= 1
            ? "Une déclaration à valider"
            : r === 0
              ? `${n} versements à valider`
              : `${n} déclarations à valider`;
        const roles = DROITS[params.droit] as readonly Role[];
        const membres = await listerMembres();
        const ids = membres
          .filter((m) => m.actif && !m.titulaireId && roles.includes(m.role) && m.id !== params.auteurId)
          .map((m) => m.id);
        await envoyerAlertes(ids, {
          titre,
          corps: `${params.declarant} vient de déclarer ${params.objet}.`,
          corpsVoile: `${params.declarant} vient de déclarer un versement.`,
          url: "/a-valider",
          etiquette: "a-valider",
        });
      } catch {
        // Le courriel au bureau est parti ; l'alerte n'en est que le doublon rapide.
      }
    });
  } catch {
    // Hors requete : rien a differer.
  }
}
