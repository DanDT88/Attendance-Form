// Bumped from v1 because the app moved from index.html to attendance.html:
// a returning device must drop the old shell or it keeps serving the previous
// index.html (the app) in place of the new landing page.
const CACHE_NAME = 'attendance-portal-v2';
const ASSETS = [
  './',
  './index.html',        // landing page
  './attendance.html',   // the supervisor app (was index.html)
  './admin.html',
  './config.js',
  './manifest.json'
];
// icon-192.png and icon-512.png used to be listed here but have never existed
// in this repo. cache.addAll is atomic, so those two 404s were failing the
// whole install — meaning the app shell was never actually being cached and
// offline mode was relying on the plain HTTP cache.
 
// APPS_SCRIPT_URL comes from the same config.js the pages use, so the service
// worker can never drift onto a different deployment than the app — which is
// exactly what had happened before: this file and index.html pointed at two
// different ones. importScripts runs in the worker's global scope, so the
// const declared in config.js is visible here.
importScripts('./config.js');
const DB_NAME = 'AttendanceOfflineDB';
const STORE_NAME = 'queue';
 
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});
 
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
 
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
 
  // Never intercept calls to the Apps Script API — those must always hit the network
  if (url.includes('script.google.com') || url.includes('googleusercontent.com')) return;
 
  // Only handle GET requests for the app shell; let everything else pass through normally
  if (event.request.method !== 'GET') return;
 
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline — fall back to cache
      return cached || networkFetch;
    })
  );
});
 
/**
 * Background Sync — Chrome/Android only (Safari/iOS has no Background Sync API,
 * so this handler simply never fires there; those devices still sync fine the
 * next time the app is opened while online).
 * The browser calls this on its own schedule once it detects connectivity,
 * even if the app tab/installed PWA is fully closed.
 */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-attendance') {
    event.waitUntil(syncQueue());
  }
});
 
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
 
function getAllItems(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
 
function deleteItem(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
 
async function syncQueue() {
  const db = await openDB();
  const items = await getAllItems(db);
  for (const item of items) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: item.action, ...item.data })
      });
      const json = await res.json();
      if (json && json.status === 'Error') throw new Error(json.message);
      await deleteItem(db, item.id);
    } catch (err) {
      // still failing (offline, or a real API error) — leave it queued, browser retries on its own schedule
    }
  }
}
 
