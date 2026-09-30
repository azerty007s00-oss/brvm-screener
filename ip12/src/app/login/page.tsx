import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { seConnecter } from "@/app/actions/auth";
import { Champ, FormulaireAction } from "@/components/formulaires";
import { Alerte } from "@/components/ui";
import { CLUB } from "@/lib/settings";

export const metadata = { title: "Connexion" };

export default async function PageConnexion() {
  if (baseConfiguree() && (await membreCourant())) redirect("/");

  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center px-5 py-10"
      /* `--side` designe la colonne bleu nuit ; cette page garde sa surface calme. */
      style={{ background: "var(--repos)" }}
    >
      <div className="mb-7 flex flex-col items-center text-center">
        <span
          className="grid h-8 w-8 place-items-center rounded-[9px]"
          style={{ background: "var(--brand)", color: "var(--brand-mark)" }}
        >
          <svg viewBox="0 0 26 26" width="22" height="22" aria-hidden="true">
            <path
              d="M7 17.5 L11.4 13 L14.4 15.4 L19 9.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="19" cy="9.6" r="1.7" fill="currentColor" />
          </svg>
        </span>
        <h1 className="mt-3 text-[20px] font-semibold">{CLUB.sigle}</h1>
        <p className="text-[14px]" style={{ color: "var(--ink-2)" }}>
          {CLUB.nom}
        </p>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
          Club d&apos;investissement &middot; {CLUB.ville}, Cote d&apos;Ivoire
        </p>
      </div>

      {!baseConfiguree() ? (
        <Alerte ton="rouge" titre="Base de donnees non configuree">
          La variable <code>DATABASE_URL</code> n&apos;est pas renseignee. Ajoutez-la dans les
          variables d&apos;environnement du projet, puis rechargez cette page.
        </Alerte>
      ) : (
        <div
          className="w-full max-w-[400px] rounded-xl border p-8"
          style={{ background: "var(--page)", borderColor: "var(--line)" }}
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
          <p className="mt-5 text-center text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            Mot de passe oublie ? Demandez au president de le reinitialiser.
          </p>
        </div>
      )}
    </main>
  );
}
