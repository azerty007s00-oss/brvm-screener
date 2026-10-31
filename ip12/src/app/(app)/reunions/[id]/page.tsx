import Link from "next/link";
import { notFound } from "next/navigation";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { donneesRapport } from "@/lib/rapport-donnees";
import { ordreDuJour, phraseRetard, rapportTexte, variationEnClair } from "@/lib/rapport-reunion";
import { jourEnClair } from "@/lib/calendrier-reunions";
import { dateCourte, fcfa } from "@/lib/settings";
import { envoyerOrdreDuJour } from "@/app/actions/rapport";
import { ChampCache, FormulaireAction } from "@/components/formulaires";
import { Carte } from "@/components/ui";
import { Voilable } from "@/components/voilable";
import { PartageWhatsApp, PointsOrdreDuJour } from "@/components/rapport";

export const dynamic = "force-dynamic";
export const metadata = { title: "Préparer la réunion" };

const premiereMajuscule = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Preparer une seance, puis en garder le rapport : les chiffres du club
 * depuis la precedente, l'ordre du jour que le site pose d'office, les
 * points du bureau, et le tout en PDF ou en texte pour WhatsApp.
 */
export default async function PagePreparerReunion({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const membre = await exigerMembre();
  const rapport = /^[0-9a-f-]{36}$/i.test(id) ? await donneesRapport(id) : null;
  if (!rapport) notFound();
  const { donnees: d, reunion } = rapport;
  const gere = peut(membre, "gererReunions");
  const passee = d.date < new Date().toISOString().slice(0, 10);
  const discret = { color: "var(--ink-2)" };

  const tuiles: { libelle: string; valeur: React.ReactNode; detail: string }[] = [];
  if (d.portefeuille) {
    tuiles.push({
      libelle: "Portefeuille",
      valeur: d.portefeuille.variation !== null ? variationEnClair(d.portefeuille.variation) : <Voilable>{fcfa(d.portefeuille.valeur)}</Voilable>,
      detail: d.portefeuille.variation !== null ? `sur la période, relevé du ${dateCourte(d.portefeuille.dateValeur)}` : `relevé du ${dateCourte(d.portefeuille.dateValeur)}`,
    });
  }
  tuiles.push({ libelle: "Versements reçus", valeur: <Voilable>{fcfa(d.encaisse)}</Voilable>, detail: "validés sur la période, avances comprises" });
  tuiles.push({
    libelle: "À jour",
    valeur: `${d.aJour.n} / ${d.aJour.total}`,
    detail: d.retards.length === 0 ? "personne en retard" : `${d.retards.length} en retard`,
  });
  if (d.objectif) tuiles.push({ libelle: "Objectif", valeur: `${Math.round(d.objectif.taux * 100)} %`, detail: d.objectif.intitule });

  return (
    <>
      <p className="text-[13px]">
        <Link href="/reunions" className="underline" style={{ color: "var(--accent)" }}>
          Réunions
        </Link>
      </p>
      <section className="flex flex-col gap-1.5">
        <p className="text-[13px]" style={discret}>
          {reunion.titre ?? "Séance"} du {jourEnClair(d.date)}
          {d.heure && ` à ${d.heure} GMT, heure d'Abidjan`}
          {d.lieu && `, ${d.lieu}`}
        </p>
        <h1 className="text-[23px] font-semibold leading-tight">
          {d.depuis ? `Depuis la réunion du ${dateCourte(d.depuis)}` : premiereMajuscule(passee ? "Rapport de la réunion" : "Préparer la réunion")}
        </h1>
        <p className="text-[14px] leading-relaxed" style={discret}>
          {passee
            ? "Le rapport de la séance, chiffres arrêtés au jour de la réunion."
            : gere
              ? "Le site a tout préparé : relisez, ajoutez vos points, puis envoyez l'ordre du jour ou le rapport."
              : "L'ordre du jour et les chiffres du club depuis la dernière réunion."}
        </p>
      </section>

      <ul className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {tuiles.map((t) => (
          <li key={t.libelle} className="rounded-xl border p-3.5" style={{ borderColor: "var(--line-2)" }}>
            <p className="text-[12.5px]" style={discret}>{t.libelle}</p>
            <p className="mt-1 text-[21px] font-semibold tabular-nums">{t.valeur}</p>
            <p className="mt-0.5 text-[12px] leading-snug" style={{ color: "var(--ink-3)" }}>{t.detail}</p>
          </li>
        ))}
      </ul>

      <Carte titre="À l'ordre du jour, d'office">
        <ul>
          {d.retards.map((r) => (
            <li key={r.nom} className="border-t py-2.5" style={{ borderColor: "var(--line)" }}>
              <p className="text-[14px] font-medium">Retard de {r.nom}</p>
              <p className="mt-0.5 text-[13px] leading-snug" style={discret}>{phraseRetard(r)}</p>
            </li>
          ))}
          {d.votes.map((v, i) => (
            <li key={`${i}-${v.question}`} className="border-t py-2.5" style={{ borderColor: "var(--line)" }}>
              <p className="text-[14px] font-medium">Vote : {v.question}</p>
              <p className="mt-0.5 text-[13px] leading-snug" style={discret}>{premiereMajuscule(v.etat)}.</p>
            </li>
          ))}
          <li className="border-t py-2.5" style={{ borderColor: "var(--line)" }}>
            <p className="text-[14px] font-medium">Pénalités</p>
            <p className="mt-0.5 text-[13px] leading-snug" style={discret}>
              <Voilable>{fcfa(d.penalites.inscrites)}</Voilable> inscrites sur la période, <Voilable>{fcfa(d.penalites.reglees)}</Voilable> réglées
              {d.penalites.absences > 0 ? `, dont ${d.penalites.absences} ${d.penalites.absences > 1 ? "absences" : "absence"}` : ""}.
            </p>
          </li>
          <li className="border-t py-2.5" style={{ borderColor: "var(--line)" }}>
            <p className="text-[14px] font-medium">Caisse</p>
            <p className="mt-0.5 text-[13px] leading-snug" style={discret}>
              {d.caisse.mouvements.length === 0
                ? "Aucun mouvement sur la période."
                : d.caisse.mouvements.map((m) => `${m.depense ? "Dépense" : "Recette"} de ${fcfa(m.montant)} (${m.libelle})`).join(" · ")}
              {d.caisse.solde !== null && (
                <>
                  {" "}Solde : <Voilable>{fcfa(d.caisse.solde)}</Voilable>.
                </>
              )}
            </p>
          </li>
        </ul>
      </Carte>

      <Carte titre={gere ? "Vos points" : "Ordre du jour"}>
        {gere ? (
          <PointsOrdreDuJour reunionId={reunion.id} points={d.points} />
        ) : (
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[14px]">
            {ordreDuJour(d).map((p, i) => (
              <li key={`${i}-${p}`}>{p}</li>
            ))}
          </ol>
        )}
      </Carte>

      <Carte titre="Partager">
        <div className="flex flex-col gap-2.5">
          {gere && !passee && (
            <FormulaireAction action={envoyerOrdreDuJour} libelle="Envoyer l'ordre du jour à tous" className="-mt-4">
              <ChampCache nom="reunionId" valeur={reunion.id} />
            </FormulaireAction>
          )}
          <a
            href={`/reunions/${reunion.id}/rapport`}
            target="_blank"
            rel="noopener"
            className="tapable inline-flex h-11 items-center justify-center rounded-lg px-4 text-[14px] font-medium lg:h-9"
            style={{ background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" }}
          >
            Rapport en PDF
          </a>
          <PartageWhatsApp texte={rapportTexte(d)} />
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            L&apos;ordre du jour part par courriel, rapport joint, et par alerte. Le rapport se télécharge aussi après la réunion,
            avec la feuille de présence une fois saisie.
          </p>
        </div>
      </Carte>
    </>
  );
}
