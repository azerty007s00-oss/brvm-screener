/**
 * La cle du voile des montants, et le script qui le pose avant la premiere peinture.
 *
 * A part du composant : la mise en page racine, rendue au serveur, insere le
 * script tel quel, et une constante exportee d'un module client n'y arriverait
 * pas comme une chaine. Sans ce script, les montants s'afficheraient une
 * fraction de seconde avant de se flouter -- precisement ce que le voile doit
 * empecher.
 */
export const CLE_VOILE = "ip12-voile";

export const SCRIPT_VOILE =
  `try{if(localStorage.getItem("${CLE_VOILE}")==="1")` +
  `document.documentElement.classList.add("voile")}catch(e){}`;
