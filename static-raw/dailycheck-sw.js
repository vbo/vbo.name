/*
 * Service worker for dailycheck.html.
 *
 * Jobs:
 *   1. Make the page installable / offline-capable (a precondition for the
 *      App Badging API to work on an iPhone home-screen web app).
 *   2. Where the platform supports Periodic Background Sync (Chromium on
 *      Android/desktop), re-evaluate the badge once a day even while the app
 *      is closed.
 *   3. Handle Web Push ("push" event). This is the only mechanism that updates
 *      the badge on a *locked, untouched* iPhone. A daily payload-less push
 *      (sent by dailycheck-push.gs) wakes this worker, which recomputes today's
 *      badge from IndexedDB and shows a notification. See dailycheck-push.gs.
 *
 * iOS/Safari does NOT support periodic background sync, so without push the
 * badge is refreshed by the page itself whenever the installed web app is
 * opened or brought to the foreground (see dailycheck.html).
 */

const CACHE = 'dailycheck-v3';
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
// The page writes today's badge count here; the worker reads it. The record is
// { date, badge, fullBadge } so the worker can tell a stale day apart from a
// fresh one (where nothing has been done yet and the full badge applies).
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

// How many things are still owed today, from the page's IndexedDB mirror.
// A stale record (date != today) means a fresh day where nothing is done yet,
// so everything is owed (fullBadge).
async function badgeCount() {
  const rec = await idbGet('today').catch(() => null);
  if (rec && rec.date === localDateKey()) return rec.badge || 0;
  if (rec) return rec.fullBadge || 0;
  return 0;
}

async function refreshBadge() {
  if (!self.navigator || !('setAppBadge' in self.navigator)) return 0;
  const count = await badgeCount();
  if (count > 0) {
    await self.navigator.setAppBadge(count).catch(() => {});
  } else {
    await self.navigator.clearAppBadge().catch(() => {});
  }
  return count;
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

// --- Web Push ---------------------------------------------------------------
// The daily push carries no payload (a "tickle"): we recompute the badge here
// and show a notification. iOS requires every push to show a user-visible
// notification, so we always call showNotification.
async function handlePush() {
  const count = await refreshBadge();
  const title = 'Daily Tracker';
  const body = count > 0
    ? 'You have ' + count + ' thing' + (count === 1 ? '' : 's') + ' to do today.'
    : 'All done for today \u2713';
  await self.registration.showNotification(title, {
    body: body,
    tag: 'dailycheck-daily',
    renotify: true,
    icon: './dailycheck-icon.svg',
    badge: './dailycheck-icon.svg',
    data: { url: './dailycheck.html' },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './dailycheck.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
