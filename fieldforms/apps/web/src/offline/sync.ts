import { runSync, type SyncReport } from '@fieldforms/shared/sync';
import { currentOwnerId, dexieOutboxStore, pruneSynced, requeue } from './db';
import { fetchTransport } from './transport';

export const SYNC_TAG = 'ff-outbox';

type Listener = (state: SyncState) => void;
export interface SyncState {
  running: boolean;
  lastRun: number | null;
  lastReport: SyncReport | null;
  authRequired: boolean;
}

let state: SyncState = { running: false, lastRun: null, lastReport: null, authRequired: false };
const listeners = new Set<Listener>();
let inFlight: Promise<SyncReport> | null = null;
let rerun = false;
let forceNext = false;

function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function getSyncState(): SyncState {
  return state;
}

export function subscribeSync(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Drains the outbox once. Calls made while a run is in progress coalesce into one follow-up run,
 * so a burst of triggers (online + visibility + new item) does not start parallel runs in this tab.
 */
export function syncNow(opts: { now?: boolean } = {}): Promise<SyncReport> {
  if (inFlight) {
    rerun = true;
    if (opts.now) forceNext = true;
    return inFlight;
  }
  set({ running: true });
  inFlight = (async () => {
    const owner = await currentOwnerId();
    let report: SyncReport = {
      attempted: 0,
      synced: 0,
      retrying: 0,
      failed: 0,
      authRequired: false,
    };
    // With no connection every attempt fails at once; skipping keeps the backoff for real server
    // trouble rather than growing it while the phone has no signal.
    if (!owner || !navigator.onLine) return report;
    if (opts.now) forceNext = true;
    do {
      rerun = false;
      if (forceNext) {
        // Connectivity just came back, or the user asked: retry now instead of waiting out the backoff.
        forceNext = false;
        await requeue((i) => i.status === 'pending' && i.ownerId === owner);
      }
      report = await runSync({ store: dexieOutboxStore(owner), transport: fetchTransport() });
    } while (rerun && !report.authRequired);
    await pruneSynced().catch(() => {});
    return report;
  })();
  inFlight
    .then((report) =>
      set({
        running: false,
        lastRun: Date.now(),
        lastReport: report,
        authRequired: report.authRequired,
      }),
    )
    .catch(() => set({ running: false, lastRun: Date.now() }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Asks the browser to sync for us when connectivity returns, even if the app is closed (Android). */
async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (
      reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }
    )?.sync;
    await sync?.register(SYNC_TAG);
  } catch {
    // Not supported (iOS Safari, Firefox): the triggers below cover it while the app is open.
  }
}

export function requestSync(): void {
  void syncNow({ now: true });
  void registerBackgroundSync();
}

let started = false;
/** Wires up every trigger: reconnect, app shown again, a periodic timer, and the start itself. */
export function startSyncTriggers(intervalMs = 30_000): void {
  if (started) return;
  started = true;
  window.addEventListener('online', () => void syncNow({ now: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  setInterval(() => {
    if (navigator.onLine) void syncNow();
  }, intervalMs);
  void syncNow();
}
