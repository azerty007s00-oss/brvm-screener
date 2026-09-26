import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { seConnecter } from "@/app/actions/auth";
import { Champ, FormulaireAction } from "@/components/formulaires";
import { Alerte } from "@/components/ui";
import { CLUB } from "@/lib/settings";

export default async function PageConnexion() {
  if (baseConfiguree() && (await membreCourant())) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 text-center">
        <p
          className="inline-block rounded-full px-3 py-1 text-xs font-semibold tracking-widest uppercase"
          style={{ background: "var(--color-or-200)", color: "var(--color-or-600)" }}
        >
          {CLUB.sigle}
        </p>
        <h1 className="mt-3 text-2xl font-semibold">{CLUB.nom}</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--discret)" }}>
          Club d&apos;investissement &middot; {CLUB.ville}
        </p>
      </div>

      {!baseConfiguree() ? (
        <Alerte ton="rouge" titre="Base de donnees non configuree">
          La variable <code>DATABASE_URL</code> n&apos;est pas renseignee. Ajoutez-la dans les
          variables d&apos;environnement du projet, puis rechargez cette page.
        </Alerte>
      ) : (
        <div
          className="rounded-xl border p-5"
          style={{ background: "var(--carte)", borderColor: "var(--bordure)" }}
        >
          <FormulaireAction action={seConnecter} libelle="Se connecter">
            <Champ nom="email" libelle="Adresse e-mail" type="email" autoComplete="username" />
            <Champ
              nom="motDePasse"
              libelle="Mot de passe"
              type="password"
              autoComplete="current-password"
            />
          </FormulaireAction>
          <p className="mt-4 text-center text-xs" style={{ color: "var(--discret)" }}>
            Mot de passe oublie ? Demandez au president de le reinitialiser.
          </p>
        </div>
      )}
    </main>
  );
}
