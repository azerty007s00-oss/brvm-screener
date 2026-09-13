import { cookies } from "next/headers";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import type { Role } from "./settings";

const COOKIE = "ip12_session";
const DUREE_SESSION_JOURS = 30;

/** Fenetre et plafond de la protection anti-force brute (table login_attempts). */
const FENETRE_ANTI_FORCE_MINUTES = 15;
const ECHECS_AVANT_BLOCAGE = 8;

export type Membre = {
  id: string;
  nom: string;
  email: string;
  telephone: string | null;
  titre: string | null;
  role: Role;
  must_change_password: boolean;
  actif: boolean;
  date_adhesion: string;
};

/** Projection commune : traduit les colonnes de la base vers le vocabulaire du code. */
const CHAMPS_MEMBRE = `
  id, full_name as nom, email, phone as telephone, title as titre, role,
  must_change_password, is_active as actif,
  to_char(joined_on, 'YYYY-MM-DD') as date_adhesion
`;

/* ---------------------------------------------------------------- mots de passe */

/** scrypt : cout memoire eleve, inclus dans Node, aucune dependance native. */
export function hacherMotDePasse(motDePasse: string): string {
  const sel = randomBytes(16).toString("hex");
  const cle = scryptSync(motDePasse, sel, 64).toString("hex");
  return `scrypt:${sel}:${cle}`;
}

/**
 * Verifie un mot de passe.
 *
 * Les hash produits par la version precedente du site sont d'un format inconnu :
 * ils echouent ici, ce qui ferme la porte plutot que de l'ouvrir. La reprise en
 * main passe par la route de recuperation, qui reinitialise le mot de passe.
 */
/**
 * Mot de passe provisoire lisible a l'oral : 3 groupes de 4, sans les caracteres
 * que l'on confond (I, O, 0, 1). Transmis au membre, qui le remplace lui-meme.
 */
export function motDePasseProvisoire(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const brut = Array.from(randomBytes(12), (o) => alphabet[o % alphabet.length]).join("");
  return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}`;
}

export function verifierMotDePasse(motDePasse: string, hash: string | null): boolean {
  if (!hash) return false;
  const [algo, sel, attendu] = hash.split(":");
  if (algo !== "scrypt" || !sel || !attendu) return false;
  let reference: Buffer;
  try {
    reference = Buffer.from(attendu, "hex");
  } catch {
    return false;
  }
  const calcule = scryptSync(motDePasse, sel, 64);
  // Comparaison a temps constant : ne fuit pas la position du premier octet different.
  return calcule.length === reference.length && timingSafeEqual(calcule, reference);
}

/* ------------------------------------------------------- protection anti-force brute */

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

/* -------------------------------------------------------------------- sessions */

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET absente ou trop courte (32 caracteres minimum).");
  }
  return s;
}

function signer(charge: string): string {
  return createHmac("sha256", secret()).update(charge).digest("base64url");
}

/**
 * Jeton : identifiant, expiration, signature. Les identifiants etant des UUID,
 * ils contiennent des tirets mais jamais de point : le point reste un separateur sur.
 */
function creerJeton(membreId: string): string {
  const expiration = Date.now() + DUREE_SESSION_JOURS * 86_400_000;
  const charge = `${membreId}.${expiration}`;
  return `${charge}.${signer(charge)}`;
}

function lireJeton(jeton: string): string | null {
  const parts = jeton.split(".");
  if (parts.length !== 3) return null;
  const [id, expiration, signature] = parts;
  const attendue = signer(`${id}.${expiration}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(attendue);
  // timingSafeEqual exige deux Buffers de meme longueur.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!Number(expiration) || Number(expiration) < Date.now()) return null;
  return id;
}

export async function ouvrirSession(membreId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, creerJeton(membreId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DUREE_SESSION_JOURS * 86_400,
  });
}

export async function fermerSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/** Membre connecte, ou null. Ne leve jamais : sert aussi aux pages publiques. */
export async function membreCourant(): Promise<Membre | null> {
  try {
    const jar = await cookies();
    const jeton = jar.get(COOKIE)?.value;
    if (!jeton) return null;
    const id = lireJeton(jeton);
    if (id === null) return null;
    const sql = db();
    const rows = await sql`
      select ${sql.unsafe(CHAMPS_MEMBRE)}
      from members where id = ${id}::uuid and is_active = true
    `;
    return (rows[0] as Membre) ?? null;
  } catch {
    return null;
  }
}

export async function membreParEmail(email: string) {
  const sql = db();
  const rows = await sql`
    select id, password_hash, is_active as actif, full_name as nom
    from members where lower(email) = ${email.toLowerCase()}
  `;
  return rows[0] as
    | { id: string; password_hash: string | null; actif: boolean; nom: string }
    | undefined;
}

/* ------------------------------------------------------------------ garde-fous */

export class AccesRefuse extends Error {
  constructor(message = "Acces refuse.") {
    super(message);
    this.name = "AccesRefuse";
  }
}

export async function exigerMembre(): Promise<Membre> {
  const m = await membreCourant();
  if (!m) throw new AccesRefuse("Vous devez etre connecte.");
  return m;
}

export async function exigerRole(...roles: Role[]): Promise<Membre> {
  const m = await exigerMembre();
  if (!roles.includes(m.role)) {
    throw new AccesRefuse("Cette action est reservee au bureau du club.");
  }
  return m;
}

export const estPresident = (m: Membre | null) => m?.role === "president";
export const estTresorier = (m: Membre | null) => m?.role === "tresorier";
export const estBureau = (m: Membre | null) => estPresident(m) || estTresorier(m);
