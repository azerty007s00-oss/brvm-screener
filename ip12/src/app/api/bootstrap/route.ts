import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { hacherMotDePasse } from "@/lib/auth";
import { CLUB } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Cree le tout premier compte, celui du president, sans avoir a executer de script.
 *
 * Deux garde-fous : un jeton secret (SETUP_TOKEN) et le fait que la route refuse de
 * s'executer des qu'un membre existe. Elle devient donc inerte apres le premier appel.
 */
export async function GET(requete: Request) {
  const jeton = process.env.SETUP_TOKEN;
  if (!jeton) {
    return NextResponse.json(
      { erreur: "SETUP_TOKEN n'est pas definie dans les variables d'environnement." },
      { status: 503 },
    );
  }
  const fourni = new URL(requete.url).searchParams.get("token");
  if (fourni !== jeton) {
    return NextResponse.json({ erreur: "Jeton invalide." }, { status: 401 });
  }

  const sql = db();
  let existants;
  try {
    existants = await sql`select count(*)::int as c from membres`;
  } catch (e) {
    return NextResponse.json(
      { erreur: "Les tables n'existent pas encore. Executez scripts/schema.sql dans la console Neon.", detail: String(e) },
      { status: 409 },
    );
  }

  if (Number(existants[0]?.c ?? 0) > 0) {
    return NextResponse.json(
      { erreur: "Des membres existent deja : cette route est desormais sans effet." },
      { status: 409 },
    );
  }

  const nom = process.env.BOOTSTRAP_NOM ?? "President";
  const email = (process.env.BOOTSTRAP_EMAIL ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ erreur: "BOOTSTRAP_EMAIL absente ou invalide." }, { status: 400 });
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const brut = Array.from(randomBytes(12), (o) => alphabet[o % alphabet.length]).join("");
  const provisoire = `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}`;

  await sql`
    insert into membres (nom, email, role, password_hash, must_change_password, date_adhesion)
    values (${nom}, ${email}, 'president', ${hacherMotDePasse(provisoire)}, true, ${CLUB.dateCreation}::date)
  `;

  return NextResponse.json({
    ok: true,
    message: "Compte president cree. Connectez-vous puis changez ce mot de passe immediatement.",
    email,
    motDePasseProvisoire: provisoire,
  });
}
