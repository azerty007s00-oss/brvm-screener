/**
 * LA REUNION DANS L'AGENDA DU TELEPHONE.
 *
 * La convocation disait le jour et l'heure ; restait a les recopier dans son
 * agenda, ce que personne ne fait, et la reunion s'oubliait jusqu'au rappel de
 * la veille. Le courriel porte donc une invitation au format iCalendar, celui
 * que lisent Gmail, l'iPhone et Outlook : un toucher sur « Oui » l'inscrit
 * dans l'agenda, et une reunion deplacee s'y deplace d'elle-meme. La page
 * Reunions offre la meme chose a qui n'a pas le courriel sous la main.
 *
 * Calcul pur, sans base ni horloge : la verification le rejoue a l'identique.
 * Les heures sont celles d'Abidjan, qui vit a l'heure UTC toute l'annee : la
 * reunion de 19 h s'ecrit 19:00Z, et l'agenda d'un membre a Paris la montre a
 * son heure a lui.
 */

/** « 19 h », « 19h30 », « 19:30 », « 19 h 30 » ; null si le texte ne dit pas une heure. */
export function lireHeure(texte: string): { h: number; m: number } | null {
  const r = /^\s*(\d{1,2})\s*(?:h|H|:)\s*(\d{2})?\s*$/.exec(texte) ?? /^\s*(\d{1,2})\s*$/.exec(texte);
  if (!r) return null;
  const h = Number(r[1]);
  const m = r[2] ? Number(r[2]) : 0;
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** L'heure comme le club l'ecrit : « 19 h », « 19 h 30 ». Le texte d'origine s'il n'en est pas une. */
export function heureEnClair(texte: string): string {
  const t = lireHeure(texte);
  if (!t) return texte.trim();
  return t.m === 0 ? `${t.h} h` : `${t.h} h ${String(t.m).padStart(2, "0")}`;
}

export type Personne = { nom: string; email: string };

export type Invitation = {
  /** Identifiant stable : une seconde invitation de meme `uid` remplace la premiere. */
  uid: string;
  /** Croit a chaque modification ; l'agenda ignore une version plus ancienne que la sienne. */
  sequence: number;
  /** AAAA-MM-JJ. */
  jour: string;
  /** Texte libre ; sans heure lisible, l'evenement occupe la journee. */
  heure: string | null;
  dureeMinutes: number;
  titre: string;
  lieu: string | null;
  description: string;
  /**
   * REQUEST : une invitation, a laquelle on repond, et qui suppose un
   * organisateur et un invite. PUBLISH : un evenement a ajouter, sans plus.
   */
  methode: "REQUEST" | "PUBLISH";
  organisateur: Personne | null;
  invite: Personne | null;
  /** DTSTAMP : quand l'invitation a ete produite. */
  emisLe: Date;
};

/** Un texte iCalendar : barre oblique inverse, point-virgule, virgule et saut de ligne echappes. */
function texte(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Un parametre (CN=...) : entre guillemets, qui n'y sont pas admis. */
function parametre(t: string): string {
  return `"${t.replace(/"/g, "'")}"`;
}

/**
 * Plie une ligne a 75 octets, comme l'exige la norme (RFC 5545, 3.1) : la
 * suite repart a la ligne apres une espace. Les octets, et non les
 * caracteres : « Réunion » compte un octet de plus qu'il n'a de lettres, et
 * un caractere ne se coupe jamais en deux.
 */
function plier(ligne: string): string {
  const codeur = new TextEncoder();
  const morceaux: string[] = [];
  let courant = "";
  let octets = 0;
  for (const c of ligne) {
    const n = codeur.encode(c).length;
    const limite = morceaux.length === 0 ? 75 : 74;
    if (octets + n > limite) {
      morceaux.push(courant);
      courant = "";
      octets = 0;
    }
    courant += c;
    octets += n;
  }
  morceaux.push(courant);
  return morceaux.join("\r\n ");
}

/** 20261115T190000Z */
function instant(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function bornes(i: Pick<Invitation, "jour" | "heure" | "dureeMinutes">): { debut: Date; fin: Date } | null {
  const t = i.heure ? lireHeure(i.heure) : null;
  if (!t) return null;
  const debut = new Date(`${i.jour}T${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}:00Z`);
  return { debut, fin: new Date(debut.getTime() + i.dureeMinutes * 60_000) };
}

/** Le fichier .ics de l'invitation, lignes terminees par CRLF. */
export function fichierIcs(i: Invitation): string {
  const b = bornes(i);
  const lendemain = new Date(Date.parse(`${i.jour}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const lignes = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//IP12//Reunions//FR",
    "CALSCALE:GREGORIAN",
    `METHOD:${i.methode}`,
    "BEGIN:VEVENT",
    `UID:${i.uid}`,
    `SEQUENCE:${i.sequence}`,
    `DTSTAMP:${instant(i.emisLe)}`,
    ...(b
      ? [`DTSTART:${instant(b.debut)}`, `DTEND:${instant(b.fin)}`]
      : [`DTSTART;VALUE=DATE:${i.jour.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${lendemain.replace(/-/g, "")}`]),
    `SUMMARY:${texte(i.titre)}`,
    ...(i.lieu ? [`LOCATION:${texte(i.lieu)}`] : []),
    `DESCRIPTION:${texte(i.description)}`,
    "STATUS:CONFIRMED",
    ...(i.organisateur ? [`ORGANIZER;CN=${parametre(i.organisateur.nom)}:mailto:${i.organisateur.email}`] : []),
    ...(i.invite
      ? [`ATTENDEE;CN=${parametre(i.invite.nom)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${i.invite.email}`]
      : []),
    /* Une heure avant : le rappel de la veille vient des alertes du site. */
    ...(b ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${texte(i.titre)}`, "TRIGGER:-PT1H", "END:VALARM"] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lignes.map(plier).join("\r\n") + "\r\n";
}

/**
 * Le lien qui ouvre Google Agenda sur l'evenement pret a enregistrer : la voie
 * la plus sure sur Android, ou l'agenda de Google n'ouvre pas les fichiers .ics.
 */
export function lienGoogleAgenda(i: Pick<Invitation, "jour" | "heure" | "dureeMinutes" | "titre" | "lieu" | "description">): string {
  const b = bornes(i);
  const lendemain = new Date(Date.parse(`${i.jour}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const dates = b ? `${instant(b.debut)}/${instant(b.fin)}` : `${i.jour.replace(/-/g, "")}/${lendemain.replace(/-/g, "")}`;
  const p = new URLSearchParams({ action: "TEMPLATE", text: i.titre, dates, details: i.description });
  if (i.lieu) p.set("location", i.lieu);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
