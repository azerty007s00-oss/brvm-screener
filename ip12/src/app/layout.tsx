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
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /* Le brun de la marque reste la teinte du navigateur, en clair comme en nuit. */
  themeColor: "#2a1a10",
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
