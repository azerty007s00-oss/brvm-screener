import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { faitsDuMembre } from "@/lib/historique";
import { filDuMembre, parMois, type Famille, type Genre } from "@/lib/fil";
import { fcfa, moisLong } from "@/lib/settings";
import { EnTeteEcran, Vide } from "@/components/ui";
import { avecMontants } from "@/components/voilable";
import { EcranInitialisation, estTableAbsente } from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Historique" };

const FILTRES: { cle: Famille | null; libelle: string }[] = [
  { cle: null, libelle: "Tout" },
  { cle: "versements", libelle: "Versements" },
  { cle: "penalites", libelle: "Pénalités" },
  { cle: "rappels", libelle: "Rappels" },
];

/** Trois mois d'abord ; « voir plus » en ajoute trois. */
const PAS = 3;

/* Un trait par genre : le sort d'un geste se lit avant son texte. */
const TRACES: Record<Genre, React.ReactNode> = {
  ok: <path d="M6 12.5 L10 16.5 L18 8" strokeWidth={2.2} />,
  attente: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5 V12 L15 14" />
    </>
  ),
  refus: <path d="M7.5 7.5 L16.5 16.5 M16.5 7.5 L7.5 16.5" strokeWidth={2.2} />,
  penalite: (
    <>
      <path d="M12 4 L21 19 H3 Z" />
      <path d="M12 10 V13.5 M12 16.3 V16.4" />
    </>
  ),
  courrier: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
      <path d="M4 7 L12 13 L20 7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11 V16 M12 8 V8.1" />
    </>
  ),
};

function Pastille({ genre }: { genre: Genre }) {
  return (
    <span aria-hidden="true" className={`pastille pastille-${genre} grid h-8 w-8 flex-none place-items-center rounded-full`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {TRACES[genre]}
      </svg>
    </span>
  );
}

/**
 * MOI › HISTORIQUE : ce qui est arrive a ma part, du plus recent au plus ancien.
 *
 * Le membre qui se demande ou en est sa declaration, d'ou vient une penalite
 * ou s'il a bien recu le rappel du 9 trouve la reponse ici, sans ecrire au
 * tresorier. Les filtres sont des liens, comme dans la boite « A valider » :
 * le choix survit au rechargement et la page reste rendue au serveur.
 */
export default async function PageHistorique({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; mois?: string }>;
}) {
  const membre = await exigerMembre();
  const { type, mois } = await searchParams;
  const filtre = FILTRES.find((f) => f.cle !== null && f.cle === type)?.cle ?? null;
  const nbMois = Math.min(240, Math.max(PAS, Math.floor(Number(mois)) || PAS));

  let donnees;
  try {
    donnees = await faitsDuMembre(membre.id);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }
  const fil = filDuMembre(membre.id, donnees.faits, donnees.parts);
  const choisis = filtre ? fil.filter((e) => e.famille === filtre) : fil;
  const groupes = parMois(choisis);
  const affiches = groupes.slice(0, nbMois);
  const suivant = groupes[nbMois]?.mois ?? null;

  const lien = (cle: Famille | null, n: number) => {
    const q = new URLSearchParams();
    if (cle) q.set("type", cle);
    if (n > PAS) q.set("mois", String(n));
    const chaine = q.toString();
    return chaine ? `/historique?${chaine}` : "/historique";
  };
  const nomMois = (iso: string) => {
    const t = moisLong(iso);
    return t.charAt(0).toUpperCase() + t.slice(1);
  };

  return (
    <>
      <EnTeteEcran
        titre="Mon historique"
        detail="Tout ce qui touche à ma part, du plus récent au plus ancien : mes versements et leur sort, mes pénalités, les rappels que j'ai reçus."
      />

      {fil.length === 0 ? (
        <Vide>Rien encore : vos versements, vos pénalités et les rappels reçus s&apos;afficheront ici.</Vide>
      ) : (
        <div className="flex flex-col gap-6">
          <nav aria-label="Filtrer" className="sans-impression flex flex-wrap gap-2">
            {FILTRES.map((f) => {
              const nb = f.cle ? fil.filter((e) => e.famille === f.cle).length : fil.length;
              if (f.cle && nb === 0) return null;
              const ici = filtre === f.cle;
              return (
                <Link
                  key={f.libelle}
                  href={lien(f.cle, PAS)}
                  scroll={false}
                  aria-current={ici ? "true" : undefined}
                  className="tapable inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-semibold"
                  style={
                    ici
                      ? { background: "var(--ink)", color: "var(--page)", borderColor: "var(--ink)" }
                      : { color: "var(--ink-2)", borderColor: "var(--line-2)" }
                  }
                >
                  {f.libelle} · {nb}
                </Link>
              );
            })}
          </nav>

          {affiches.map((g) => (
            <section key={g.mois} className="revele">
              <h2 className="mb-0.5 text-[12.5px] font-semibold tracking-wide uppercase" style={{ color: "var(--ink-2)" }}>
                {nomMois(g.mois)}
              </h2>
              <ol>
                {g.evenements.map((e) => (
                  <li key={e.cle} className="flex gap-3 border-t py-3.5" style={{ borderColor: "var(--line)" }}>
                    <Pastille genre={e.genre} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-baseline gap-2.5">
                        <span className="min-w-0 flex-1 text-[14.5px] font-semibold">{e.titre}</span>
                        {e.montant !== null && (
                          <span className="flex-none text-[14.5px] font-semibold whitespace-nowrap tabular-nums">
                            {avecMontants(fcfa(e.montant))}
                          </span>
                        )}
                      </div>
                      <p className="text-[13px] leading-snug" style={{ color: "var(--ink-2)" }}>
                        {avecMontants(e.detail)}
                      </p>
                      {e.motif && (
                        <p
                          className="mt-1 rounded-lg px-2.5 py-2 text-[12.5px] leading-snug"
                          style={{ background: "var(--etat-manque-fond)", color: "var(--etat-manque)" }}
                        >
                          {e.motif}
                        </p>
                      )}
                      <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                        {e.quand}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          {suivant && (
            <Link
              href={lien(filtre, nbMois + PAS)}
              scroll={false}
              className="tapable sans-impression flex min-h-11 items-center justify-center rounded-lg border text-[14px] font-medium"
              style={{ borderColor: "var(--line-2)", color: "var(--ink)" }}
            >
              Voir {moisLong(suivant)} et avant
            </Link>
          )}
        </div>
      )}
    </>
  );
}
