"use client";

import { useRef, useState } from "react";

const MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const TAILLE_MAX = 3 * 1024 * 1024;
/** Cote le plus long apres reduction : lisible a l'ecran, leger a l'envoi. */
const COTE_MAX = 1600;

type Etat = { nom: string; taille: number; origine: number } | null;

const enKo = (o: number) => `${Math.max(1, Math.round(o / 1024))} Ko`;

/**
 * Champ de justificatif : photo du recu, capture du transfert, ou bordereau PDF.
 *
 * Les images sont reduites dans le navigateur avant l'envoi -- une photo de
 * telephone pese plusieurs megaoctets, dont aucun n'est utile pour lire un recu,
 * et la connexion depuis Abidjan n'a pas a les porter. Les PDF partent tels quels.
 */
export function ChampJustificatif() {
  const [etat, setEtat] = useState<Etat>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const b64Ref = useRef<HTMLInputElement>(null);
  const nomRef = useRef<HTMLInputElement>(null);
  const mimeRef = useRef<HTMLInputElement>(null);

  async function choisir(fichier: File | undefined) {
    setErreur(null);
    if (!fichier) {
      setEtat(null);
      if (b64Ref.current) b64Ref.current.value = "";
      return;
    }
    if (!MIMES.includes(fichier.type)) {
      setErreur("Formats acceptes : photo (JPEG, PNG, WebP) ou PDF.");
      return;
    }

    setEnCours(true);
    try {
      const { b64, mime, taille } =
        fichier.type === "application/pdf"
          ? { b64: await enBase64(fichier), mime: fichier.type, taille: fichier.size }
          : await reduireImage(fichier);

      if (taille > TAILLE_MAX) {
        setErreur(`Fichier trop lourd (${enKo(taille)}). Maximum 3 Mo.`);
        setEnCours(false);
        return;
      }

      if (b64Ref.current) b64Ref.current.value = b64;
      if (nomRef.current) nomRef.current.value = fichier.name;
      if (mimeRef.current) mimeRef.current.value = mime;
      setEtat({ nom: fichier.name, taille, origine: fichier.size });
    } catch {
      setErreur("Lecture du fichier impossible.");
    }
    setEnCours(false);
  }

  return (
    <label className="mt-3 block">
      <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--discret)" }}>
        Justificatif (facultatif)
      </span>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(e) => choisir(e.target.files?.[0])}
        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:px-3 file:py-1 file:text-xs"
        style={{ background: "var(--fond)", borderColor: "var(--bordure)", color: "var(--texte)" }}
      />
      <input type="hidden" name="justificatif_b64" ref={b64Ref} />
      <input type="hidden" name="justificatif_nom" ref={nomRef} />
      <input type="hidden" name="justificatif_mime" ref={mimeRef} />

      {enCours && (
        <span className="mt-1 block text-xs" style={{ color: "var(--discret)" }}>
          Preparation du fichier…
        </span>
      )}
      {erreur && (
        <span className="mt-1 block text-xs" style={{ color: "var(--color-rouge-600)" }}>
          {erreur}
        </span>
      )}
      {etat && !erreur && (
        <span className="mt-1 block text-xs" style={{ color: "var(--color-vert-600)" }}>
          {etat.nom} — {enKo(etat.taille)}
          {etat.origine > etat.taille * 1.2 && ` (reduit depuis ${enKo(etat.origine)})`}
        </span>
      )}
      <span className="mt-1 block text-xs" style={{ color: "var(--discret)" }}>
        Photo du recu, capture du transfert mobile money, ou bordereau. Visible de tous les membres.
      </span>
    </label>
  );
}

function enBase64(fichier: File): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resoudre(String(lecteur.result).split(",")[1] ?? "");
    lecteur.onerror = () => rejeter(new Error("lecture impossible"));
    lecteur.readAsDataURL(fichier);
  });
}

async function reduireImage(fichier: File): Promise<{ b64: string; mime: string; taille: number }> {
  const source = await creerImage(URL.createObjectURL(fichier));
  const echelle = Math.min(1, COTE_MAX / Math.max(source.width, source.height));
  const toile = document.createElement("canvas");
  toile.width = Math.round(source.width * echelle);
  toile.height = Math.round(source.height * echelle);
  const contexte = toile.getContext("2d");
  if (!contexte) throw new Error("canvas indisponible");
  contexte.drawImage(source, 0, 0, toile.width, toile.height);
  URL.revokeObjectURL(source.src);

  const donnees = toile.toDataURL("image/jpeg", 0.75);
  const b64 = donnees.split(",")[1] ?? "";
  const remplissage = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return { b64, mime: "image/jpeg", taille: Math.floor((b64.length * 3) / 4) - remplissage };
}

function creerImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resoudre, rejeter) => {
    const image = new Image();
    image.onload = () => resoudre(image);
    image.onerror = () => rejeter(new Error("image illisible"));
    image.src = url;
  });
}
