// sw.js — Service Worker
//
// PLACEHOLDER: In Phase 5 (siehe CLAUDE.md) ausbauen:
// - Cache-First-Strategie fuer App-Shell
// - Update-Prompt bei neuer Version
// - Offline-Fallback

const CACHE_NAME = "enkephalos-recorder-v9";
const APP_SHELL = [
  "./index.html",
  "./app.js",
  "./recorder.js",
  "./gemini.js",
  "./drive.js",
  "./styles.css",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Auf localhost/127.0.0.1 nutzen wir Network-First, damit Dev-Aenderungen
// sofort durchschlagen. Auf Produktion (z.B. GitHub Pages) bleibt es Cache-First
// fuer Offline-Tauglichkeit.
const IS_DEV = self.location.hostname === "localhost"
  || self.location.hostname === "127.0.0.1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (IS_DEV) {
    // Network-First, mit Cache als Offline-Fallback.
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Produktion: Cache-First
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
