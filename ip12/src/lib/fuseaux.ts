/**
 * LES MEMBRES SONT SUR QUATRE FUSEAUX.
 *
 * Le club se reunit a 21 h GMT, l'heure d'Abidjan, ou vit la majorite. Mais
 * deux membres sont en France, un au Canada, un en Chine : « 21 h » ne leur
 * dit pas a quelle heure se connecter, et la reunion du dimanche 21 h tombe
 * le lundi a 5 h a Pekin. Chaque heure de reunion s'ecrit donc en GMT, suivie
 * de l'heure du membre quand elle differe.
 *
 * Le fuseau de chacun vient de son navigateur, sans rien lui demander. Calcul
 * pur : l'instant et le fuseau arrivent en arguments.
 */

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Un fuseau IANA que le moteur connait : « Europe/Paris ». */
export function fuseauValide(fuseau: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(fuseau) || fuseau.length > 64) return false;
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: fuseau });
    return true;
  } catch {
    return false;
  }
}

/** L'heure murale d'un instant dans un fuseau : jour (AAAA-MM-JJ), heure, minutes. */
export function heureMurale(instant: Date, fuseau: string): { jour: string; h: number; m: number } {
  const parties = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: fuseau,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return { jour: `${parties.year}-${parties.month}-${parties.day}`, h: Number(parties.hour) % 24, m: Number(parties.minute) };
}

/** Le fuseau vit-il a l'heure GMT a cet instant ? Abidjan, Dakar, Londres l'hiver. */
export function estGmt(instant: Date, fuseau: string): boolean {
  const t = heureMurale(instant, fuseau);
  return t.jour === instant.toISOString().slice(0, 10) && t.h === instant.getUTCHours() && t.m === instant.getUTCMinutes();
}

function heureCourte(h: number, m: number): string {
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

/**
 * L'heure de l'instant chez le membre, ou null si elle est celle de GMT :
 * « 22 h », ou « 5 h le lendemain » quand le jour change. Relative plutot
 * que datee : elle suit une date GMT qui vient d'etre dite.
 */
export function heureChezSoi(instant: Date, fuseau: string | null): string | null {
  if (!fuseau || !fuseauValide(fuseau) || estGmt(instant, fuseau)) return null;
  const t = heureMurale(instant, fuseau);
  const heure = heureCourte(t.h, t.m);
  const ecart = (Date.parse(`${t.jour}T00:00:00Z`) - Date.parse(`${instant.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  if (ecart === 0) return heure;
  if (ecart === 1) return `${heure} le lendemain`;
  if (ecart === -1) return `${heure} la veille`;
  const jour = new Date(`${t.jour}T12:00:00Z`);
  return `${heure} le ${JOURS[jour.getUTCDay()]} ${t.jour.slice(8, 10)}/${t.jour.slice(5, 7)}`;
}

/**
 * « 21 h » pour qui vit a l'heure GMT, « 21 h GMT (22 h chez vous) » pour
 * les autres, « 21 h GMT » quand le fuseau du membre n'est pas connu.
 */
export function heurePour(
  heureGmt: string,
  instant: Date | null,
  fuseau: string | null,
  chezSoi: "chez vous" | "chez toi" = "chez vous",
): string {
  if (!instant) return heureGmt;
  if (fuseau && fuseauValide(fuseau) && estGmt(instant, fuseau)) return heureGmt;
  const local = heureChezSoi(instant, fuseau);
  return local ? `${heureGmt} GMT (${local} ${chezSoi})` : `${heureGmt} GMT`;
}
