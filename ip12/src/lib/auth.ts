import { cookies } from "next/headers";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import type { Role } from "./settings";

const COOKIE = "ip12_session";
const DUREE_SESSION_JOURS = 30;

export type Membre = {
  id: number;
  nom: string;
  email: string;
  telephone: string | null;
  role: Role;
  must_change_password: boolean;
  actif: boolean;
  date_adhesion: string;
};

/* ---------------------------------------------------------------- mots de passe */

/** scrypt : cout memoire eleve, inclus dans Node, aucune dependance native. */
export function hacherMotDePasse(motDePasse: string): string {
  const sel = randomBytes(16).toString("hex");
  const cle = scryptSync(motDePasse, sel, 64).toString("hex");
  return `scrypt:${sel}:${cle}`;
}

export function verifierMotDePasse(motDePasse: string, hash: string | null): boolean {
  if (!hash) return false;
  const [algo, sel, attendu] = hash.split(":");
  if (algo !== "scrypt" || !sel || !attendu) return false;
  const calcule = scryptSync(motDePasse, sel, 64);
  const reference = Buffer.from(attendu, "hex");
  // Comparaison a temps constant : ne fuit pas la position du premier octet different.
  return calcule.length === reference.length && timingSafeEqual(calcule, reference);
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

function creerJeton(membreId: number): string {
  const expiration = Date.now() + DUREE_SESSION_JOURS * 86_400_000;
  const charge = `${membreId}.${expiration}`;
  return `${charge}.${signer(charge)}`;
}

function lireJeton(jeton: string): number | null {
  const parts = jeton.split(".");
  if (parts.length !== 3) return null;
  const [id, expiration, signature] = parts;
  const attendue = signer(`${id}.${expiration}`);
  // timingSafeEqual exige deux Buffers de meme longueur.
  const a = Buffer.from(signature);
  const b = Buffer.from(attendue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiration) < Date.now()) return null;
  return Number(id);
}

export async function ouvrirSession(membreId: number): Promise<void> {
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
    const rows = (await sql`
      select id, nom, email, telephone, role, must_change_password, actif,
             to_char(date_adhesion, 'YYYY-MM-DD') as date_adhesion
      from membres where id = ${id} and actif = true
    `) as Membre[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
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
