/**
 * ACOPIO VE — Service Worker
 * Cache-first para todos los assets (todos son locales, sin CDN).
 */

const CACHE = "acopio-ve-v2";

const ASSETS = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/config.js",
  "/js/api.js",
  "/js/map.js",
  "/js/app.js",
  "/lib/leaflet.js",
  "/lib/leaflet.css",
  "/lib/firebase-app.js",
  "/lib/firebase-database.js",
  "/lib/images/marker-icon.png",
  "/lib/images/marker-icon-2x.png",
  "/lib/images/marker-shadow.png",
  "/lib/images/layers.png",
  "/lib/images/layers-2x.png",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Firebase RTDB — siempre red (datos en tiempo real)
  if (url.hostname.includes("firebaseio.com") || url.hostname.includes("firebasedatabase.app")) {
    return; // sin interceptar
  }

  // Tiles OSM — network-first con fallback cache
  if (url.hostname.includes("tile.openstreetmap.org")) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Todo lo demás (assets locales) — cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => {
        if (e.request.mode === "navigate") return caches.match("/index.html");
      });
    })
  );
});
