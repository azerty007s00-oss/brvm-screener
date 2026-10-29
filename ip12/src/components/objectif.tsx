import type { Avancement, Objectif } from "@/lib/objectif";
import { dateCourte, fcfa, moisLong, nombre } from "@/lib/settings";
import { Voilable, avecMontants } from "@/components/voilable";

/** « juillet 2028 » ; « déc. 2027 » sous la barre, ou la place manque. */
function moisAbrege(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("fr-FR", { month: "short", year: "numeric", timeZone: "UTC" });
}

const pc = (x: number) => `${Math.round(x * 100)} %`;

/**
 * La tuile de l'objectif, sur l'accueil : ou en est le club, et quand il y
 * arrive si rien ne change.
 *
 * Le trait sur la barre marque ou il faudrait en etre au jour du releve pour
 * tenir l'echeance : en dessous, le club est en retard sur son cap, au-dessus
 * il est en avance. La phrase en dessous ne promet que ce que les cotisations
 * apportent ; la bourse est dite a part, comme ce qu'elle est : un bonus
 * incertain.
 */
export function TuileObjectif({
  objectif,
  a,
  valeur,
  dateValeur,
  rythme,
}: {
  objectif: Objectif;
  a: Avancement;
  valeur: number;
  dateValeur: string;
  rythme: number;
}) {
  const largeur = Math.min(1, a.atteint);
  const atteint = a.reste === 0;
  const libelleBarre =
    `${pc(a.atteint)} de l'objectif atteint` +
    (a.attendu !== null && !atteint ? ` ; au calendrier, il faudrait en être à ${pc(a.attendu)}` : "");

  let phrase: string;
  if (atteint) {
    phrase = `Objectif atteint au relevé du ${dateCourte(dateValeur)}, avant ${moisLong(objectif.echeance)}.`;
  } else if (a.echu) {
    phrase = `L'échéance de ${moisLong(objectif.echeance)} est passée : il manque ${fcfa(a.reste)}. Le président peut fixer une nouvelle date.`;
  } else if (rythme <= 0) {
    phrase = `Reste ${fcfa(a.reste)} d'ici ${moisLong(objectif.echeance)}.`;
  } else {
    phrase =
      `Reste ${fcfa(a.reste)} en ${a.moisRestants} mois. Au rythme des cotisations ` +
      `(${fcfa(rythme)} par mois), l'objectif sera atteint en ${moisLong(a.arrivee!)}` +
      (a.aTemps ? ", à temps" : "") +
      ", sans compter les gains de la bourse.";
  }
  /* Le mois d'arrivee, seul mis en couleur : c'est lui qui dit si le cap tient. */
  const arrivee = !atteint && !a.echu && rythme > 0 ? moisLong(a.arrivee!) : null;
  const [avant, apres] = arrivee ? phrase.split(arrivee) : [phrase, ""];

  return (
    <li className="col-span-2 lg:order-last lg:col-span-4">
      <div className="flex h-full flex-col gap-2.5 rounded-xl border p-3.5" style={{ borderColor: "var(--line)", background: "var(--carte)" }}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {objectif.intitule ? `Objectif du club : ${objectif.intitule}` : "Objectif du club"}
          </p>
          <p className="flex-none text-[13px] font-semibold tabular-nums">{pc(a.atteint)}</p>
        </div>
        <p className="whitespace-nowrap tabular-nums">
          <span className="text-[20px] font-medium lg:text-[24px]" style={{ letterSpacing: "-0.015em" }}>
            <Voilable>{nombre(valeur)}</Voilable>
          </span>
          <span className="mx-1.5 text-[14px]" style={{ color: "var(--ink-3)" }}>
            sur
          </span>
          <span className="text-[15px] font-medium">
            <Voilable>{nombre(objectif.montant)}</Voilable>
          </span>
          <span className="ml-1.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            FCFA
          </span>
        </p>
        <div role="img" aria-label={libelleBarre} className="relative mt-1 h-2.5 rounded-full" style={{ background: "var(--sunk)" }}>
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${largeur * 100}%`, background: atteint ? "var(--etat-paye)" : "var(--accent)" }}
          />
          {a.attendu !== null && !atteint && (
            <span
              aria-hidden="true"
              className="absolute -top-1 h-[18px] w-0.5 rounded-sm"
              style={{ left: `calc(${Math.min(1, a.attendu) * 100}% - 1px)`, background: "var(--ink)" }}
            />
          )}
        </div>
        <div className="flex justify-between gap-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          <span>fixé en {moisAbrege(objectif.fixeLe)}</span>
          {a.attendu !== null && !atteint && (
            <span className="text-center">
              il faudrait {pc(a.attendu)} au {dateCourte(dateValeur).slice(0, 5)}
            </span>
          )}
          <span>{moisAbrege(objectif.echeance)}</span>
        </div>
        <p className="mt-0.5 text-[13px] leading-snug" style={{ color: "var(--ink-2)" }}>
          {avecMontants(avant)}
          {arrivee && (
            <span className="font-semibold" style={{ color: a.aTemps ? "var(--ink)" : "var(--etat-attente)" }}>
              {arrivee}
            </span>
          )}
          {apres}
        </p>
      </div>
    </li>
  );
}
