/*
 * Le jeu d'icones tient dans ce fichier : douze traits, dessines a la main en
 * SVG. Aucune police d'icones a telecharger, donc rien a attendre sur une
 * connexion lente, et rien qui disparaisse si un CDN tombe.
 */
type Props = { taille?: number; couleur?: string };

function Trait({ taille = 19, couleur = "currentColor", children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={taille}
      height={taille}
      viewBox="0 0 24 24"
      fill="none"
      stroke={couleur}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Icone = {
  courriel: (p: Props) => (
    <Trait {...p}>
      <path d="M22 6 12 13 2 6" />
      <rect x="2" y="4" width="20" height="16" rx="2.5" />
    </Trait>
  ),
  plus: (p: Props) => (
    <Trait {...p}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Trait>
  ),
  horloge: (p: Props) => (
    <Trait {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Trait>
  ),
  reglages: (p: Props) => (
    <Trait {...p}>
      <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="17" r="2" />
    </Trait>
  ),
  personnes: (p: Props) => (
    <Trait {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.3a3.2 3.2 0 0 1 0 5.4M17.5 14.2A6.5 6.5 0 0 1 21.5 20" />
    </Trait>
  ),
  journal: (p: Props) => (
    <Trait {...p}>
      <path d="M6 3h9l5 5v13H6z" />
      <path d="M15 3v5h5M9 13h7M9 17h5" />
    </Trait>
  ),
  sortie: (p: Props) => (
    <Trait {...p}>
      <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </Trait>
  ),
  bouclier: (p: Props) => (
    <Trait {...p}>
      <path d="M12 2.7 4.5 6v5.4c0 4.6 3.1 8.4 7.5 9.9 4.4-1.5 7.5-5.3 7.5-9.9V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Trait>
  ),
  alerte: (p: Props) => (
    <Trait {...p}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 2.4 17.6a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </Trait>
  ),
  maison: (p: Props) => (
    <Trait {...p}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.5 20v-6h5v6" />
    </Trait>
  ),
  billets: (p: Props) => (
    <Trait {...p}>
      <rect x="2" y="6" width="20" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M5.5 9.5h.01M18.5 14.5h.01" />
    </Trait>
  ),
  personne: (p: Props) => (
    <Trait {...p}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </Trait>
  ),
  coffre: (p: Props) => (
    <Trait {...p}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H17v2.5" />
      <rect x="3" y="7.5" width="18" height="11.5" rx="2.5" />
      <path d="M21 11.5h-4a2 2 0 0 0 0 4h4" />
    </Trait>
  ),
  echange: (p: Props) => (
    <Trait {...p}>
      <path d="M4 8h13l-3.2-3.2" />
      <path d="M20 16H7l3.2 3.2" />
    </Trait>
  ),
  graphique: (p: Props) => (
    <Trait {...p}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="m7.5 15 3.5-4 3 2.5L20 7" />
    </Trait>
  ),
  calendrier: (p: Props) => (
    <Trait {...p}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Trait>
  ),
  menu: (p: Props) => (
    <Trait {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Trait>
  ),
  croix: (p: Props) => (
    <Trait {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Trait>
  ),
  chevron: (p: Props) => (
    <Trait {...p}>
      <path d="m9 6 6 6-6 6" />
    </Trait>
  ),
};

export type NomIcone = keyof typeof Icone;
