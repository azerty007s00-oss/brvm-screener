"use client";

import { useEffect, useState } from "react";
import type { EtatFormulaire } from "@/app/actions/auth";
import { Icone } from "@/components/icones";
import { ecrireVoileAlertes } from "@/components/voile";
import { dateCourte } from "@/lib/settings";

type Etat = "chargement" | "indisponible" | "iphone" | "proposee" | "activee" | "bloquee";

/** La cle publique arrive en base64 sans remplissage ; le navigateur la veut en octets. */
function versOctets(base64: string): Uint8Array<ArrayBuffer> {
  const remplie = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const brut = atob(remplie);
  const octets = new Uint8Array(new ArrayBuffer(brut.length));
  for (let i = 0; i < brut.length; i++) octets[i] = brut.charCodeAt(i);
  return octets;
}

const principal = { background: "var(--accent)", color: "var(--sur-accent)" };
const secondaire = { background: "var(--page)", color: "var(--ink)", border: "1px solid var(--line-2)" };
const bouton =
  "tapable inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[14px] font-medium transition disabled:opacity-60";

/**
 * « Etre prevenu sur ce telephone » : la carte qui active les alertes.
 *
 * Les alertes valent pour un appareil, non pour un compte : le membre les
 * active sur son telephone, et l'ordinateur du bureau n'en recoit pas. La
 * carte dit donc toujours « ce telephone ». Elle prend quatre formes : la
 * proposition, l'etat actif (avec un essai), le refus du telephone (et comment
 * le lever) et, sur iPhone, la condition d'Apple : le site doit etre ouvert
 * depuis l'ecran d'accueil.
 */
export function CarteAlertes({
  clePublique,
  appareils,
  bureau,
  abonner,
  desabonner,
  essayer,
}: {
  clePublique: string;
  appareils: { endpoint: string; depuis: string }[];
  bureau: boolean;
  abonner: (brut: string) => Promise<EtatFormulaire>;
  desabonner: (endpoint: string) => Promise<EtatFormulaire>;
  essayer: () => Promise<EtatFormulaire>;
}) {
  const [etat, majEtat] = useState<Etat>("chargement");
  const [adresse, majAdresse] = useState<string | null>(null);
  const [occupe, majOccupe] = useState(false);
  const [retour, majRetour] = useState<{ ok: boolean; texte: string } | null>(null);

  useEffect(() => {
    let vivant = true;
    (async () => {
      const ios =
        /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const autonome =
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
      let suite: Etat;
      let endpoint: string | null = null;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        suite = ios && !autonome ? "iphone" : "indisponible";
      } else if (Notification.permission === "denied") {
        suite = "bloquee";
      } else {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const abonnement = await reg?.pushManager.getSubscription();
        endpoint = abonnement?.endpoint ?? null;
        suite =
          endpoint && Notification.permission === "granted" && appareils.some((a) => a.endpoint === endpoint)
            ? "activee"
            : "proposee";
      }
      if (!vivant) return;
      majAdresse(endpoint);
      majEtat(suite);
    })().catch(() => vivant && majEtat("indisponible"));
    return () => {
      vivant = false;
    };
  }, [appareils]);

  const activer = async () => {
    majOccupe(true);
    majRetour(null);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        majEtat(permission === "denied" ? "bloquee" : "proposee");
        return;
      }
      await ecrireVoileAlertes();
      const abonnement =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: versOctets(clePublique) }));
      const r = await abonner(JSON.stringify(abonnement));
      if (!r.ok) {
        majRetour({ ok: false, texte: r.erreur ?? "L'activation n'a pas abouti." });
        return;
      }
      majAdresse(abonnement.endpoint);
      majEtat("activee");
    } catch {
      majRetour({ ok: false, texte: "Le téléphone n'a pas pu s'inscrire aux alertes. Réessayez dans un instant." });
    } finally {
      majOccupe(false);
    }
  };

  const desactiver = async () => {
    majOccupe(true);
    majRetour(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const abonnement = await reg?.pushManager.getSubscription();
      const endpoint = abonnement?.endpoint ?? adresse;
      await abonnement?.unsubscribe();
      if (endpoint) await desabonner(endpoint);
      majAdresse(null);
      majEtat("proposee");
    } catch {
      majRetour({ ok: false, texte: "La désactivation n'a pas abouti : réessayez." });
    } finally {
      majOccupe(false);
    }
  };

  const essai = async () => {
    majOccupe(true);
    majRetour(null);
    const r = await essayer().catch(() => ({ ok: false, erreur: "L'essai n'a pas pu partir." }) as EtatFormulaire);
    majRetour(r.ok ? { ok: true, texte: r.message ?? "Alerte envoyée." } : { ok: false, texte: r.erreur ?? "Échec." });
    majOccupe(false);
  };

  if (etat === "chargement") return <div className="min-h-[148px] rounded-xl border" style={{ borderColor: "var(--line-2)" }} aria-hidden="true" />;

  const ici = appareils.find((a) => a.endpoint === adresse);
  const autres = appareils.length;

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-4" style={{ borderColor: "var(--line-2)", background: "var(--carte)" }}>
      {etat === "activee" ? (
        <>
          <div className="flex items-center gap-3">
            <span className="pastille pastille-ok grid h-9 w-9 flex-none place-items-center rounded-full" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 12.5 L10 16.5 L18 8" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold">Alertes activées sur ce téléphone</h3>
              <p className="mt-0.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                {ici ? `depuis le ${dateCourte(ici.depuis)}` : "activées à l'instant"}
                {autres > 1 ? ` · ${autres} appareils au total` : ""}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={bouton} style={secondaire} onClick={essai} disabled={occupe}>
              Envoyer un essai
            </button>
            <button type="button" className={bouton} style={secondaire} onClick={desactiver} disabled={occupe}>
              Désactiver
            </button>
          </div>
        </>
      ) : etat === "bloquee" ? (
        <div className="flex items-start gap-3">
          <span className="pastille pastille-attente grid h-9 w-9 flex-none place-items-center rounded-full" aria-hidden="true">
            <Icone.clocheBarree taille={18} trait={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold">Alertes bloquées par le téléphone</h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              Le refus a été donné au téléphone, pas au site : seul lui peut le lever. Ouvrez les réglages
              du navigateur ou du téléphone, rubrique Notifications, autorisez IP12, puis revenez ici.
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "var(--ink-2)" }}>
              Les courriels continuent d&apos;arriver comme avant.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <span className="pastille pastille-courrier grid h-9 w-9 flex-none place-items-center rounded-full" aria-hidden="true">
              <Icone.cloche taille={18} trait={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold">Être prévenu sur ce téléphone</h3>
              <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
                Quand le trésorier valide ou refuse un de vos versements, et la veille de l&apos;échéance si
                votre cotisation n&apos;est pas réglée.
              </p>
            </div>
          </div>
          <ul className="flex list-disc flex-col gap-1.5 pl-[66px] text-[13px]" style={{ color: "var(--ink-2)" }}>
            <li>Versement ou règlement validé, ou refusé avec son motif</li>
            <li>Échéance du mois, la veille au soir</li>
            {bureau && <li>Pour le bureau : chaque déclaration à valider</li>}
          </ul>
          {etat === "proposee" && (
            <button type="button" className={`${bouton} min-h-12 text-[15px]`} style={principal} onClick={activer} disabled={occupe}>
              {occupe && <span className="rouet" aria-hidden="true" />}
              {occupe ? "Activation en cours" : "Activer les alertes"}
            </button>
          )}
          {etat === "iphone" && (
            <p className="rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed" style={{ background: "var(--sunk)", color: "var(--ink-2)" }}>
              <span className="font-semibold" style={{ color: "var(--ink)" }}>
                Sur iPhone
              </span>{" "}
              : ajoutez d&apos;abord IP12 à l&apos;écran d&apos;accueil (Partager, puis « Sur l&apos;écran
              d&apos;accueil »), ouvrez-le depuis l&apos;icône, puis revenez ici.
            </p>
          )}
          {etat === "indisponible" && (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              Ce navigateur ne sait pas recevoir d&apos;alertes. Les courriels continuent d&apos;arriver comme avant.
            </p>
          )}
        </>
      )}
      {retour && (
        <p className="text-[13px]" role={retour.ok ? "status" : "alert"} style={{ color: retour.ok ? "var(--etat-ok)" : "var(--etat-manque)" }}>
          {retour.texte}
        </p>
      )}
    </div>
  );
}
