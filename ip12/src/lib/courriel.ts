import "server-only";
import { CLUB, lienDuSite, variable } from "@/lib/settings";

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
  /**
   * Adresses en copie, visibles de tous les destinataires.
   *
   * La copie n'est pas un second envoi : c'est le meme courrier, avec le meme
   * fil de discussion. Le tresorier qui repond « c'est encaisse » repond a tout
   * le monde d'un coup, et le membre voit que sa declaration est bien partie.
   * Une copie cachee ferait l'inverse : chacun ignorerait que les autres savent.
   */
  copie?: string[];
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
 * deux parties portent le meme contenu -- LE TEXTE RESTE LA SOURCE, le HTML n'en
 * est qu'un rendu. Rien n'est ecrit deux fois, donc rien ne peut diverger.
 *
 * Ce rendu lit la structure que les courriers respectent deja :
 *
 *   TITRE EN CAPITALES            une section
 *   TITRE — avec une suite        une section, et sa precision en gris
 *     - element                   une liste
 *     1. etape                    une marche numerotee
 *        suite indentee           la suite de la ligne precedente
 *   Le bureau — ...               le pied, en gris et plus petit
 *
 * UNE LIGNE, UN PARAGRAPHE. Depuis que les paragraphes ne sont plus coupes a la
 * main, chaque ligne du texte est une unite de sens complete. Les joindre faisait
 * fondre en un seul bloc le montant de la dette et l'avertissement de R5, qui
 * sont deux choses.
 *
 * Aucune balise n'est inventee : ce que le texte ne dit pas, le HTML ne le dit
 * pas non plus.
 *
 * LES CONTRAINTES DU COURRIEL, NON CELLES DU WEB. Styles en ligne -- aucune
 * feuille n'est lue --, tableaux pour la largeur, et des couleurs posees
 * explicitement : Gmail sur Android inverse les siennes en theme sombre, et un
 * fond laisse implicite devient noir sous une encre noire.
 */
const ENCRE = "#1f1b16";
const ENCRE_2 = "#5c5349";
const MARINE = "#1b3557";
const FILET = "#e4ded4";
const PAPIER = "#ffffff";
const FOND = "#f4f1ec";

function echapper(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Les adresses du site deviennent cliquables ; rien d'autre n'est touche. */
function avecLiens(t: string): string {
  return t.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    `<a href="$1" style="color:${MARINE};text-decoration:underline">$1</a>`,
  );
}

/**
 * Un titre de section : tout ce qui precede un tiret cadratin est en capitales.
 *
 * « MESURE DISCIPLINAIRE — plan de redressement (R5). » est un titre dont la
 * precision ne l'est pas. On ne teste donc pas la ligne entiere, sans quoi la
 * moitie des titres du courrier passerait pour un paragraphe.
 */
function titreEtSuite(ligne: string): { titre: string; suite: string } | null {
  const coupe = ligne.indexOf(" — ");
  const tete = coupe === -1 ? ligne : ligne.slice(0, coupe);
  const lettres = tete.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (lettres.length < 4 || tete !== tete.toUpperCase()) return null;
  return { titre: tete.trim(), suite: coupe === -1 ? "" : ligne.slice(coupe + 3).trim() };
}

function enHtml(texte: string): string {
  const morceaux: string[] = [];
  let paragraphe: string[] = [];
  let liste: string[] = [];
  let pied = false;

  const viderParagraphe = (pied = false) => {
    if (paragraphe.length === 0) return;
    const style = pied
      ? `margin:0 0 4px;font-size:13px;line-height:1.55;color:${ENCRE_2}`
      : `margin:0 0 14px;font-size:15px;line-height:1.6;color:${ENCRE}`;
    morceaux.push(`<p style="${style}">${avecLiens(paragraphe.join(" "))}</p>`);
    paragraphe = [];
  };
  const viderListe = () => {
    if (liste.length === 0) return;
    morceaux.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
        `style="margin:0 0 14px;border-left:2px solid ${FILET};padding-left:0">` +
        liste
          .map(
            (l) =>
              `<tr><td style="padding:3px 0 3px 12px;font-size:15px;line-height:1.55;` +
              `color:${ENCRE}">${avecLiens(l)}</td></tr>`,
          )
          .join("") +
        "</table>",
    );
    liste = [];
  };

  for (const brute of texte.split("\n")) {
    const ligne = echapper(brute);
    const nue = ligne.trim();

    if (nue === "") {
      viderParagraphe();
      viderListe();
      continue;
    }

    /* Une ligne indentee de quatre espaces ou plus prolonge la precedente. */
    if (/^ {4,}/.test(ligne) && liste.length > 0) {
      liste[liste.length - 1] += ` ${nue}`;
      continue;
    }
    if (/^ {4,}/.test(ligne) && paragraphe.length > 0) {
      paragraphe.push(nue);
      continue;
    }

    const element = nue.match(/^(?:- |\d+\. )([\s\S]*)$/);
    if (/^ {2}/.test(ligne) && element) {
      viderParagraphe();
      const numero = nue.match(/^(\d+)\. /);
      liste.push(
        numero
          ? `<span style="color:${ENCRE_2}">${numero[1]}.</span> ${element[1]}`
          : element[1],
      );
      continue;
    }

    const titre = titreEtSuite(nue);
    if (titre) {
      viderParagraphe();
      viderListe();
      morceaux.push(
        `<p style="margin:26px 0 10px;padding-top:14px;border-top:1px solid ${FILET}">` +
          `<span style="font-size:12.5px;font-weight:600;letter-spacing:0.07em;` +
          `text-transform:uppercase;color:${MARINE}">${titre.titre}</span>` +
          (titre.suite
            ? `<br><span style="font-size:14px;color:${ENCRE_2}">${avecLiens(titre.suite)}</span>`
            : "") +
          "</p>",
      );
      continue;
    }

    viderListe();
    /*
     * Chaque ligne se ferme aussitot : elle est deja un paragraphe entier.
     * Le pied -- la date du courrier et la signature -- se distingue du corps,
     * comme il le fait sur le papier.
     */
    viderParagraphe();
    paragraphe.push(nue);
    const estPied =
      /^(Relance|Courrier) du \d/.test(nue) || /^Le (bureau|suivi du club) — /.test(nue);
    if (estPied) {
      if (morceaux.length > 0 && !pied) {
        morceaux.push(`<div style="height:10px;border-top:1px solid ${FILET};margin-top:18px"></div>`);
        pied = true;
      }
      viderParagraphe(true);
    }
  }
  viderParagraphe();
  viderListe();

  /*
   * Le pied est pose a part : il ferme le courrier, et c'est la derniere ligne
   * du texte qui le designe -- « Le bureau — Investment Pioneers ».
   */
  return (
    `<div style="margin:0;padding:0;background:${FOND}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="background:${FOND};padding:16px 0"><tr><td align="center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="max-width:600px;background:${PAPIER};border:1px solid ${FILET};border-radius:12px">` +
    `<tr><td style="padding:18px 22px;background:${MARINE};border-radius:12px 12px 0 0">` +
    `<span style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;` +
    `font-size:15px;font-weight:600;color:#ffffff;letter-spacing:0.02em">${CLUB.sigle}</span>` +
    `<span style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;` +
    `font-size:13px;color:#c3d4e8"> · ${CLUB.nom}</span>` +
    `</td></tr><tr><td style="padding:22px;font-family:system-ui,-apple-system,` +
    `'Segoe UI',Roboto,sans-serif">` +
    morceaux.join("") +
    "</td></tr></table></td></tr></table></div>"
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

/**
 * Reglages de securite a verifier avant d'ouvrir le site aux membres.
 *
 * Deux variables gouvernent des portes ouvertes sur l'exterieur, et leur etat ne
 * se lit nulle part ailleurs : mieux vaut que le president le voie que d'avoir a
 * s'en souvenir.
 */
export function controlesOuverture(): { cle: string; ok: boolean; explication: string }[] {
  return [
    {
      cle: "CRON_SECRET",
      ok: variable("CRON_SECRET", "") !== "",
      explication:
        "Protege la route de relance. Absente, la relance est desactivee : sans elle, " +
        "n'importe qui connaissant l'adresse pourrait ecrire a tous les membres.",
    },
    {
      cle: "NEXT_PUBLIC_SITE_URL",
      ok: lienDuSite() !== "",
      explication:
        lienDuSite() !== ""
          ? `Adresse portee par les courriers : ${lienDuSite()}. Verifiez que c'est bien ` +
            "l'adresse de production, non celle d'un apercu : un membre qui l'ouvrirait " +
            "tomberait sur une version figee."
          : "Absente : les courriers d'acces et de relance partent sans le lien du site, " +
            "et le membre ne sait pas ou aller. Renseignez-la, puis redeployez.",
    },
    {
      cle: "SETUP_TOKEN",
      // Ici, l'absence est le bon etat : c'est une porte d'amorcage.
      ok: variable("SETUP_TOKEN", "") === "",
      explication:
        "Jeton d'amorcage : il permet de reinitialiser le mot de passe du president. " +
        "Il ne sert qu'une fois, et doit etre supprime des variables d'environnement.",
    },
  ];
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
        ...(courriel.copie?.length ? { cc: courriel.copie } : {}),
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
        ...(courriel.copie?.length ? { cc: courriel.copie } : {}),
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
