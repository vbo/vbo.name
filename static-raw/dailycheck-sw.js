/*
 * Service worker for dailycheck.html.
 *
 * Two jobs:
 *   1. Make the page installable / offline-capable (a precondition for the
 *      App Badging API to work on an iPhone home-screen web app).
 *   2. Where the platform supports Periodic Background Sync (Chromium on
 *      Android/desktop), re-evaluate the badge once a day even while the app
 *      is closed: badge stays lit until the day's box is ticked.
 *
 * iOS/Safari does NOT support periodic background sync, so there the badge is
 * refreshed by the page itself whenever the installed web app is opened or
 * brought to the foreground (see dailycheck.html). That is the realistic
 * iPhone behaviour: the badge reflects the state as of the last time the app
 * ran, and a new day's unticked box re-lights it the next time you open it.
 */

const CACHE = 'dailycheck-v1';
const ASSETS = [
  './dailycheck.html',
  './dailycheck.webmanifest',
  './dailycheck-icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).catch(() => caches.match('./dailycheck.html')))
  );
});

// --- Shared state in IndexedDB (localStorage is unavailable in a worker) ---
// The page writes the last date the box was ticked here; the worker reads it.
const DB_NAME = 'dailycheck';
const STORE = 'state';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function localDateKey(d = new Date()) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

async function refreshBadge() {
  if (!self.navigator || !('setAppBadge' in self.navigator)) return;
  const lastChecked = await idbGet('lastCheckedDate').catch(() => null);
  if (lastChecked === localDateKey()) {
    await self.navigator.clearAppBadge().catch(() => {});
  } else {
    await self.navigator.setAppBadge(1).catch(() => {});
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'dailycheck-refresh') {
    event.waitUntil(refreshBadge());
  }
});

// Lets the page nudge the worker to recompute (e.g. right after a toggle).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'refresh-badge') {
    event.waitUntil(refreshBadge());
  }
});
