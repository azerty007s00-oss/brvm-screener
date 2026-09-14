import Link from "next/link";
import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { seDeconnecter } from "@/app/actions/auth";
import { CLUB, ROLES } from "@/lib/settings";
import { peut, type Droit } from "@/lib/droits";
import { Alerte } from "@/components/ui";
import { Navigation } from "@/components/navigation";
import { versionDeployee } from "@/lib/version";

/*
 * Deux rangees, et non plus une barre de dix onglets : on ne voyait pas qu'elle
 * defilait, et l'on cherchait longtemps une page qui etait la.
 *
 * « Mon suivi » porte ce qu'un membre ouvre chaque mois, et tient sans defiler.
 * « Le club » porte le reste, ouvert a tous : la transparence des comptes est le
 * principe du club (art. 12).
 */
const SUIVI: { href: string; libelle: string; droit?: Droit }[] = [
  { href: "/", libelle: "Accueil" },
  { href: "/versements", libelle: "Versements" },
  // L'administration est l'outil quotidien du president : elle tient au premier rang.
  { href: "/administration", libelle: "Administration", droit: "gererReglages" },
  { href: "/mon-compte", libelle: "Mon compte" },
];

const VIE_DU_CLUB: { href: string; libelle: string; droit?: Droit }[] = [
  { href: "/caisse", libelle: "Caisse" },
  { href: "/compte-titres", libelle: "Titres" },
  { href: "/portefeuille", libelle: "Portefeuille" },
  { href: "/penalites", libelle: "Penalites" },
  { href: "/reunions", libelle: "Reunions" },
  { href: "/membres", libelle: "Membres" },
];
export default async function CoquilleApplication({ children }: { children: React.ReactNode }) {
  if (!baseConfiguree()) redirect("/login");
  const membre = await membreCourant();
  if (!membre) redirect("/login");

  const version = versionDeployee();

  return (
    <div className="min-h-screen">
      <header
        className="sans-impression sticky top-0 z-10 border-b backdrop-blur"
        style={{ background: "var(--color-brun-900)", borderColor: "var(--color-brun-700)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span
              className="grid h-8 w-8 place-items-center rounded-lg text-xs font-bold"
              style={{ background: "var(--color-or-500)", color: "var(--color-brun-900)" }}
            >
              IP
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold" style={{ color: "var(--color-brun-50)" }}>
                {CLUB.sigle}
              </span>
              <span className="block text-[11px]" style={{ color: "var(--color-brun-300)" }}>
                {ROLES[membre.role]} &middot; {membre.nom}
              </span>
            </span>
          </Link>
          <form action={seDeconnecter}>
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ background: "var(--color-brun-700)", color: "var(--color-brun-100)" }}
            >
              Quitter
            </button>
          </form>
        </div>

        <Navigation
          suivi={SUIVI.filter((l) => !l.droit || peut(membre, l.droit)).map(({ href, libelle }) => ({ href, libelle }))}
          club={VIE_DU_CLUB.filter((l) => !l.droit || peut(membre, l.droit)).map(({ href, libelle }) => ({ href, libelle }))}
        />
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">
        {membre.must_change_password && (
          <Alerte ton="ambre" titre="Mot de passe provisoire">
            Votre mot de passe a ete cree par le president.{" "}
            <Link href="/mon-compte" className="underline">
              Definissez le votre
            </Link>{" "}
            pour securiser votre compte.
          </Alerte>
        )}
        {children}
      </main>

      <footer className="sans-impression mx-auto max-w-5xl px-4 pb-8 pt-2 text-center text-[11px]" style={{ color: "var(--discret)" }}>
        {CLUB.nom} &middot; {CLUB.ville} &middot; compte-titres {CLUB.sgi}
        {version.revision && (
          <>
            <br />
            <span title={version.titre ?? undefined}>
              version {version.revision}
              {version.depot ? ` \u00b7 ${version.depot}` : ""}
              {version.branche ? ` \u00b7 ${version.branche}` : ""}
            </span>
          </>
        )}
      </footer>
    </div>
  );
}
