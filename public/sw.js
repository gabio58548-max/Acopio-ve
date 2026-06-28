/**
 * ACOPIO VE — Service Worker v19
 * Estrategia:
 *   - App (HTML/JS/CSS): NETWORK-FIRST → siempre código fresco
 *   - Librerías locales (Firebase SDK, iconos): CACHE-FIRST → carga rápida
 *   - CDN externas (MapLibre GL, QRCode): CACHE-FIRST → disponibles offline
 *   - Firebase RTDB y Storage: siempre red, nunca caché
 */

const CACHE = "acopio-ve-v19";

const CACHE_FIRST_LOCAL = [
  "/lib/firebase-app.js",
  "/lib/firebase-database.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.json"
];

// CDN externas que queremos cachear para uso offline
const CACHE_FIRST_CDN = [
  "https://unpkg.com/maplibre-gl@4.5.2/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@4.5.2/dist/maplibre-gl.css",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CACHE_FIRST_LOCAL))
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

  if (url.hostname !== self.location.hostname) {
    // CDN externas conocidas → cache-first (disponibles offline tras primera visita)
    if (CACHE_FIRST_CDN.includes(e.request.url)) {
      e.respondWith(
        caches.match(e.request).then(cached => cached ||
          fetch(e.request).then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
          })
        )
      );
    }
    // Resto de externos (Firebase RTDB, ESRI tiles, Nominatim): browser los maneja
    return;
  }

  const path = url.pathname;

  // Librerías locales pesadas — cache-first
  if (CACHE_FIRST_LOCAL.includes(path)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // Todo lo demás (index.html, app.js, map.js, style.css…) — NETWORK-FIRST
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && e.request.method === "GET") {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request)
        .then(cached => cached || (
          e.request.mode === "navigate"
            ? caches.match("/index.html")
            : new Response("Sin conexión", { status: 503 })
        ))
      )
  );
});
