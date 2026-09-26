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
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
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
  chevron: (p: Props) => (
    <Trait {...p}>
      <path d="m9 6 6 6-6 6" />
    </Trait>
  ),
};

export type NomIcone = keyof typeof Icone;
