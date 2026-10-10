import "server-only";
import { db } from "./db";

/**
 * Les compteurs de la table `login_attempts`.
 *
 * Deux familles y cohabitent, et elles ne doivent pas se melanger : les echecs
 * de connexion, qui bloquent la connexion, et les demandes de reinitialisation,
 * qui bloquent l'envoi d'un courriel au president. Melangees, la seconde
 * bloquerait le membre au moment precis ou il a besoin de la premiere -- il
 * vient d'echouer huit fois, c'est pour cela qu'il demande.
 *
 * Elles vivent hors de `auth.ts`, qui importe `next/headers` pour les cookies :
 * un controle qui veut verifier un plafond contre PostgreSQL n'a pas a compiler
 * le cadre entier.
 */

/** Fenetre et plafond de la protection anti-force brute. */
const FENETRE_ANTI_FORCE_MINUTES = 15;
const ECHECS_AVANT_BLOCAGE = 8;

export async function tropDeTentatives(email: string): Promise<boolean> {
  try {
    const sql = db();
    const rows = await sql`
      select count(*)::int as c
      from login_attempts
      where lower(email) = ${email.toLowerCase()}
        and ok = false
        and attempted_at > now() - (${FENETRE_ANTI_FORCE_MINUTES} || ' minutes')::interval
    `;
    return Number(rows[0]?.c ?? 0) >= ECHECS_AVANT_BLOCAGE;
  } catch {
    // Une table absente ne doit pas empecher de se connecter.
    return false;
  }
}

export async function tracerTentative(email: string, reussie: boolean): Promise<void> {
  try {
    const sql = db();
    await sql`
      insert into login_attempts (email, ok) values (${email.toLowerCase()}, ${reussie})
    `;
  } catch {
    // La trace est un confort, pas une condition de connexion.
  }
}

/**
 * Plafond des demandes de reinitialisation, par adresse.
 *
 * La demande n'ecrit qu'au president : l'abus se reduit donc a l'inonder. Le
 * plafond est compte dans `login_attempts`, sous une cle prefixee -- « reinit: »
 * devant l'adresse -- pour deux raisons : aucune table n'est a creer, donc
 * aucune migration a executer a la main dans Neon ; et ces lignes ne se
 * melangent pas aux echecs de connexion, qui bloqueraient le membre lui-meme.
 */
const DEMANDES_AVANT_BLOCAGE = 3;

const cleDemande = (email: string) => `reinit:${email.toLowerCase()}`;

export async function tropDeDemandes(email: string): Promise<boolean> {
  try {
    const sql = db();
    const rows = await sql`
      select count(*)::int as c
      from login_attempts
      where lower(email) = ${cleDemande(email)}
        and attempted_at > now() - (${FENETRE_ANTI_FORCE_MINUTES} || ' minutes')::interval
    `;
    return Number(rows[0]?.c ?? 0) >= DEMANDES_AVANT_BLOCAGE;
  } catch {
    /*
     * Table absente : on laisse passer. Le pire est alors un courriel de trop
     * au president ; le refuser priverait d'acces un membre qui a vraiment
     * oublie son mot de passe.
     */
    return false;
  }
}

export async function tracerDemande(email: string): Promise<void> {
  try {
    const sql = db();
    await sql`
      insert into login_attempts (email, ok) values (${cleDemande(email)}, true)
    `;
  } catch {
    // La trace est un confort, pas une condition.
  }
}

