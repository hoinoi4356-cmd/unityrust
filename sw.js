/* Kill switch for the old UNITY RUST PWA service worker.
   The PWA was removed from index.html. This file stays at /sw.js so that
   browsers with an existing registration can fetch the update, drop all
   cached copies of the site and unregister the worker itself. */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      const clients = await self.clients.matchAll({ type: "window" });
      await self.registration.unregister();
      clients.forEach((client) => {
        try { client.navigate(client.url); } catch (error) {}
      });
    })()
  );
});
