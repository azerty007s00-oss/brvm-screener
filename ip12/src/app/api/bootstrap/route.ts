import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hacherMotDePasse, motDePasseProvisoire } from "@/lib/auth";
import { CLUB, variable } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Reprise en main du compte president, sans avoir a executer de script.
 *
 * Deux situations :
 *  - aucun membre en base : le compte president est cree ;
 *  - le membre existe deja (cas de la base heritee, dont les mots de passe ont ete
 *    produits par une version anterieure au format inconnu) : son mot de passe est
 *    reinitialise.
 *
 * Garde-fous : un jeton secret (SETUP_TOKEN) et une seule adresse cible, celle de
 * BOOTSTRAP_EMAIL. A retirer des variables d'environnement une fois utilisee.
 */
export async function GET(requete: Request) {
  const jeton = process.env.SETUP_TOKEN;
  if (!jeton) {
    return NextResponse.json(
      { erreur: "SETUP_TOKEN n'est pas definie dans les variables d'environnement." },
      { status: 503 },
    );
  }
  if (new URL(requete.url).searchParams.get("token") !== jeton) {
    return NextResponse.json({ erreur: "Jeton invalide." }, { status: 401 });
  }

  const email = variable("BOOTSTRAP_EMAIL", "").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ erreur: "BOOTSTRAP_EMAIL absente ou invalide." }, { status: 400 });
  }

  const sql = db();
  const provisoire = motDePasseProvisoire();

  let existant;
  try {
    existant = await sql`select id, full_name, role from members where lower(email) = ${email}`;
  } catch (e) {
    return NextResponse.json(
      {
        erreur: "La table members n'existe pas. Verifiez que DATABASE_URL pointe sur la bonne base.",
        detail: String(e),
      },
      { status: 409 },
    );
  }

  if (existant.length > 0) {
    const membre = existant[0];
    await sql`
      update members
      set password_hash = ${hacherMotDePasse(provisoire)},
          must_change_password = true,
          role = 'president',
          is_active = true
      where id = ${membre.id}::uuid
    `;
    return NextResponse.json({
      ok: true,
      action: "mot_de_passe_reinitialise",
      message:
        "Mot de passe reinitialise. Connectez-vous, changez-le immediatement, " +
        "puis supprimez SETUP_TOKEN des variables d'environnement.",
      membre: membre.full_name,
      email,
      motDePasseProvisoire: provisoire,
    });
  }

  const autres = await sql`
    select email, full_name, role from members order by full_name
  `;
  if (autres.length > 0) {
    // Le jeton est deja fourni : lister les adresses evite un aller-retour vers
    // la console pour corriger BOOTSTRAP_EMAIL.
    return NextResponse.json(
      {
        erreur:
          "Des membres existent, mais aucun ne porte cette adresse. " +
          "Reprenez l'une des adresses ci-dessous dans BOOTSTRAP_EMAIL, puis redeployez.",
        adresseCherchee: email,
        membresEnregistres: autres.map((m) => ({
          nom: m.full_name,
          email: m.email,
          role: m.role,
        })),
      },
      { status: 409 },
    );
  }

  await sql`
    insert into members (full_name, email, role, password_hash, must_change_password, joined_on)
    values (${variable("BOOTSTRAP_NOM", "President")}, ${email}, 'president',
            ${hacherMotDePasse(provisoire)}, true, ${CLUB.dateCreation}::date)
  `;
  return NextResponse.json({
    ok: true,
    action: "compte_cree",
    message:
      "Compte president cree. Connectez-vous, changez ce mot de passe, " +
      "puis supprimez SETUP_TOKEN des variables d'environnement.",
    email,
    motDePasseProvisoire: provisoire,
  });
}
