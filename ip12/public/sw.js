/*
 * Le service du site sur le telephone : il recoit les alertes et les affiche.
 *
 * Il ne fait rien d'autre. Aucune page n'est mise en cache ici : le site reste
 * servi par le serveur a chaque visite, comme avant, et un deploiement se voit
 * aussitot. Un service qui intercepterait les pages devrait etre tenu a jour a
 * chaque version ; celui-ci n'a pas a l'etre.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* Le voile des montants, tel que la page l'a pose (components/voile.tsx). */
async function voileActif() {
  try {
    const reponse = await (await caches.open("ip12-preferences")).match("/__voile");
    return reponse ? (await reponse.text()) === "1" : false;
  } catch {
    return false;
  }
}

self.addEventListener("push", (evenement) => {
  let a = {};
  try {
    a = evenement.data ? evenement.data.json() : {};
  } catch {
    a = { corps: evenement.data ? evenement.data.text() : "" };
  }
  evenement.waitUntil(
    (async () => {
      const voile = await voileActif();
      await self.registration.showNotification(a.titre || "IP12", {
        body: voile && a.corpsVoile ? a.corpsVoile : a.corps || "",
        icon: "/icone-192.png",
        badge: "/badge-alerte.png",
        lang: "fr",
        tag: a.etiquette || undefined,
        renotify: Boolean(a.etiquette),
        data: { url: a.url || "/" },
      });
    })(),
  );
});

/* Un toucher ouvre la page de l'alerte : dans le site deja ouvert s'il l'est. */
self.addEventListener("notificationclick", (evenement) => {
  evenement.notification.close();
  const cible = new URL((evenement.notification.data && evenement.notification.data.url) || "/", self.location.origin).href;
  evenement.waitUntil(
    (async () => {
      const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const f of fenetres) {
        if (new URL(f.url).origin === self.location.origin && "focus" in f) {
          await f.focus();
          return "navigate" in f ? f.navigate(cible) : undefined;
        }
      }
      return self.clients.openWindow(cible);
    })(),
  );
});
