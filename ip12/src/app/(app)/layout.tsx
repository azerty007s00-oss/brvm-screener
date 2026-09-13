import Link from "next/link";
import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { seDeconnecter } from "@/app/actions/auth";
import { CLUB, ROLES } from "@/lib/settings";
import { Alerte } from "@/components/ui";

const LIENS = [
  { href: "/", libelle: "Tableau de bord" },
  { href: "/versements", libelle: "Versements" },
  { href: "/compte-titres", libelle: "Compte-titres" },
  { href: "/portefeuille", libelle: "Portefeuille" },
  { href: "/membres", libelle: "Membres" },
  { href: "/mon-compte", libelle: "Mon compte" },
];

export default async function CoquilleApplication({ children }: { children: React.ReactNode }) {
  if (!baseConfiguree()) redirect("/login");
  const membre = await membreCourant();
  if (!membre) redirect("/login");

  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-10 border-b backdrop-blur"
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

        <nav className="defilement-x mx-auto max-w-5xl px-4 pb-2">
          <ul className="flex gap-1 whitespace-nowrap">
            {LIENS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="block rounded-lg px-3 py-1.5 text-xs font-medium transition"
                  style={{ color: "var(--color-brun-100)" }}
                >
                  {l.libelle}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
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

      <footer className="mx-auto max-w-5xl px-4 pb-8 pt-2 text-center text-[11px]" style={{ color: "var(--discret)" }}>
        {CLUB.nom} &middot; {CLUB.ville} &middot; compte-titres {CLUB.sgi}
      </footer>
    </div>
  );
}
