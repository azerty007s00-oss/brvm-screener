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
 * Le meme texte, en HTML.
 *
 * Un message sans partie HTML s'affiche vide dans certains clients, dont
 * l'application mobile de Gmail : le corps est bien la, personne ne le voit. Les
 * deux parties portent le meme contenu -- le texte reste la source, le HTML n'en
 * est qu'un rendu.
 */
function enHtml(texte: string): string {
  const echappe = texte
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const corps = echappe
    .split("\n")
    .map((l) => (l.trim() === "" ? "<br>" : `<div>${l}</div>`))
    .join("");
  return (
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'font-size:15px;line-height:1.5;color:#1f1b16;white-space:pre-wrap">' +
    corps +
    "</div>"
  );
}

/**
 * Quelles variables d'envoi le serveur voit, et sous quel environnement.
 *
 * « Aucun transport configure » a plusieurs causes que rien ne distinguait :
 * variables enregistrees sur un autre projet, sur un autre environnement que
 * celui qui sert la page, nom mal orthographie, ou simplement pas enregistrees.
 * Dire lesquelles arrivent separe ces cas en un coup d'oeil.
 *
 * Les noms seulement, jamais les valeurs : un mot de passe ne s'affiche pas,
 * fut-ce sur une page reservee au president.
 */
export type EtatVariables = {
  environnement: string;
  /** Vrai si l'hebergeur est reconnu : sinon on ne lit meme pas le bon endroit. */
  chezVercel: boolean;
  variables: { nom: string; presente: boolean }[];
};

export function etatVariablesEnvoi(): EtatVariables {
  const noms = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_EXPEDITEUR"];
  return {
    environnement: variable("VERCEL_ENV", "hors Vercel"),
    chezVercel: variable("VERCEL", "") !== "" || variable("VERCEL_ENV", "") !== "",
    variables: noms.map((nom) => ({ nom, presente: variable(nom, "") !== "" })),
  };
}

/** L'adresse du compte d'envoi : la boite du club, ou l'essai peut aussi aboutir. */
export function adresseDuCompte(): string {
  return variable("SMTP_USER", "") || variable("EMAIL_EXPEDITEUR", "");
}

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

/**
 * Ce que l'envoi a donne, et ce qu'en a dit le serveur.
 *
 * Un booleen suffisait au cron, qui ne fait qu'inscrire l'echec dans
 * `reminder_log`. Il ne suffit pas quand le courrier ne semble pas arriver :
 * « accepte par le serveur » et « refuse » appellent des recherches opposees, et
 * sans la reponse du serveur rien ne les distingue.
 */
export type ResultatEnvoi = { ok: boolean; detail: string };

/**
 * Envoie un courrier. Ne leve jamais.
 *
 * Une relance qui echoue ne doit pas interrompre les suivantes, ni faire echouer
 * le traitement du 10 : l'echec est trace dans `reminder_log`, membre par membre.
 */
export async function envoyerCourriel(courriel: Courriel): Promise<ResultatEnvoi> {
  const transport = transportConfigure();
  const from = `${CLUB.nom} <${expediteur()}>`;

  try {
    if (transport === "smtp") {
      const { createTransport } = await import("nodemailer");
      const envoi = createTransport(optionsSmtp());
      const info = await envoi.sendMail({
        from,
        to: courriel.destinataire,
        subject: courriel.sujet,
        text: courriel.texte,
        html: enHtml(courriel.texte),
      });
      /*
       * `accepted` porte les destinataires que le serveur a pris en charge. Une
       * liste vide vaut refus, meme sans erreur levee : le courrier n'ira nulle
       * part, et le dire « envoye » ferait chercher dans la boite de reception un
       * probleme qui est ici.
       */
      if ((info.accepted ?? []).length === 0) {
        return { ok: false, detail: `aucun destinataire accepte — ${info.response ?? "sans reponse"}` };
      }
      return { ok: true, detail: String(info.response ?? "accepte") };
    }

    if (transport === "resend") {
      const { Resend } = await import("resend");
      const resend = new Resend(variable("RESEND_API_KEY", ""));
      const { data, error } = await resend.emails.send({
        from,
        to: courriel.destinataire,
        subject: courriel.sujet,
        text: courriel.texte,
        html: enHtml(courriel.texte),
      });
      /*
       * Resend rend l'erreur plutot que de la lever : sans ce test, un refus du
       * fournisseur serait consigne comme un envoi reussi.
       */
      if (error) return { ok: false, detail: `${error.name} — ${error.message}` };
      return { ok: true, detail: `accepte (identifiant ${data?.id ?? "inconnu"})` };
    }
  } catch (e) {
    // Le code SMTP nomme la cause bien mieux que le message : EAUTH, ECONNECTION…
    const err = e as { code?: string; responseCode?: number; message?: string };
    const code = err.code ? `${err.code} ` : "";
    const reponse = err.responseCode ? `(${err.responseCode}) ` : "";
    return { ok: false, detail: `${code}${reponse}${err.message ?? String(e)}` };
  }
  return { ok: false, detail: "aucun transport configure" };
}
