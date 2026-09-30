"use client";

import { useState, type ReactNode } from "react";
import { Carte, EnTeteEcran } from "@/components/ui";
import { CourbePortefeuille } from "@/components/courbe";
import { dateCourte, nombre } from "@/lib/settings";
import { couleurSigne, pourcent } from "@/lib/perf";
import type { Trace } from "@/lib/placement";

/**
 * Le haut de la page Portefeuille : le chiffre, les cles, et la courbe.
 *
 * POURQUOI CES TROIS BLOCS PARTAGENT UN COMPOSANT. Au survol du graphique, le
 * heros suit : il cesse d'annoncer le dernier releve pour annoncer celui qu'on
 * pointe. Il faut donc que le chiffre du haut et la courbe du bas partagent un
 * meme etat, ce qu'ils ne peuvent pas faire depuis une page rendue au serveur.
 *
 * Le bandeau de chiffres, lui, ne bouge pas : il arrive en `enfants`, rendu par
 * le serveur, et traverse ce composant sans devenir du code client. C'est ce
 * qui evite d'emporter toute la page dans le navigateur pour une ligne d'etat.
 */
export function TetePortefeuille({
  sgi,
  derniere,
  precedente,
  points,
  gainExercice,
  saisie,
  actionCarte,
  enfants,
}: {
  sgi: string;
  derniere: { date: string; total: number; actions: number; liquidites: number } | null;
  precedente: { date: string; total: number } | null;
  points: Trace[];
  gainExercice: number | null;
  saisie: ReactNode;
  actionCarte: ReactNode;
  enfants: ReactNode;
}) {
  const [vise, setVise] = useState<Trace | null>(null);

  const ecart = derniere && precedente ? derniere.total - precedente.total : null;
  const variation =
    derniere && precedente && precedente.total !== 0
      ? (derniere.total - precedente.total) / precedente.total
      : null;

  /*
   * Sous le doigt, la sous-ligne dit la composition du releve vise et le gain
   * de gestion cumule a cette date -- valeur moins net place.
   *
   * « DEPUIS L'OUVERTURE » est dit en toutes lettres : la ligne sous le
   * graphique porte, elle, le gain de la periode choisie, et les deux se
   * lisaient « gain de gestion » sans plus de precision. Au 30/06/2026 on
   * passait ainsi de 1 092 828 a 1 007 802 en levant le doigt, comme si l'ete
   * avait coute 85 026 FCFA au club.
   */
  const detailVise = vise ? (
    <>
      {vise.actions !== undefined && vise.liquidites !== undefined ? (
        <>
          Actions {nombre(vise.actions)} &middot; liquidites {nombre(vise.liquidites)} &middot;{" "}
        </>
      ) : null}
      <span className="font-medium" style={{ color: couleurSigne(vise.valeur - vise.netPlace) }}>
        {vise.valeur - vise.netPlace >= 0 ? "+" : "−"}
        {nombre(Math.abs(vise.valeur - vise.netPlace))} FCFA
      </span>{" "}
      de gain de gestion depuis l&apos;ouverture.
    </>
  ) : null;

  const detailCourant =
    ecart !== null && variation !== null && precedente ? (
      <>
        <span className="font-medium" style={{ color: couleurSigne(ecart) }}>
          {ecart >= 0 ? "+" : "−"}
          {nombre(Math.abs(ecart))} FCFA ({pourcent(variation)})
        </span>{" "}
        depuis le releve du {dateCourte(precedente.date)}.
      </>
    ) : (
      `Compte-titres tenu chez ${sgi}.`
    );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <EnTeteEcran
          titre="Valeur du portefeuille"
          sous={
            vise
              ? `au releve du ${dateCourte(vise.date)}`
              : derniere
                ? `au ${dateCourte(derniere.date)}`
                : "— aucun releve saisi"
          }
          chiffre={vise || derniere ? undefined : "--"}
          brut={vise ? vise.valeur : (derniere?.total ?? undefined)}
          unite={vise || derniere ? "FCFA" : undefined}
          detail={detailVise ?? detailCourant}
        />
        <div className="sans-impression">{saisie}</div>
      </div>

      {enfants}

      <Carte titre="Valeur relevee" action={actionCarte}>
        <CourbePortefeuille
          points={points}
          gainExercice={gainExercice}
          surVise={setVise}
        />
      </Carte>
    </>
  );
}
