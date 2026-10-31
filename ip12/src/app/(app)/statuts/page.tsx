import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { STATUT_RESOLUTION, TITRES, noteDe, resolutionsDe } from "@/lib/statuts";
import { listerResolutions, statutsEnVigueur } from "@/lib/statuts-base";
import { importerStatuts } from "@/app/actions/statuts";
import { dateCourte } from "@/lib/settings";
import { Champ, FormulaireAction } from "@/components/formulaires";
import { Panneau } from "@/components/panneau";
import { EnTeteEcran, Vide } from "@/components/ui";
import { ListeStatuts, type ChapitreAffiche } from "@/components/statuts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Statuts" };

/**
 * CLUB › STATUTS : le texte signe, article par article, et les resolutions
 * qui le precisent. Le texte vient du PDF importe par le president : il n'est
 * pas dans le code (art. 5).
 */
export default async function PageStatuts() {
  const membre = await exigerMembre();
  const peutGerer = peut(membre, "gererStatuts");
  const [statuts, resolutions] = await Promise.all([statutsEnVigueur(), listerResolutions()]);

  const importer = peutGerer ? (
    <FormulaireAction action={importerStatuts} libelle="Importer les statuts">
      <Champ
        nom="statuts"
        libelle="PDF signé des statuts"
        type="file"
        accept="application/pdf"
        aide="Le site lit chaque article (« Art. 1 : … ») et garde le PDF. Une nouvelle version signée remplace la précédente."
      />
    </FormulaireAction>
  ) : null;

  if (!statuts) {
    return (
      <>
        <EnTeteEcran titre="Les statuts" detail="Le texte signé du club, article par article." />
        <Vide>
          Les statuts ne sont pas encore sur le site.{" "}
          {peutGerer ? "Importez le PDF signé ci-dessous." : "Le président doit d'abord importer le PDF signé."}
        </Vide>
        {importer && <div className="mt-5">{importer}</div>}
      </>
    );
  }

  const chapitres: ChapitreAffiche[] = [];
  for (const a of [...statuts.articles].sort((x, y) => x.numero - y.numero)) {
    const nom = a.chapitre || "Statuts";
    let c = chapitres.at(-1);
    if (!c || c.nom !== nom) {
      c = { nom, articles: [] };
      chapitres.push(c);
    }
    c.articles.push({
      numero: a.numero,
      titre: TITRES[a.numero] ?? `Article ${a.numero}`,
      texte: a.texte,
      note: noteDe(a),
      resolutions: resolutionsDe(a.numero, resolutions)
        .filter((r) => r.statut !== STATUT_RESOLUTION.remplacee)
        .map((r) => ({ code: r.code, titre: r.titre, aConfirmer: r.statut === STATUT_RESOLUTION.aConfirmer })),
    });
  }

  return (
    <>
      <EnTeteEcran
        titre="Les statuts"
        detail={`${statuts.articles.length} articles, signés par les membres fondateurs. Tout ce qui se dit ou se fait au club est confidentiel (art. 5).`}
      />
      <p className="-mt-2 mb-6 flex flex-wrap gap-2">
        <a
          href="/statuts/pdf"
          target="_blank"
          rel="noopener"
          className="tapable inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium no-underline"
          style={{ borderColor: "var(--line-2)", color: "var(--ink)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4 V15 M7 10.5 L12 15.5 L17 10.5 M5 19.5 H19" />
          </svg>
          PDF signé
        </a>
        <Link
          href="/statuts/resolutions"
          className="tapable inline-flex min-h-10 items-center rounded-lg border px-3 text-[13px] font-medium no-underline"
          style={{ borderColor: "var(--line-2)", color: "var(--ink)" }}
        >
          Résolutions ({resolutions.length})
        </Link>
      </p>

      <ListeStatuts chapitres={chapitres} />

      <p className="mt-6 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
        Texte du PDF signé, importé le {dateCourte(statuts.importeLe)}, sans retouche. Une modification des statuts passe
        par un vote ; sa résolution s&apos;affiche sous l&apos;article concerné.
      </p>
      {importer && (
        <div className="mt-4">
          <Panneau libelle="Importer une nouvelle version" titre="Nouvelle version des statuts" variante="secondaire">
            {importer}
          </Panneau>
        </div>
      )}
    </>
  );
}
