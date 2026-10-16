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
          className="text-[11px] font-semibold tracking-[0.14em]"
          style={{ color: "var(--gold-ink)" }}
        >
          {CLUB.nom}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Bienvenue, {prenom}.</h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--discret)" }}>
          Ce site remplace le cahier du trésorier et les comptes envoyés au groupe. Vous y voyez à
          tout moment ce que vous avez versé, ce que vous devez, et ce que vaut votre part du
          portefeuille. Les comptes sont ouverts à tous les membres : c&apos;est le principe de
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
            style={{ background: "var(--sunk)", color: "var(--ink-2)" }}
          >
            <Icone.courriel />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Votre adresse</p>
            <p className="mt-0.5 text-sm break-words">{membre.email}</p>
            <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
              C&apos;est à cette adresse que partiront les rappels avant le 10. Si ce n&apos;est pas
              la vôtre, signalez-le au président avant de continuer : personne d&apos;autre ne peut
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
            style={{ background: "var(--sunk)", color: "var(--ink-2)" }}
          >
            <Icone.bouclier />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Choisissez votre mot de passe</p>
            <p className="mt-0.5 text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
              Celui que vous avez reçu à transité par un message : il ne protège rien. Le nouveau
              n&apos;est connu de personne, pas même du président. Le site s&apos;ouvre des
              qu&apos;il est enregistré.
            </p>
          </div>
        </div>
        <FormulaireAction action={changerMotDePasse} libelle="Enregistrer et entrer">
          <Champ
            nom="nouveau"
            libelle="Nouveau mot de passe"
            type="password"
            autoComplete="new-password"
            aide="8 caractères minimum."
          />
          <Champ nom="confirmation" libelle="Confirmer" type="password" autoComplete="new-password" />
        </FormulaireAction>
      </div>

      <div
        className="apparait relief rounded-2xl border p-4"
        style={{ background: "var(--carte)", borderColor: "var(--bordure)", ["--rang" as string]: 3 }}
      >
        <p className="mb-2.5 text-[11px] font-semibold tracking-[0.1em]" style={{ color: "var(--ink-2)" }}>
          Ce que le club attend de vous
        </p>
        <ul className="space-y-2 text-[13px] leading-snug">
          <li className="flex gap-2.5">
            <span className="flex-none font-semibold whitespace-nowrap tabular-nums" style={{ color: "var(--gold-ink)" }}>
              {fcfa(REGLES.cotisationMensuelle)}
            </span>
            <span style={{ color: "var(--discret)" }}>
              chaque mois, au plus tard le {REGLES.jourEcheance} (art. 6 et 8).
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="flex-none font-semibold whitespace-nowrap tabular-nums" style={{ color: "var(--etat-manque)" }}>
              {(REGLES.tauxPenalite * 100).toFixed(0)} %
            </span>
            <span style={{ color: "var(--discret)" }}>
              de pénalité par mois de retard, définitivement acquise au club (art. 9).
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="flex-none font-semibold" style={{ color: "var(--ink-2)" }}>
              R3
            </span>
            <span style={{ color: "var(--discret)" }}>
              au-delà d&apos;un mois de retard, prévenez le groupe : la déclaration change ce qui
              vous attend en cas de retard prolongé.
            </span>
          </li>
        </ul>
        <p className="mt-3 text-[11.5px] leading-snug" style={{ color: "var(--discret)" }}>
          Vous êtes inscrit comme {ROLES[membre.role].toLowerCase()}. Déclarer un versement se fait
          depuis l&apos;onglet Versements ; le trésorier en est prévenu par courriel, vous et le
          président en copie, et il valide ensuite. Inutile de lui écrire en plus. Personne ne
          valide le sien.
        </p>
      </div>
    </div>
  );
}
