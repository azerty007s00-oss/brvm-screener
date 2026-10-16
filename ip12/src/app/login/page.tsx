import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { demanderReinitialisation, seConnecter } from "@/app/actions/auth";
import { Champ, Depliant, FormulaireAction } from "@/components/formulaires";
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
          Club d&apos;investissement &middot; {CLUB.ville}, Côte d&apos;Ivoire
        </p>
      </div>

      {!baseConfiguree() ? (
        <Alerte ton="rouge" titre="Base de données non configurée">
          La variable <code>DATABASE_URL</code> n&apos;est pas renseignée. Ajoutez-la dans les
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
          {/*
            * LA PHRASE MENE QUELQUE PART.
            *
            * Elle disait « demandez au president de le reinitialiser » sans
            * donner le moyen de le demander : le membre rouvrait le groupe
            * WhatsApp, ce que le site est cense remplacer. Un lien `mailto:`
            * aurait publie l'adresse du president sur une page que n'importe
            * qui peut ouvrir ; le site, lui, la connait deja et sait ecrire.
            *
            * Un depliant, non une autre page : la demande se fait sans quitter
            * l'ecran de connexion, et ne s'impose a personne.
            */}
          <div className="mt-4">
            <Depliant titre="Mot de passe oublié ?">
              <p className="mb-3 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                Indiquez l&apos;adresse avec laquelle vous vous connectez. Le président en
                sera averti et vous donnera un mot de passe provisoire. Aucun mot de passe
                ne circule par courriel.
              </p>
              <FormulaireAction action={demanderReinitialisation} libelle="Prévenir le président">
                <Champ nom="email" libelle="Votre e-mail" type="email" autoComplete="email" />
              </FormulaireAction>
            </Depliant>
          </div>
        </div>
      )}
    </main>
  );
}
