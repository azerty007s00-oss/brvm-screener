import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { listerApports, listerMouvementsCaisse, synthese } from "@/lib/queries";
import { enregistrerApport, supprimerApport } from "@/app/actions/titres";
import { CLUB, dateCourte, fcfa, nombre } from "@/lib/settings";
import { SENS_TRANSFERT } from "@/lib/valeurs";
import {
  Champ,
  ChampCache,
  FormulaireAction,
  Selection,
} from "@/components/formulaires";
import { Badge, Carte, CarteEtat, EnTeteEcran, GroupeReplie, Vide } from "@/components/ui";
import { Panneau } from "@/components/panneau";
import { MenuLigne } from "@/components/menu-ligne";
import {
  EcranInitialisation,
  estTableAbsente,
} from "@/components/initialisation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Titres" };

export default async function PageCompteTitres() {
  const membre = await exigerMembre();

  let apports, s, caisse;
  try {
    [apports, s, caisse] = await Promise.all([
      listerApports(),
      synthese(),
      listerMouvementsCaisse().catch(() => []),
    ]);
  } catch (e) {
    if (estTableAbsente(e)) return <EcranInitialisation detail={String(e)} />;
    throw e;
  }

  const peutSaisir = peut(membre, "gererCompteTitres");
  const entrees = apports.filter((a) => a.sens !== SENS_TRANSFERT.sortie);
  const sorties = apports.filter((a) => a.sens === SENS_TRANSFERT.sortie);

  /*
   * Les frais se payent de deux facons : retenus a l'arrivee sur le virement, ou
   * regles depuis la caisse. Les cumuler des deux sources donne le seul chiffre
   * qui compte -- ce que la SGI et la banque ont coute au club.
   */
  const fraisRetenus = apports.reduce((t, a) => t + a.frais, 0);
  const fraisPayesEnCaisse = caisse
    .filter(
      (m) =>
        m.statut === "valide" &&
        m.sens === "depense" &&
        (m.categorie === "frais_sgi" || m.categorie === "frais_bancaires"),
    )
    .reduce((t, m) => t + m.montant, 0);
  const fraisTotaux = fraisRetenus + fraisPayesEnCaisse;
  const netInvesti = s.totalApports - fraisRetenus;

  const ligneMouvement = (a: (typeof apports)[number]) => {
    const sortie = a.sens === SENS_TRANSFERT.sortie;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
        <div className="min-w-0">
          {/*
           * Un mouvement a zero franc n'est pas un virement : c'est un
           * prelevement de frais dans le compte-titres. L'afficher
           * « + 0 FCFA » le ferait passer pour une saisie ratee.
           */}
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {a.montant === 0 ? (
              <>
                - {fcfa(a.frais)}
                <Badge ton="rouge">Frais</Badge>
              </>
            ) : (
              <>
                {sortie ? "-" : "+"} {fcfa(a.montant)}
                {sortie && <Badge ton="ambre">Retrait</Badge>}
              </>
            )}
          </p>
          <p className="text-xs" style={{ color: "var(--discret)" }}>
            {dateCourte(a.date_transfert)}
            {a.montant === 0
              ? " · preleves dans le compte-titres"
              : a.frais > 0
                ? ` · dont ${fcfa(a.frais)} de frais`
                : ""}
            {a.saisi_par_nom ? ` · ${a.saisi_par_nom}` : ""}
            {a.note ? ` · ${a.note}` : ""}
          </p>
        </div>
        {/*
         * Une saisie fautive restait a jamais : il fallait lui opposer
         * un mouvement inverse, qui decrivait a son tour un virement
         * n'ayant pas eu lieu. La ligne passe au journal avant d'etre
         * effacee -- la trace survit a la donnee.
         */}
        {peutSaisir && (
          <MenuLigne
            etiquette={`Actions sur le mouvement du ${dateCourte(a.date_transfert)}`}
            actions={[
              {
                libelle: "Supprimer ce mouvement",
                action: supprimerApport,
                champs: <ChampCache nom="id" valeur={a.id} />,
                confirmation:
                  "Supprimer ce mouvement ? Il disparaitra des comptes ; le journal en gardera le detail et votre nom.",
                confirmer: "Supprimer",
              },
            ]}
          />
        )}
      </div>
    );
  };

  const datesSorties = sorties.map((a) => a.date_transfert).sort();

  const saisie = peutSaisir ? (
    <Panneau
      libelle="Enregistrer un mouvement"
      titre="Mouvement vers la SGI"
      introduction="L'art. 14 confie la transmission des ordres au president, le bureau agissant par delegation : votre saisie vaut enregistrement, sans validation par un tiers."
    >
        <FormulaireAction action={enregistrerApport} libelle="Enregistrer">
          <Champ
            nom="dateApport"
            libelle="Date du virement"
            type="date"
            valeur={new Date().toISOString().slice(0, 10)}
          />
          <Champ
            nom="montant"
            libelle="Montant vire (FCFA)"
            type="number"
            min={0}
            aide="Ce qui quitte la caisse, frais compris. Zero pour n'inscrire que des frais."
          />
          <Champ
            nom="frais"
            libelle="Frais (FCFA)"
            type="number"
            min={0}
            valeur={0}
            requis={false}
            aide="Retenus a l'arrivee sur le virement, ou preleves seuls dans le compte-titres : laissez alors le montant a zero. Zero ici si les frais sont regles a part depuis la caisse."
          />
          <Selection
            nom="sens"
            libelle="Sens"
            valeur={SENS_TRANSFERT.entree}
            options={[
              {
                valeur: SENS_TRANSFERT.entree,
                libelle: "Apport — de la caisse vers la SGI",
              },
              {
                valeur: SENS_TRANSFERT.sortie,
                libelle: "Retrait — de la SGI vers la caisse",
              },
            ]}
          />
          <Champ nom="note" libelle="Note ou reference" requis={false} />
        </FormulaireAction>
    </Panneau>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <EnTeteEcran
          titre="Net place en bourse"
          sous={`chez ${CLUB.sgi}`}
          chiffre={nombre(s.totalApports)}
          unite="FCFA"
          detail="Apports vers la societe de gestion, diminues des retraits revenus en caisse."
        />
        <div className="sans-impression">{saisie}</div>
      </div>

      <CarteEtat
        chiffres={[
          { libelle: "Apports", valeur: nombre(entrees.reduce((t, a) => t + a.montant, 0)), unite: "FCFA" },
          { libelle: "Retraits", valeur: nombre(sorties.reduce((t, a) => t + a.montant, 0)), unite: "FCFA" },
          {
            libelle: "Frais supportes",
            valeur: nombre(fraisTotaux),
            unite: "FCFA",
            contexte: "Depot, SGI et banque",
          },
        ]}
      />

      {fraisTotaux > 0 && (
        <Carte titre="Ce que les frais ont coute">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between gap-2">
              <span style={{ color: "var(--discret)" }}>
                Retenus a l&apos;arrivee sur les virements
              </span>
              <span className="tabular-nums">{fcfa(fraisRetenus)}</span>
            </li>
            <li className="flex justify-between gap-2">
              <span style={{ color: "var(--discret)" }}>
                Regles depuis la caisse
              </span>
              <span className="tabular-nums">{fcfa(fraisPayesEnCaisse)}</span>
            </li>
            <li
              className="flex justify-between gap-2 border-t pt-1 font-semibold"
              style={{ borderColor: "var(--bordure)" }}
            >
              <span>Total supporte par le club</span>
              <span className="tabular-nums">{fcfa(fraisTotaux)}</span>
            </li>
          </ul>
          <p className="mt-3 text-[11px]" style={{ color: "var(--discret)" }}>
            Sur {fcfa(s.totalApports)} vires, {fcfa(netInvesti)} sont reellement
            arrives sur le compte-titres. Le TRI porte sur le montant vire,
            frais compris : ce sont des sommes engagees, et une performance qui
            les ignorerait flatterait sans rien vouloir dire.
          </p>
        </Carte>
      )}

      <Carte titre={`Historique (${apports.length})`}>
        {apports.length === 0 ? (
          <Vide>Aucun mouvement enregistre.</Vide>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--bordure)" }}>
            {entrees.map((a) => (
              <li key={a.id}>{ligneMouvement(a)}</li>
            ))}
            {/*
             * Les retraits sont rassembles en une ligne.
             *
             * Chacun est le pendant d'un apport du meme jour -- 1 % de frais
             * bancaires sur le virement -- et les intercaler doublait la liste
             * sans rien apprendre. Le total reste lisible sans ouvrir, et le
             * detail est a un doigt.
             */}
            {sorties.length > 0 && (
              <li>
                <GroupeReplie
                  libelle="Retraits"
                  nombre={sorties.length}
                  detail={`de ${dateCourte(datesSorties[0])} a ${dateCourte(datesSorties[datesSorties.length - 1])}`}
                  total={
                    <span style={{ color: "var(--etat-manque)" }}>
                      &minus; {fcfa(sorties.reduce((t, a) => t + a.montant, 0))}
                    </span>
                  }
                >
                  <ul
                    className="divide-y"
                    style={{ borderColor: "var(--bordure)" }}
                  >
                    {sorties.map((a) => (
                      <li key={a.id}>{ligneMouvement(a)}</li>
                    ))}
                  </ul>
                </GroupeReplie>
              </li>
            )}
          </ul>
        )}
      </Carte>
    </>
  );
}
