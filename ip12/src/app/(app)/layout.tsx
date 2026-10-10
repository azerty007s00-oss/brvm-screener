import { redirect } from "next/navigation";
import { membreCourant } from "@/lib/auth";
import { baseConfiguree } from "@/lib/db";
import { ROLES } from "@/lib/settings";
import { peut, type Droit } from "@/lib/droits";
import { Bienvenue } from "@/components/bienvenue";
import { Coque, type Rubrique } from "@/components/coque";
import type { NomIcone } from "@/components/icones";
import { versionDeployee } from "@/lib/version";

/*
 * Cinq rubriques pour dix pages.
 *
 * Une barre de dix onglets defilait sans qu'on le voie ; deux rangees mangeaient
 * la largeur ; un tiroir cachait tout derriere un bouton, y compris sur un ecran
 * de 1 440 px ou la place ne manquait pas. Le decoupage en rubriques sert les
 * deux mises en page a la fois : cinq entrees en bas sur telephone, et sur
 * ordinateur une barre laterale ou les groupes reprennent leur nom.
 *
 * « Comptes » et « Club » portent plusieurs pages ; les trois autres n'en ont
 * qu'une, et menent donc directement a elle.
 */
type Entree = { href: string; libelle: string; icone: NomIcone; droit?: Droit };
type Modele = { cle: string; libelle: string; icone: NomIcone; pages: Entree[] };

const RUBRIQUES: Modele[] = [
  { cle: "accueil", libelle: "Accueil", icone: "maison", pages: [{ href: "/", libelle: "Accueil", icone: "maison" }] },
  {
    cle: "versements",
    libelle: "Versements",
    icone: "billets",
    pages: [{ href: "/versements", libelle: "Versements", icone: "billets" }],
  },
  {
    cle: "comptes",
    libelle: "Comptes",
    icone: "graphique",
    pages: [
      { href: "/portefeuille", libelle: "Portefeuille", icone: "graphique" },
      { href: "/caisse", libelle: "Caisse", icone: "coffre" },
      { href: "/compte-titres", libelle: "Titres", icone: "echange" },
      { href: "/penalites", libelle: "Pénalités", icone: "alerte" },
    ],
  },
  {
    cle: "club",
    libelle: "Club",
    icone: "personnes",
    pages: [
      { href: "/reunions", libelle: "Réunions", icone: "calendrier" },
      { href: "/membres", libelle: "Membres", icone: "personnes" },
    ],
  },
  {
    cle: "moi",
    libelle: "Moi",
    icone: "personne",
    pages: [
      { href: "/mon-compte", libelle: "Mon compte", icone: "personne" },
      { href: "/administration", libelle: "Administration", icone: "reglages", droit: "gererReglages" },
    ],
  },
];

export default async function CoquilleApplication({ children }: { children: React.ReactNode }) {
  if (!baseConfiguree()) redirect("/login");
  const membre = await membreCourant();
  if (!membre) redirect("/login");

  /*
   * Le filtrage des droits a lieu ici, au serveur : une page qu'un membre ne
   * peut pas ouvrir n'apparait pas dans sa navigation, plutot que d'y figurer
   * grisee. La liste envoyee au navigateur ne porte donc que ce a quoi il a
   * droit -- elle ne dit meme pas que le reste existe.
   */
  const rubriques: Rubrique[] = RUBRIQUES.map((r) => ({
    cle: r.cle,
    libelle: r.libelle,
    icone: r.icone,
    pages: r.pages
      .filter((p) => !p.droit || peut(membre, p.droit))
      .map(({ href, libelle, icone }) => ({ href, libelle, icone })),
  })).filter((r) => r.pages.length > 0);

  const version = versionDeployee();

  return (
    <Coque
      rubriques={rubriques}
      personne={{ nom: membre.nom, email: membre.email, role: ROLES[membre.role] }}
      version={{ revision: version.revision, titre: version.titre }}
      alerte={peut(membre, "validerVersement")}
    >
      {/*
        * Premiere connexion : l'ecran d'accueil prend la place du contenu, sur
        * toutes les routes. C'est une porte, pas une redirection -- aucune page
        * n'est atteignable par l'adresse directe.
        */}
      {membre.must_change_password ? <Bienvenue membre={membre} /> : children}
    </Coque>
  );
}
