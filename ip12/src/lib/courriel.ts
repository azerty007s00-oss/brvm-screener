import "server-only";
import { CLUB, variable } from "@/lib/settings";

/**
 * Envoi de courrier, par SMTP ou par Resend.
 *
 * Le club n'a pas de service d'envoi a lui : il a une adresse Gmail, et peut-etre
 * un jour un relais Brevo. Exiger une cle d'API d'un fournisseur pour envoyer la
 * relance du 10 revenait a laisser cette fonction inerte -- ce qu'elle etait.
 *
 * Le transport se deduit de ce qui est configure, sans variable a choisir : SMTP
 * s'il y a un hote, Resend s'il y a une cle, rien sinon. L'absence de transport
 * n'est pas une panne : le site continue d'afficher les alertes, seul le courrier
 * ne part pas.
 */
export type Courriel = {
  destinataire: string;
  sujet: string;
  texte: string;
};

export type Transport = "smtp" | "resend" | "aucun";

export function transportConfigure(): Transport {
  if (variable("SMTP_HOST", "") !== "") return "smtp";
  if (variable("RESEND_API_KEY", "") !== "") return "resend";
  return "aucun";
}

/** Adresse d'expedition : celle du SMTP a defaut d'une adresse declaree. */
function expediteur(): string {
  const declare = variable("EMAIL_EXPEDITEUR", "");
  if (declare !== "") return declare;
  const utilisateur = variable("SMTP_USER", "");
  return utilisateur !== "" ? utilisateur : "onboarding@resend.dev";
}

/*
 * Le port dit le mode : 465 ouvre la session en TLS, 587 la commence en clair et
 * la chiffre par STARTTLS. Les confondre donne un echec de connexion muet.
 */
function optionsSmtp() {
  const port = Number(variable("SMTP_PORT", "465"));
  return {
    host: variable("SMTP_HOST", ""),
    port,
    secure: port === 465,
    auth: {
      user: variable("SMTP_USER", ""),
      /*
       * Google affiche ses mots de passe d'application par groupes de quatre
       * lettres separes d'espaces. On les colle tels qu'affiches ; les espaces
       * n'en font pas partie, et les laisser donne un refus d'authentification
       * que rien ne distingue d'un mauvais mot de passe.
       */
      pass: variable("SMTP_PASS", "").replace(/\s+/g, ""),
    },
  };
}

/**
 * Envoie un courrier. Ne leve jamais : rend `false` si l'envoi a echoue.
 *
 * Une relance qui echoue ne doit pas interrompre les suivantes, ni faire echouer
 * le traitement du 10 : l'echec est trace dans `reminder_log`, membre par membre.
 */
/** Ce qui est configure, en clair, sans jamais divulguer le mot de passe. */
export function descriptionTransport(): string {
  switch (transportConfigure()) {
    case "smtp":
      return `SMTP ${variable("SMTP_HOST", "")}:${variable("SMTP_PORT", "465")}, compte ${variable("SMTP_USER", "(non renseigne)")}`;
    case "resend":
      return `Resend, expediteur ${expediteur()}`;
    default:
      return "aucun transport configure";
  }
}

export async function envoyerCourriel(courriel: Courriel): Promise<boolean> {
  const transport = transportConfigure();
  const from = `${CLUB.nom} <${expediteur()}>`;

  try {
    if (transport === "smtp") {
      const { createTransport } = await import("nodemailer");
      const envoi = createTransport(optionsSmtp());
      await envoi.sendMail({
        from,
        to: courriel.destinataire,
        subject: courriel.sujet,
        text: courriel.texte,
      });
      return true;
    }

    if (transport === "resend") {
      const { Resend } = await import("resend");
      const resend = new Resend(variable("RESEND_API_KEY", ""));
      const { error } = await resend.emails.send({
        from,
        to: courriel.destinataire,
        subject: courriel.sujet,
        text: courriel.texte,
      });
      /*
       * Resend rend l'erreur plutot que de la lever : sans ce test, un refus du
       * fournisseur serait consigne comme un envoi reussi.
       */
      return !error;
    }
  } catch {
    return false;
  }
  return false;
}
