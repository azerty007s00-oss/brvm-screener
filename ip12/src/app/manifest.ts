import type { MetadataRoute } from "next";
import { CLUB } from "@/lib/settings";

/**
 * LE SITE S'INSTALLE COMME UNE APPLICATION.
 *
 * On l'ouvrait dans Safari ou Chrome, barre d'adresse et onglets compris, la ou
 * Wave ou la banque s'ouvrent d'un toucher sur l'ecran d'accueil. Ce manifeste
 * le rend installable : « Ajouter a l'ecran d'accueil » pose l'icone du club,
 * et le site s'ouvre ensuite en plein ecran, sur l'Accueil, sans rien du
 * navigateur autour. La navigation basse du site suffit a s'y deplacer.
 *
 * Les couleurs sont celles de la page, pour que la barre d'etat se fonde dans
 * l'en-tete ; l'icone est la marque du site, la tuile bleu nuit et sa courbe.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${CLUB.sigle} · ${CLUB.nom}`,
    short_name: CLUB.sigle,
    description: `Versements, parts et portefeuille du club d'investissement ${CLUB.nom}.`,
    lang: "fr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fdfcfa",
    theme_color: "#fdfcfa",
    icons: [
      { src: "/icone-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icone-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      /* La marque tient dans la zone sure : Android peut decouper l'icone en cercle sans l'entamer. */
      { src: "/icone-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
