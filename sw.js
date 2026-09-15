// Son Frekans — Service Worker (cache-first, tam çevrimdışı destek)
const CACHE = "son-frekans-v1";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./game.js",
  "./deck.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./images/ali_kayra.jpg",
  "./images/archive_tape.jpg",
  "./images/buse.jpg",
  "./images/ceylan.jpg",
  "./images/fisilti.jpg",
  "./images/mert.jpg",
  "./images/radio_caller.jpg",
  "./images/selin.jpg",
  "./images/serkan.jpg",
  "./images/station_cabin.jpg",
  "./audio/menu.mp3",
  "./audio/gameplay.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first: önce önbellekten ver, yoksa ağdan çekip önbelleğe ekle.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
