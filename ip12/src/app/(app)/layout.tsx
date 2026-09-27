import Link from "next/link";
import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { seDeconnecter } from "@/app/actions/auth";
import { CLUB, ROLES } from "@/lib/settings";
import { peut, type Droit } from "@/lib/droits";
import { Bienvenue } from "@/components/bienvenue";
import { Navigation } from "@/components/navigation";
import type { NomIcone } from "@/components/icones";
import { versionDeployee } from "@/lib/version";

/*
 * Deux rangees, et non plus une barre de dix onglets : on ne voyait pas qu'elle
 * defilait, et l'on cherchait longtemps une page qui etait la.
 *
 * « Mon suivi » porte ce qu'un membre ouvre chaque mois, et tient sans defiler.
 * « Le club » porte le reste, ouvert a tous : la transparence des comptes est le
 * principe du club (art. 12).
 */
type Entree = { href: string; libelle: string; icone: NomIcone; droit?: Droit };

const SUIVI: Entree[] = [
  { href: "/", libelle: "Accueil", icone: "maison" },
  { href: "/versements", libelle: "Versements", icone: "billets" },
  // L'administration est l'outil quotidien du president : elle tient au premier rang.
  { href: "/administration", libelle: "Administration", icone: "reglages", droit: "gererReglages" },
  { href: "/mon-compte", libelle: "Mon compte", icone: "personne" },
];

const VIE_DU_CLUB: Entree[] = [
  { href: "/caisse", libelle: "Caisse", icone: "coffre" },
  { href: "/compte-titres", libelle: "Titres", icone: "echange" },
  { href: "/portefeuille", libelle: "Portefeuille", icone: "graphique" },
  { href: "/penalites", libelle: "Penalites", icone: "alerte" },
  { href: "/reunions", libelle: "Reunions", icone: "calendrier" },
  { href: "/membres", libelle: "Membres", icone: "personnes" },
];
export default async function CoquilleApplication({ children }: { children: React.ReactNode }) {
  if (!baseConfiguree()) redirect("/login");
  const membre = await membreCourant();
  if (!membre) redirect("/login");

  const version = versionDeployee();

  return (
    <div className="min-h-screen">
      {/*
        * Pas de `backdrop-blur` ici : le fond de l'en-tete est opaque, le flou
        * n'y paraissait pas -- mais un ancetre portant `backdrop-filter` devient
        * le bloc conteneur de ses descendants en position fixe, et le tiroir de
        * navigation s'y trouvait enferme, reduit a la hauteur de l'en-tete.
        */}
      <header
        className="sans-impression sticky top-0 z-10 border-b"
        style={{ background: "var(--color-brun-900)", borderColor: "var(--color-brun-700)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          {/*
            * Le menu ouvre a gauche, comme partout : le pouce d'une main droite
            * l'atteint mal, mais l'oeil le cherche la, et c'est l'oeil qui
            * decide ou l'on croit etre.
            */}
          {!membre.must_change_password && (
            <Navigation
              suivi={SUIVI.filter((l) => !l.droit || peut(membre, l.droit)).map(({ href, libelle, icone }) => ({ href, libelle, icone }))}
              club={VIE_DU_CLUB.filter((l) => !l.droit || peut(membre, l.droit)).map(({ href, libelle, icone }) => ({ href, libelle, icone }))}
              membre={{ nom: membre.nom, email: membre.email, role: ROLES[membre.role] }}
            />
          )}
          <Link href="/" className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className="grid h-8 w-8 place-items-center rounded-lg text-xs font-bold"
              style={{ background: "var(--color-or-500)", color: "var(--color-brun-900)" }}
            >
              IP
            </span>
            {/*
              * Une seule ligne pour le titre : le nom entier passait a la ligne
              * depuis que le menu occupe la gauche, et l'en-tete gonflait sur
              * tous les ecrans. Le nom complet et l'adresse figurent en entier
              * dans le tiroir, ou rien ne dispute la largeur.
              */}
            <span className="min-w-0 leading-tight">
              <span className="block text-sm font-semibold" style={{ color: "var(--color-brun-50)" }}>
                {CLUB.sigle}
              </span>
              <span className="block truncate text-[11px]" style={{ color: "var(--color-brun-300)" }}>
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

      </header>

      {/*
        * Premiere connexion : l'ecran d'accueil prend la place du contenu, sur
        * toutes les routes. C'est une porte, pas une redirection -- aucune page
        * n'est atteignable par l'adresse directe, et « Quitter » reste offert.
        */}
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">
        {membre.must_change_password ? <Bienvenue membre={membre} /> : children}
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
