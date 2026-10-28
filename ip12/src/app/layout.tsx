import type { Metadata, Viewport } from "next";
import { CLUB } from "@/lib/settings";
import { SCRIPT_VOILE } from "@/lib/voile";
import "./globals.css";

export const metadata: Metadata = {
  /*
   * Le titre de l'onglet suit la page : « Portefeuille · IP12 ».
   *
   * Dix onglets ouverts portaient le meme nom, et il fallait les parcourir un
   * a un. Chaque page pose desormais son titre ; le gabarit ajoute le sigle.
   */
  title: {
    default: `${CLUB.sigle} - ${CLUB.nom}`,
    template: `%s \u00b7 ${CLUB.sigle}`,
  },
  description: `Suivi des versements, des parts et du portefeuille du club d'investissement ${CLUB.nom}.`,
  /*
   * Installe sur l'ecran d'accueil d'un iPhone, le site s'ouvre en plein ecran
   * sous le nom du club, la barre d'etat sur le fond de la page.
   */
  appleWebApp: {
    capable: true,
    title: CLUB.sigle,
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /*
   * Installe en plein ecran, le site occupe tout l'ecran du telephone ; la
   * navigation basse se tient au-dessus de la barre d'accueil de l'iPhone par
   * son retrait `safe-area-inset-bottom` (components/coque.tsx).
   */
  viewportFit: "cover",
  /*
   * La teinte du navigateur et de la barre d'etat : celle de la page, claire
   * le jour, sombre la nuit. Le brun d'une ancienne charte y etait reste, une
   * bande sombre au-dessus d'un site devenu clair.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfcfa" },
    { media: "(prefers-color-scheme: dark)", color: "#13110e" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * La classe « voile » est posee par le script avant la peinture, d'apres le
     * choix garde sur l'appareil : le serveur ne la connait pas, d'ou l'ecart
     * tolere a l'hydratation sur cet element-la, et sur lui seul.
     */
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_VOILE }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
