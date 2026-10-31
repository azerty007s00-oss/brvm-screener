"use server";

import { revalidatePath } from "next/cache";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { lireReleve, type NatureMouvement } from "@/lib/bourse";
import { ajouterMouvement, corrigerDividende, derniereSeance, importerReleve, lignesDuPdf, supprimerMouvement } from "@/lib/bourse-base";
import { dateCourte, fcfa } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

/**
 * Le releve PDF de la SGI, tel que telecharge : le site en lit les titres,
 * les quantites, les prix moyens et les liquidites. Il devient le point de
 * depart du portefeuille, et un releve de la page Portefeuille.
 */
export async function importerReleveSgi(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("importerReleveSgi");
  const fichier = donnees.get("releve");
  if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, erreur: "Choisissez le relevé PDF de la SGI." };
  if (fichier.size > 5_000_000) return { ok: false, erreur: "Ce fichier dépasse 5 Mo : est-ce bien le relevé ?" };

  let lignes: string[][];
  try {
    lignes = await lignesDuPdf(new Uint8Array(await fichier.arrayBuffer()));
  } catch {
    return { ok: false, erreur: "Ce fichier ne se lit pas comme un PDF." };
  }
  const seance = await derniereSeance();
  const releve = lireReleve(lignes, seance?.cours ?? []);
  if (!releve.date || releve.lignes.length === 0) {
    return { ok: false, erreur: "Aucun titre lu : ce PDF n'a pas la forme du relevé de la SGI." };
  }
  const inconnus = releve.lignes.filter((l) => !l.symbole).map((l) => l.nom);
  if (inconnus.length > 0) {
    return { ok: false, erreur: `Titres non reconnus : ${inconnus.join(", ")}. Rien n'est importé.` };
  }
  const titres = releve.lignes.reduce((t, l) => t + l.valeur, 0);
  if (releve.total !== null && Math.abs(titres + releve.liquidites - releve.total) > 5) {
    return { ok: false, erreur: "Les lignes lues ne retombent pas sur le total du relevé. Rien n'est importé." };
  }

  const { remplace } = await importerReleve({ ...releve, date: releve.date }, auteur.id);
  await journaliser({ id: auteur.id, nom: auteur.nom }, "import_releve_sgi", { entite: "sgi_statements" }, {
    date: releve.date,
    titres: releve.lignes.length,
    liquidites: releve.liquidites,
    total: releve.total,
    remplace,
  });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Relevé du ${dateCourte(releve.date)} ${remplace ? "remplacé" : "importé"} : ${releve.lignes.length} titres, ${fcfa(Math.round(releve.total ?? titres + releve.liquidites))}.`,
  };
}

const NATURES: NatureMouvement[] = ["achat", "vente", "dividende"];

export async function inscrireMouvement(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererCompteTitres");
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  const nature = String(donnees.get("nature") ?? "") as NatureMouvement;
  const symbole = String(donnees.get("symbole") ?? "").trim().toUpperCase();
  const nombre = (cle: string) => Number(String(donnees.get(cle) ?? "0").replace(/\s/g, "").replace(",", ".") || 0);
  const quantite = nombre("quantite");
  const prix = nombre("prix");
  const frais = nombre("frais");
  const montant = nombre("montant");
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, erreur: "Date invalide." };
  if (date > new Date().toISOString().slice(0, 10)) return { ok: false, erreur: "Cette date est dans le futur : inscrivez l'opération une fois faite." };
  if (!NATURES.includes(nature)) return { ok: false, erreur: "Choisissez achat, vente ou dividende." };
  if (!/^[A-Z]{3,6}$/.test(symbole)) return { ok: false, erreur: "Choisissez le titre." };
  if (![quantite, prix, frais, montant].every((n) => Number.isFinite(n) && n >= 0)) {
    return { ok: false, erreur: "Les montants doivent être des nombres positifs." };
  }
  if (nature === "dividende" ? montant <= 0 : quantite <= 0 || prix <= 0) {
    return {
      ok: false,
      erreur: nature === "dividende" ? "Indiquez le montant net reçu." : "Indiquez la quantité et le prix unitaire.",
    };
  }

  await ajouterMouvement(
    {
      date,
      nature,
      symbole,
      quantite: nature === "dividende" ? 0 : quantite,
      prix: nature === "dividende" ? 0 : prix,
      frais: nature === "dividende" ? 0 : frais,
      montant: nature === "dividende" ? montant : 0,
      note,
    },
    auteur.id,
  );
  await journaliser({ id: auteur.id, nom: auteur.nom }, "mouvement_bourse", { entite: "stock_movements" }, {
    date, nature, symbole, quantite, prix, frais, montant,
  });
  revalidatePath("/", "layout");
  const libelle = nature === "achat" ? "Achat inscrit" : nature === "vente" ? "Vente inscrite" : "Dividende inscrit";
  return { ok: true, message: `${libelle} : le portefeuille est recalculé.` };
}

export async function retirerMouvement(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererCompteTitres");
  const id = String(donnees.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, erreur: "Mouvement introuvable." };
  const efface = await supprimerMouvement(id);
  if (!efface) return { ok: false, erreur: "Mouvement introuvable." };
  await journaliser({ id: auteur.id, nom: auteur.nom }, "suppression_mouvement_bourse", { entite: "stock_movements", id }, efface);
  revalidatePath("/", "layout");
  return { ok: true, message: "Mouvement supprimé." };
}

/** Le net d'un dividende, tel que la SGI l'a reellement verse. */
export async function corrigerMontantDividende(_p: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererCompteTitres");
  const id = String(donnees.get("id") ?? "");
  const montant = Number(String(donnees.get("montant") ?? "").replace(/\s/g, "").replace(",", "."));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, erreur: "Dividende introuvable." };
  if (!Number.isFinite(montant) || montant <= 0) return { ok: false, erreur: "Indiquez le montant net reçu." };
  const corrige = await corrigerDividende(id, Math.round(montant));
  if (!corrige) return { ok: false, erreur: "Dividende introuvable." };
  await journaliser({ id: auteur.id, nom: auteur.nom }, "correction_dividende", { entite: "stock_movements", id }, corrige);
  revalidatePath("/", "layout");
  return { ok: true, message: `Dividende corrigé : ${fcfa(Math.round(montant))}.` };
}
