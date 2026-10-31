import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { NOMS } from "@/lib/bourse";
import { etatBourse, pointsDuSoir } from "@/lib/bourse-base";
import { importerReleveSgi, inscrireMouvement, retirerMouvement } from "@/app/actions/bourse";
import { couleurSigne, pourcent } from "@/lib/perf";
import { dateCourte, nombre } from "@/lib/settings";
import { Champ, ChampCache, FormulaireAction, Selection } from "@/components/formulaires";
import { Carte, Vide } from "@/components/ui";
import { Panneau } from "@/components/panneau";
import { MenuLigne } from "@/components/menu-ligne";
import { Voilable } from "@/components/voilable";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bourse" };

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const jourMois = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Les deux courbes, base 100 au 1er janvier. Le club n'a de points que depuis
 * le premier soir suivi ; avant, la courbe part droit du 1er janvier.
 */
function Courbes({ annee, points }: { annee: number; points: { date: string; club: number | null; indice: number | null }[] }) {
  const L = 350;
  const H = 150;
  const debut = Date.UTC(annee, 0, 1);
  const dernier = points.at(-1)?.date ?? `${annee}-01-01`;
  const fin = Math.max(Date.UTC(annee, 0, 2), new Date(`${dernier}T00:00:00Z`).getTime());
  const serie = (cle: "club" | "indice") => [
    { t: debut, v: 100 },
    ...points.filter((p) => p[cle] !== null).map((p) => ({ t: new Date(`${p.date}T00:00:00Z`).getTime(), v: 100 * (1 + p[cle]!) })),
  ];
  const club = serie("club");
  const indice = serie("indice");
  const valeurs = [...club, ...indice].map((p) => p.v);
  const bas = Math.floor(Math.min(95, ...valeurs) / 5) * 5;
  const haut = Math.ceil(Math.max(105, ...valeurs) / 5) * 5;
  const x = (t: number) => 24 + ((t - debut) / (fin - debut)) * (L - 34);
  const y = (v: number) => 10 + ((haut - v) / (haut - bas)) * 110;
  const trace = (s: { t: number; v: number }[]) => s.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const graduations = [bas, (bas + haut) / 2, haut];
  const moisFin = new Date(fin).getUTCMonth();
  const finClub = club.at(-1)!.v;
  const finIndice = indice.at(-1)!.v;
  return (
    <svg
      viewBox={`0 0 ${L} ${H}`}
      role="img"
      aria-label={`Courbes base 100 au 1er janvier : le club est à ${Math.round(finClub)}, la BRVM Composite à ${Math.round(finIndice)}`}
      className="h-auto w-full"
    >
      {graduations.map((g) => (
        <g key={g}>
          <line x1="0" x2={L} y1={y(g)} y2={y(g)} style={{ stroke: "var(--line)", strokeWidth: 1 }} />
          <text x="0" y={y(g) - 4} style={{ fontSize: 10, fill: "var(--ink-3)" }}>
            {Number.isInteger(g) ? g : g.toFixed(1).replace(".", ",")}
          </text>
        </g>
      ))}
      <polyline
        points={trace(indice)}
        style={{ fill: "none", stroke: "var(--gold-ink)", strokeWidth: 2, strokeDasharray: "5 4", strokeLinejoin: "round" }}
      />
      <polyline
        points={trace(club)}
        style={{ fill: "none", stroke: "var(--accent)", strokeWidth: 2.5, strokeLinejoin: "round", strokeLinecap: "round" }}
      />
      <text x="24" y="142" style={{ fontSize: 10, fill: "var(--ink-3)" }}>janv.</text>
      {moisFin > 1 && (
        <text x={L - 4} y="142" textAnchor="end" style={{ fontSize: 10, fill: "var(--ink-3)" }}>
          {MOIS_COURTS[moisFin]}
        </text>
      )}
    </svg>
  );
}

export default async function PageBourse() {
  const membre = await exigerMembre();
  const peutSaisir = peut(membre, "gererCompteTitres");
  const maintenant = new Date();
  const annee = maintenant.getUTCFullYear();
  const [etat, points] = await Promise.all([etatBourse(maintenant), pointsDuSoir(annee)]);

  const symboles = [...new Set([...(etat.seance?.cours ?? []).map((c) => c.symbole), ...Object.keys(NOMS)])].sort();

  const importer = peutSaisir ? (
    <FormulaireAction action={importerReleveSgi} libelle="Lire le relevé">
      <Champ
        nom="releve"
        libelle="Relevé PDF de la SGI"
        type="file"
        accept="application/pdf"
        aide="Le PDF tel que la SGI l'envoie. Le site en lit les titres, les quantités, les prix moyens et les liquidités."
      />
    </FormulaireAction>
  ) : null;

  if (!etat.releve) {
    return (
      <>
        <header className="mb-6">
          <h1 className="text-[22px] font-semibold" style={{ color: "var(--ink)" }}>Bourse</h1>
        </header>
        <Carte titre="Point de départ">
          <Vide>
            Le portefeuille se calcule à partir du dernier relevé de la SGI.{" "}
            {peutSaisir ? "Importez-le ci-dessous pour commencer." : "Le bureau doit d'abord l'importer."}
          </Vide>
          {importer && <div className="mt-4">{importer}</div>}
        </Carte>
      </>
    );
  }

  const ecart = etat.clubAnnee !== null && etat.indiceAnnee !== null ? (etat.clubAnnee - etat.indiceAnnee) * 100 : null;
  const dividendesTotal = etat.dividendes.reduce((t, d) => t + d.montant, 0);
  const dividendesDetail = [...etat.dividendes]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => `${d.symbole} en ${MOIS[Number(d.date.slice(5, 7)) - 1]}`)
    .join(", ");
  const courbe = points.map((p) => ({ date: p.date, club: p.clubAnnee, indice: p.indiceAnnee }));
  if (courbe.length === 0 || courbe.at(-1)!.date < etat.dateCours) {
    courbe.push({ date: etat.dateCours, club: etat.clubAnnee, indice: etat.indiceAnnee });
  }
  const suivisDepuis = points[0]?.date ?? null;

  return (
    <>
      <section className="mb-8">
        <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
          Valeur du portefeuille ce soir, {jourMois(etat.dateCours)}
        </p>
        <p className="mt-1 flex items-baseline whitespace-nowrap">
          <span className="text-[44px] leading-none font-medium tracking-[-0.02em] tabular-nums">
            <Voilable>{nombre(etat.total)}</Voilable>
          </span>
          <span className="ml-2.5 text-[16px]" style={{ color: "var(--ink-3)" }}>FCFA</span>
        </p>
        <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Cours de clôture de la BRVM, mis à jour chaque soir. Dernier relevé SGI :{" "}
          <Voilable>{nombre(etat.releve.total ?? 0)}</Voilable> FCFA au {jourMois(etat.releve.date)}.
        </p>
        <p className="mt-1 text-[13px] tabular-nums" style={{ color: "var(--ink-3)" }}>
          Titres <Voilable>{nombre(etat.titres)}</Voilable> · Liquidités <Voilable>{nombre(etat.liquidites)}</Voilable>
        </p>
      </section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
        <section className="flex flex-col gap-3 rounded-xl border p-3.5" style={{ borderColor: "var(--line-2)" }}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Le club face à la BRVM</h2>
            <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>depuis le 1er janvier</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                <span className="h-[3px] w-3.5 rounded-sm" style={{ background: "var(--accent)" }} />
                Le club
              </p>
              <p className="mt-1 text-[22px] font-medium tabular-nums" style={{ color: couleurSigne(etat.clubAnnee) }}>
                {pourcent(etat.clubAnnee)}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                <span className="w-3.5 border-t-2 border-dashed" style={{ borderColor: "var(--gold-ink)" }} />
                BRVM Composite
              </p>
              <p className="mt-1 text-[22px] font-medium tabular-nums" style={{ color: couleurSigne(etat.indiceAnnee) }}>
                {pourcent(etat.indiceAnnee)}
              </p>
            </div>
          </div>
          <Courbes annee={annee} points={courbe} />
          <p className="text-[13px] leading-[1.45]" style={{ color: "var(--ink-2)" }}>
            {ecart !== null && Math.abs(ecart) >= 0.05 ? (
              <>
                Le club fait{" "}
                <b style={{ color: "var(--ink)" }}>
                  {Math.abs(ecart).toFixed(1).replace(".", ",")} point{Math.abs(ecart) >= 2 ? "s" : ""} de{" "}
                  {ecart > 0 ? "mieux" : "moins"}
                </b>{" "}
                que la bourse cette année.{" "}
              </>
            ) : ecart !== null ? (
              <>Le club fait jeu égal avec la bourse cette année. </>
            ) : null}
            Base 100 au 1er janvier, apports de l&apos;année retirés pour ne comparer que la gestion.
            {etat.depart && etat.depart.date !== `${annee}-01-01` && (
              <> Départ du club : le relevé du {dateCourte(etat.depart.date)}.</>
            )}
            {suivisDepuis && <> Points du soir depuis le {jourMois(suivisDepuis)}.</>}
          </p>
        </section>

        <section>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Les titres du club</h2>
            <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>cours du {jourMois(etat.dateCours)}</span>
          </div>
          <ul className="mt-2">
            {etat.positions.map((t) => (
              <li key={t.symbole} className="flex items-center gap-3 py-[11px]" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="w-[46px] flex-none text-[12.5px] font-bold tracking-[0.03em]" style={{ color: "var(--accent)" }}>
                  {t.symbole}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{NOMS[t.symbole] ?? t.nom}</span>
                  <span className="mt-0.5 block text-[12px] tabular-nums" style={{ color: "var(--ink-3)" }}>
                    {nombre(t.quantite)} × {nombre(t.cours)}
                    <span className="ml-2" style={{ color: couleurSigne(t.plusValue) }}>
                      <Voilable>
                        {t.plusValue >= 0 ? "+" : "−"}
                        {nombre(Math.abs(t.plusValue))}
                      </Voilable>
                    </span>
                  </span>
                </span>
                <span className="flex-none text-right">
                  <span className="block text-[14px] font-semibold tabular-nums">
                    <Voilable>{nombre(t.valeur)}</Voilable>
                  </span>
                  <span className="mt-0.5 block text-[12px] font-semibold tabular-nums" style={{ color: couleurSigne(t.variation) }}>
                    {t.variation === null ? "" : pourcent(t.variation, 2)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            Sous chaque titre : quantité × cours, puis la plus-value sur le prix moyen d&apos;achat.
          </p>
        </section>
      </div>

      <section className="mt-8 flex justify-between gap-3 rounded-[10px] px-3.5 py-3" style={{ background: "var(--sunk)" }}>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">Dividendes encaissés en {annee}</p>
          <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {dividendesDetail || "Aucun inscrit pour l'instant."}
          </p>
        </div>
        <p className="whitespace-nowrap tabular-nums">
          <span className="text-[17px] font-semibold"><Voilable>{nombre(dividendesTotal)}</Voilable></span>
          <span className="ml-1 text-[12px]" style={{ color: "var(--ink-2)" }}>FCFA</span>
        </p>
      </section>

      {peutSaisir && (
        <section className="mt-6 flex flex-col gap-2">
          <Panneau
            libelle="Inscrire un achat, une vente ou un dividende"
            titre="Inscrire un mouvement"
            variante="secondaire"
            introduction="Les frais de courtage de l'ordre vont avec l'achat ou la vente, pas en mouvement de compte-titres : ils ne doivent compter qu'une fois."
          >
            <FormulaireAction action={inscrireMouvement} libelle="Inscrire">
              <Champ nom="date" libelle="Date de l'opération" type="date" valeur={maintenant.toISOString().slice(0, 10)} />
              <Selection
                nom="nature"
                libelle="Nature"
                options={[
                  { valeur: "achat", libelle: "Achat" },
                  { valeur: "vente", libelle: "Vente" },
                  { valeur: "dividende", libelle: "Dividende" },
                ]}
              />
              <Selection
                nom="symbole"
                libelle="Titre"
                options={symboles.map((s) => ({ valeur: s, libelle: NOMS[s] ? `${s} · ${NOMS[s]}` : s }))}
              />
              <Champ nom="quantite" libelle="Quantité" type="number" min={0} requis={false} aide="Achat ou vente." />
              <Champ nom="prix" libelle="Prix unitaire (FCFA)" type="number" min={0} step="any" requis={false} aide="Achat ou vente." />
              <Champ nom="frais" libelle="Frais de l'ordre (FCFA)" type="number" min={0} step="any" valeur={0} requis={false} />
              <Champ nom="montant" libelle="Dividende net reçu (FCFA)" type="number" min={0} step="any" requis={false} aide="Dividende seulement." />
              <Champ nom="note" libelle="Note (facultatif)" requis={false} />
            </FormulaireAction>
          </Panneau>
          <Panneau libelle="Importer un nouveau relevé SGI" titre="Nouveau relevé SGI" variante="secondaire">
            {importer}
          </Panneau>
          <p className="text-[12.5px] leading-normal" style={{ color: "var(--ink-3)" }}>
            Les cours et l&apos;indice se lisent seuls chaque soir sur brvm.org. Le bureau n&apos;inscrit que ce que seul
            le club sait : ses achats, ses ventes et ses dividendes. Le relevé de la SGI sert de contrôle : chaque
            nouveau relevé importé devient le point de départ.
          </p>
        </section>
      )}

      {etat.mouvements.length > 0 && (
        <Carte titre="Mouvements inscrits" className="mt-8">
          <ul>
            {etat.mouvements.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2 text-[13.5px]" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="w-20 flex-none tabular-nums">{dateCourte(m.date)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {m.nature === "achat" ? "Achat" : m.nature === "vente" ? "Vente" : "Dividende"} {m.symbole}
                  {m.nature !== "dividende" && (
                    <span style={{ color: "var(--ink-3)" }}>
                      {" "}
                      {nombre(m.quantite)} × {nombre(m.prix)}
                    </span>
                  )}
                  {m.date <= etat.releve.date && (
                    <span className="ml-1.5 text-[12px]" style={{ color: "var(--ink-3)" }}>(dans le relevé)</span>
                  )}
                </span>
                <span className="text-right tabular-nums">
                  <Voilable>
                    {nombre(m.nature === "achat" ? m.quantite * m.prix + m.frais : m.nature === "vente" ? m.quantite * m.prix - m.frais : m.montant)}
                  </Voilable>
                </span>
                {peutSaisir && (
                  <MenuLigne
                    etiquette={`Actions sur le mouvement du ${dateCourte(m.date)}`}
                    actions={[
                      {
                        libelle: "Supprimer ce mouvement",
                        action: retirerMouvement,
                        champs: <ChampCache nom="id" valeur={m.id} />,
                        confirmation: `Supprimer ce mouvement du ${dateCourte(m.date)} ?`,
                        confirmer: "Supprimer",
                      },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        </Carte>
      )}
    </>
  );
}
