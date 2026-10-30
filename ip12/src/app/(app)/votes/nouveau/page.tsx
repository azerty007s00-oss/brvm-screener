import Link from "next/link";
import { exigerMembre } from "@/lib/auth";
import { electeursActuels, personnes } from "@/lib/votes";
import { HEURE_CLOTURE, MAJORITES } from "@/lib/scrutin";
import { accorde } from "@/lib/settings";
import { proposerVote } from "@/app/actions/votes";
import { FormulaireAction } from "@/components/formulaires";
import { Carte, EnTeteEcran } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Proposer un vote" };

const styleChamp =
  "mt-1.5 w-full rounded-[10px] border px-3.5 py-2.5 text-[16px] outline-none " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--gold)] focus:border-transparent lg:rounded-lg lg:px-3 lg:text-[14px]";
const couleursChamp = { background: "var(--page)", borderColor: "var(--line-2)", color: "var(--ink)" };

export default async function PageProposerVote() {
  const membre = await exigerMembre();
  const [liste, gens] = await Promise.all([electeursActuels(null).catch(() => []), personnes()]);
  const suspendus = liste.filter((e) => e.exclu === "suspendu");
  const admis = liste.length - suspendus.length;
  /* Une semaine pour voter, par defaut. */
  const maintenant = new Date();
  const plus = (jours: number) => new Date(maintenant.getTime() + jours * 86_400_000).toISOString().slice(0, 10);
  const dans7 = plus(7);
  const demain = plus(1);
  const max = plus(60);

  return (
    <>
      <p className="text-[13px]">
        <Link href="/votes" className="underline" style={{ color: "var(--accent)" }}>
          Votes
        </Link>
      </p>
      <EnTeteEcran titre="Proposer un vote" detail="Tout membre peut soumettre une question au club." />

      <Carte>
        <FormulaireAction action={proposerVote} libelle="Ouvrir le vote et inviter les membres">
          <label className="block">
            <span className="text-[13px] font-medium">La question posée</span>
            <textarea
              name="question"
              required
              rows={2}
              maxLength={240}
              placeholder="Passer la cotisation à 7 500 FCFA à partir de janvier 2027"
              className={styleChamp}
              style={couleursChamp}
            />
          </label>
          <label className="mt-4 block">
            <span className="text-[13px] font-medium">
              Ce qu&apos;il faut savoir <span className="font-normal" style={{ color: "var(--ink-3)" }}>(facultatif)</span>
            </span>
            <textarea name="details" rows={3} maxLength={2000} className={styleChamp} style={couleursChamp} />
          </label>

          <fieldset className="mt-4">
            <legend className="mb-2 text-[13px] font-medium">Majorité requise</legend>
            <div className="flex flex-col gap-2">
              {(Object.keys(MAJORITES) as (keyof typeof MAJORITES)[]).map((cle) => (
                <label
                  key={cle}
                  className="tapable flex cursor-pointer items-start gap-2.5 rounded-[10px] border p-3 has-[:checked]:border-2 has-[:checked]:border-[var(--accent)]"
                  style={{ borderColor: "var(--line-2)", background: "var(--page)" }}
                >
                  <input
                    type="radio"
                    name="majorite"
                    value={cle}
                    defaultChecked={cle === "simple"}
                    required
                    className="mt-0.5 h-[18px] w-[18px] flex-none"
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span>
                    <span className="block text-[14.5px] font-semibold">{MAJORITES[cle].libelle}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug" style={{ color: "var(--ink-2)" }}>
                      {MAJORITES[cle].aide}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="mt-4 block">
            <span className="text-[13px] font-medium">Clôture, à {HEURE_CLOTURE} h GMT (heure d&apos;Abidjan)</span>
            <input type="date" name="cloture" required defaultValue={dans7} min={demain} max={max} className={`${styleChamp} h-12 py-0 lg:h-10`} style={couleursChamp} />
          </label>

          <label className="mt-4 block">
            <span className="text-[13px] font-medium">
              Membre concerné <span className="font-normal" style={{ color: "var(--ink-3)" }}>(une exclusion : il ne vote pas)</span>
            </span>
            <select name="vise" defaultValue="" className={`${styleChamp} h-12 py-0 lg:h-10`} style={couleursChamp}>
              <option value="">Aucun</option>
              {gens
                .filter((m) => m.id !== membre.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nom}
                  </option>
                ))}
            </select>
          </label>

          <div className="mt-4 rounded-[10px] p-3.5 text-[13px] leading-relaxed" style={{ background: "var(--sunk)", color: "var(--ink-2)" }}>
            <p className="font-semibold" style={{ color: "var(--ink)" }}>
              Qui vote
            </p>
            <p className="mt-1">
              {admis} {accorde(admis, "membre")} sur {liste.length}, chacun au prorata de sa part du club.
              {suspendus.length > 0 &&
                ` ${suspendus.map((e) => e.nom).join(", ")} ne ${suspendus.length > 1 ? "votent" : "vote"} pas : droit de vote suspendu (R2) tant que le retard n'est pas régularisé.`}{" "}
              Tous reçoivent une invitation par courriel et par alerte, et ceux qui n&apos;ont pas voté un rappel la veille.
            </p>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            Le vote est public : chacun voit qui a voté quoi. Un vote ouvert ne se modifie plus : son auteur ou le président peut
            l&apos;annuler, motif à l&apos;appui, et tous en sont avertis.
          </p>
        </FormulaireAction>
      </Carte>
    </>
  );
}
