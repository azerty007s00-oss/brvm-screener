"use server";

import { revalidatePath } from "next/cache";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { STATUT_RESOLUTION, lireRecensement, type Resolution, type StatutResolution } from "@/lib/statuts";
import { enregistrerResolutions, enregistrerStatuts, lireStatutsPdf, supprimerResolution } from "@/lib/statuts-base";
import type { EtatFormulaire } from "./auth";

/** Le PDF signe des statuts : le site en lit les articles et le garde. Il remplace la version precedente. */
export async function importerStatuts(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererStatuts");
  const fichier = donnees.get("statuts");
  if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, erreur: "Choisissez le PDF des statuts." };
  if (fichier.size > 5_000_000) return { ok: false, erreur: "Ce fichier dépasse 5 Mo." };
  const octets = new Uint8Array(await fichier.arrayBuffer());
  /* Une copie a la lecture : pdf.js garde le tampon qu'on lui donne, et le PDF a conserver serait vide. */
  const articles = await lireStatutsPdf(octets.slice()).catch(() => null);
  if (!articles) return { ok: false, erreur: "Aucun article lu : ce PDF n'a pas la forme des statuts (« Art. 1 : … »)." };
  await enregistrerStatuts(fichier.name, octets, articles, auteur.id);
  await journaliser({ id: auteur.id, nom: auteur.nom }, "import_statuts", { entite: "club_statutes" }, {
    fichier: fichier.name,
    articles: articles.length,
  });
  revalidatePath("/statuts", "layout");
  return { ok: true, message: `Statuts importés : ${articles.length} articles.` };
}

/** Un recensement des resolutions en Markdown : ses lignes codees (S1, R4) s'inscrivent ou se remplacent. */
export async function importerResolutions(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererStatuts");
  const fichier = donnees.get("recensement");
  if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, erreur: "Choisissez le fichier du recensement." };
  if (fichier.size > 1_000_000) return { ok: false, erreur: "Ce fichier dépasse 1 Mo." };
  const resolutions = lireRecensement(await fichier.text());
  if (resolutions.length === 0) return { ok: false, erreur: "Aucune résolution lue : il faut un tableau dont la première colonne porte le code (S1, R4)." };
  await enregistrerResolutions(resolutions, auteur.id);
  await journaliser({ id: auteur.id, nom: auteur.nom }, "import_resolutions", { entite: "club_resolutions" }, {
    codes: resolutions.map((r) => r.code),
  });
  revalidatePath("/statuts", "layout");
  return { ok: true, message: `${resolutions.length} résolutions inscrites.` };
}

const STATUTS: StatutResolution[] = [STATUT_RESOLUTION.adoptee, STATUT_RESOLUTION.aConfirmer, STATUT_RESOLUTION.remplacee];

/** Une resolution saisie a la main ; un code deja inscrit est remplace. */
export async function inscrireResolution(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererStatuts");
  const texte = (cle: string) => String(donnees.get(cle) ?? "").trim();
  const code = texte("code").toUpperCase();
  const decideeLe = texte("date").slice(0, 10);
  const statut = texte("statut") as StatutResolution;
  if (!/^[A-Z]\d{1,2}$/.test(code)) return { ok: false, erreur: "Le code est une lettre suivie d'un numéro : S9, R6." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decideeLe)) return { ok: false, erreur: "Date invalide." };
  if (!texte("titre")) return { ok: false, erreur: "Donnez un titre à la résolution." };
  if (!STATUTS.includes(statut)) return { ok: false, erreur: "Statut inconnu." };
  const r: Resolution = {
    code,
    decideeLe,
    quand: `${decideeLe.slice(8, 10)}/${decideeLe.slice(5, 7)}/${decideeLe.slice(0, 4)}`,
    titre: texte("titre"),
    detail: texte("detail"),
    vote: texte("vote"),
    articles: [...texte("articles").matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= 99),
    statut,
    precision: texte("precision") || null,
  };
  await enregistrerResolutions([r], auteur.id);
  await journaliser({ id: auteur.id, nom: auteur.nom }, "resolution", { entite: "club_resolutions", id: code }, r);
  revalidatePath("/statuts", "layout");
  return { ok: true, message: `Résolution ${code} inscrite.` };
}

export async function retirerResolution(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererStatuts");
  const code = String(donnees.get("code") ?? "");
  if (!(await supprimerResolution(code))) return { ok: false, erreur: "Résolution introuvable." };
  await journaliser({ id: auteur.id, nom: auteur.nom }, "suppression_resolution", { entite: "club_resolutions", id: code });
  revalidatePath("/statuts", "layout");
  return { ok: true, message: `Résolution ${code} retirée.` };
}
