/*
 * Le passage de midi : le meme que celui du soir, sous une seconde adresse,
 * Vercel ne planifiant qu'un passage par jour et par adresse. A 12 h GMT, il
 * est 13 h a Paris, 7 h a Montreal, 20 h a Pekin : l'heure ou ouvrir le
 * sondage, relancer et rappeler la veille sans reveiller personne.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export { GET } from "../route";
