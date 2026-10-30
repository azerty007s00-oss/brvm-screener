"use client";

import { useEffect, useSyncExternalStore } from "react";
import { noterFuseau } from "@/app/actions/fuseau";
import { heureChezSoi } from "@/lib/fuseaux";

/**
 * Releve le fuseau du navigateur, une fois par appareil et par membre, et a
 * chaque changement : le membre qui part de Paris pour Abidjan recoit la
 * convocation suivante a la bonne heure.
 */
export function FuseauAuto({ membreId }: { membreId: string }) {
  useEffect(() => {
    try {
      const fuseau = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const cle = `ip12-fuseau:${membreId}`;
      if (!fuseau || localStorage.getItem(cle) === fuseau) return;
      noterFuseau(fuseau)
        .then((ok) => {
          if (ok) localStorage.setItem(cle, fuseau);
        })
        .catch(() => {});
    } catch {
      // Navigation privee, stockage bloque : l'heure reste dite en GMT.
    }
  }, [membreId]);
  return null;
}

/** Le fuseau du navigateur ne change pas sous les yeux : rien a ecouter. */
const sansAbonnement = () => () => {};

function chezCeNavigateur(instant: string): string | null {
  try {
    return heureChezSoi(new Date(instant), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * « soit 22 h chez vous » sous une heure GMT, calcule par le navigateur : rien
 * a l'heure d'Abidjan. Le serveur, qui ne connait pas le fuseau du lecteur,
 * rend un vide, et le navigateur complete apres l'hydratation.
 */
export function HeureChezVous({ instant, avant = "soit ", apres = " chez vous" }: { instant: string; avant?: string; apres?: string }) {
  const texte = useSyncExternalStore(sansAbonnement, () => chezCeNavigateur(instant), () => null);
  return texte ? <>{`${avant}${texte}${apres}`}</> : null;
}
