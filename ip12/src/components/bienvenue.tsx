import { changerMotDePasse } from "@/app/actions/auth";
import { Champ, FormulaireAction } from "@/components/formulaires";
import { Icone } from "@/components/icones";
import { CLUB, REGLES, ROLES, fcfa } from "@/lib/settings";
import type { Membre } from "@/lib/auth";

/*
 * Premiere connexion.
 *
 * Neuf membres vont ouvrir ce site sans l'avoir jamais vu, avec un mot de passe
 * que le president leur aura transmis par message. Les envoyer directement sur
 * le tableau de bord, c'est les mettre devant des chiffres qu'ils n'ont pas
 * demandes et un bandeau jaune qu'ils apprendront a ignorer.
 *
 * Tant que le mot de passe reste provisoire, cet ecran remplace le contenu de
 * toutes les pages : il dit ce qu'est le site, verifie l'adresse, et fait
 * changer le mot de passe avant d'ouvrir le reste. Ce n'est pas une redirection
 * -- le menu disparait, la deconnexion reste possible, et aucune page ne peut
 * etre atteinte par l'adresse directe.
 */
export function Bienvenue({ membre }: { membre: Membre }) {
  /*
   * Le club inscrit ses membres a la mode ivoirienne : NOM d'abord, prenoms
   * ensuite (« SORO Tielina Aboudramane »). Le prenom d'usage est donc le
   * deuxieme mot, pas le dernier -- prendre le dernier donnerait
   * « Aboudramane » a quelqu'un que tout le monde appelle Tielina.
   *
   * Un nom d'un seul mot est rendu tel quel : mieux vaut un accueil un peu
   * formel qu'un prenom invente.
   */
  const mots = membre.nom.trim().split(/\s+/);
  const prenom = mots.length > 1 ? mots[1] : membre.nom;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div
        className="apparait relief-fort rounded-2xl border p-5"
        style={{ background: "var(--carte)", borderColor: "var(--bordure)" }}
      >
        <p
          className="text-[11px] font-semibold tracking-[0.14em] uppercase"
          style={{ color: "var(--color-or-600)" }}
        >
          {CLUB.nom}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Bienvenue, {prenom}.</h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--discret)" }}>
          Ce site remplace le cahier du tresorier et les comptes envoyes au groupe. Vous y voyez a
          tout moment ce que vous avez verse, ce que vous devez, et ce que vaut votre part du
          portefeuille. Les comptes sont ouverts a tous les membres : c&apos;est le principe de
          l&apos;article 12.
        </p>
      </div>

      <div
        className="apparait relief rounded-2xl border p-4"
        style={{ background: "var(--carte)", borderColor: "var(--bordure)", ["--rang" as string]: 1 }}
      >
        <div className="flex items-start gap-3">
          <span
            className="grid h-[38px] w-[38px] flex-none place-items-center rounded-xl"
            style={{ background: "var(--color-or-200)", color: "var(--color-or-600)" }}
          >
            <Icone.courriel />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Votre adresse</p>
            <p className="mt-0.5 text-sm break-words">{membre.email}</p>
            <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
              C&apos;est a cette adresse que partiront les rappels avant le 10. Si ce n&apos;est pas
              la votre, signalez-le au president avant de continuer : personne d&apos;autre ne peut
              la corriger.
            </p>
          </div>
        </div>
      </div>

      {/*
        * Le mot de passe d'abord, et sans l'ancien : celui qu'on a recu par
        * message n'en est pas un, il a circule.
        */}
      <div
        className="apparait relief rounded-2xl border p-4"
        style={{ background: "var(--carte)", borderColor: "var(--bordure)", ["--rang" as string]: 2 }}
      >
        <div className="mb-3 flex items-start gap-3">
          <span
            className="grid h-[38px] w-[38px] flex-none place-items-center rounded-xl"
            style={{ background: "var(--color-or-200)", color: "var(--color-or-600)" }}
          >
            <Icone.bouclier />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Choisissez votre mot de passe</p>
            <p className="mt-0.5 text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
              Celui que vous avez recu a transite par un message : il ne protege rien. Le nouveau
              n&apos;est connu de personne, pas meme du president. Le site s&apos;ouvre des
              qu&apos;il est enregistre.
            </p>
          </div>
        </div>
        <FormulaireAction action={changerMotDePasse} libelle="Enregistrer et entrer">
          <Champ
            nom="nouveau"
            libelle="Nouveau mot de passe"
            type="password"
            autoComplete="new-password"
            aide="8 caracteres minimum."
          />
          <Champ nom="confirmation" libelle="Confirmer" type="password" autoComplete="new-password" />
        </FormulaireAction>
      </div>

      <div
        className="apparait relief rounded-2xl border p-4"
        style={{ background: "var(--carte)", borderColor: "var(--bordure)", ["--rang" as string]: 3 }}
      >
        <p className="mb-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase" style={{ color: "var(--color-brun-600)" }}>
          Ce que le club attend de vous
        </p>
        <ul className="space-y-2 text-[13px] leading-snug">
          <li className="flex gap-2.5">
            <span className="flex-none font-semibold whitespace-nowrap tabular-nums" style={{ color: "var(--color-or-600)" }}>
              {fcfa(REGLES.cotisationMensuelle)}
            </span>
            <span style={{ color: "var(--discret)" }}>
              chaque mois, au plus tard le {REGLES.jourEcheance} (art. 6 et 8).
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="flex-none font-semibold whitespace-nowrap tabular-nums" style={{ color: "var(--color-rouge-600)" }}>
              {(REGLES.tauxPenalite * 100).toFixed(0)} %
            </span>
            <span style={{ color: "var(--discret)" }}>
              de penalite par mois de retard, definitivement acquise au club (art. 9).
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="flex-none font-semibold" style={{ color: "var(--color-brun-600)" }}>
              R3
            </span>
            <span style={{ color: "var(--discret)" }}>
              au-dela d&apos;un mois de retard, prevenez le groupe : la declaration change ce qui
              vous attend en cas de retard prolonge.
            </span>
          </li>
        </ul>
        <p className="mt-3 text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
          Vous etes inscrit comme {ROLES[membre.role].toLowerCase()}. Declarer un versement se fait
          depuis l&apos;onglet Versements ; le tresorier le valide ensuite, et personne ne valide le
          sien.
        </p>
      </div>
    </div>
  );
}
