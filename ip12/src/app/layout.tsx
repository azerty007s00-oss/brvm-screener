import type { Metadata, Viewport } from "next";
import { CLUB } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: `${CLUB.sigle} - ${CLUB.nom}`,
  description: `Suivi des versements, des parts et du portefeuille du club d'investissement ${CLUB.nom}.`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2a1a10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
