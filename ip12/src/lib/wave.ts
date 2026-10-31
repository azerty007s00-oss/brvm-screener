/**
 * PAYER PAR WAVE.
 *
 * Le club n'encaisse que par Wave, sur le numero du tresorier. Payer
 * demandait de retrouver ce numero dans la conversation du groupe, de le
 * recopier chiffre a chiffre, puis de revenir declarer le versement, capture
 * a l'appui. Le site garde le numero, le copie d'un toucher et ouvre Wave ;
 * au retour, « J'ai paye » declare le versement deja rempli.
 *
 * Le numero Wave de chaque membre complete le circuit : le tresorier
 * reconnait l'envoi dans son historique Wave, au meme numero et au meme
 * montant, sans attendre de capture.
 *
 * Un lien qui ouvrirait Wave avec le destinataire et le montant deja saisis
 * n'existe que pour les comptes Wave Business (API de paiement, avec frais) :
 * le club, sur un compte personnel, copie le numero et ouvre l'application.
 *
 * Calcul pur : la verification le rejoue.
 */

/** Le numero Wave du club, celui du tresorier, en E.164. */
export const WAVE_CLUB = "+2250758101989";

/** L'application Wave sur Android, et sa page sur l'App Store de l'iPhone. */
export const PAQUET_ANDROID = "com.wave.personal";
export const PAGE_IOS = "https://apps.apple.com/app/id1523884528";

/**
 * Un numero saisi, au format E.164 (« +2250708123456 »), ou null.
 *
 * Un numero ivoirien a dix chiffres commence par 0 : « 07 08 12 34 56 »,
 * « 0708123456 ». L'indicatif s'ecrit « +225 », « 00225 » ou « 225 ». Un
 * numero etranger se donne avec son indicatif.
 */
export function lireNumero(saisie: string | null | undefined): string | null {
  const brut = String(saisie ?? "").replace(/[\s.\-()/]/g, "");
  if (/^0\d{9}$/.test(brut)) return `+225${brut}`;
  if (/^225\d{10}$/.test(brut)) return `+${brut}`;
  if (/^00[1-9]\d{7,14}$/.test(brut)) return `+${brut.slice(2)}`;
  if (/^\+[1-9]\d{7,14}$/.test(brut)) return brut;
  return null;
}

/** « +225 07 08 12 34 56 », « +33 6 12 34 56 78 » ; le numero tel quel sinon. */
export function numeroEnClair(e164: string): string {
  const deux = (s: string) => s.replace(/(\d{2})(?=\d)/g, "$1 ");
  if (/^\+225\d{10}$/.test(e164)) return `+225 ${deux(e164.slice(4))}`;
  if (/^\+33\d{9}$/.test(e164)) return `+33 ${e164[3]} ${deux(e164.slice(4))}`;
  if (/^\+1\d{10}$/.test(e164)) return `+1 ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}`;
  return e164;
}

/**
 * Ce qui se colle dans Wave : le numero local a dix chiffres pour la Cote
 * d'Ivoire (« 0758101989 »), ou il se tape ainsi ; le numero complet sinon.
 */
export function numeroACopier(e164: string): string {
  return /^\+225\d{10}$/.test(e164) ? e164.slice(4) : e164;
}

/** La reference d'un versement par Wave : « Wave +225 07 08 12 34 56 ». */
export function referenceWave(e164: string): string {
  return `Wave ${numeroEnClair(e164)}`;
}

/** Le numero d'ou part un versement, relu dans sa reference ; null si elle n'en porte pas. */
export function numeroDeReference(reference: string | null | undefined): string | null {
  const m = /^\s*Wave\s+(.+)$/i.exec(reference ?? "");
  return m ? lireNumero(m[1]) : null;
}

/**
 * Le lien qui ouvre Wave. Sur Android, l'application elle-meme, et a defaut
 * sa page du Play Store ; sur iPhone, sa page de l'App Store, ou « Ouvrir »
 * la lance. Ailleurs (un ordinateur), rien : le numero copie suffit.
 */
export function lienOuvrirWave(appareil: "android" | "ios" | "autre"): string | null {
  if (appareil === "android") {
    const repli = encodeURIComponent(`https://play.google.com/store/apps/details?id=${PAQUET_ANDROID}`);
    return (
      "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;" +
      `package=${PAQUET_ANDROID};S.browser_fallback_url=${repli};end`
    );
  }
  if (appareil === "ios") return PAGE_IOS;
  return null;
}

/** L'appareil, d'apres l'agent du navigateur. */
export function appareilDe(agent: string): "android" | "ios" | "autre" {
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  return "autre";
}
