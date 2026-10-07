/// <reference lib="webworker" />
import { runSync } from '@fieldforms/shared';
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { currentOwnerId, dexieOutboxStore } from './offline/db';
import { SYNC_TAG } from './offline/sync';
import { fetchTransport } from './offline/transport';

declare const self: ServiceWorkerGlobalScope;

// The app shell (HTML, JS, CSS, icons) is precached, so the app opens with no signal at all.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Every in-app URL serves the cached index.html; the API is never cached or intercepted.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

self.skipWaiting();
clientsClaim();

interface SyncEvent extends ExtendableEvent {
  tag: string;
}

// Background Sync (Chrome on Android): the browser wakes us when connectivity returns, even if the
// app is closed. The same engine as the page, the same IndexedDB outbox; idempotent ids make any
// overlap with a page-side run harmless.
self.addEventListener('sync', ((event: SyncEvent) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(
      (async () => {
        const owner = await currentOwnerId();
        if (!owner) return;
        const r = await runSync({ store: dexieOutboxStore(owner), transport: fetchTransport(self.location.origin) });
        // Ask the browser to try again later (with its own backoff) if anything is still pending.
        if (r.retrying > 0) throw new Error('outbox not empty');
      })(),
    );
  }
}) as EventListener);
