/**
 * The offline outbox sync engine.
 *
 * Deliberately free of browser APIs: storage, network and time are injected, so the same code
 * runs in the page, in the service worker (Background Sync on Android) and in unit tests.
 *
 * Correctness rests on two properties:
 *  1. Every item carries a client-generated UUID that the server treats as an idempotency key,
 *     so sending an item twice (a lost response, two tabs, the page and the service worker racing)
 *     stores it once.
 *  2. Items are claimed with a lease before sending, so concurrent runners rarely double-send,
 *     and a runner that dies mid-send (tab closed) does not strand the item: the lease expires.
 */

export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'auth_required';

export interface OutboxItem {
  id: string;
  /** What kind of record this is; decides which endpoint receives it. */
  type: 'register';
  /** The record without `deviceSentAt`, which is stamped on each attempt. */
  payload: Record<string, unknown>;
  blobIds: string[];
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms before which the item is not retried. */
  nextAttemptAt: number;
  /** Epoch ms when a `syncing` claim lapses. */
  leaseUntil: number;
  lastError: string | null;
  createdAt: number;
  syncedAt: number | null;
  /** Short human summary for the outbox screen, e.g. "Start register · Site A · 12 staff". */
  label: string;
  /**
   * The user who captured it. Only that user's session may send it, so a register captured by one
   * supervisor is never uploaded under another's name on a shared phone.
   */
  ownerId?: string;
}

export interface StoredBlob {
  data: Blob | Uint8Array;
  contentType: string;
}

export interface OutboxStore {
  /**
   * Atomically claims items that are due: `pending` with `nextAttemptAt <= now`, or `syncing` whose
   * lease has lapsed. Claimed items are set to `syncing` with `leaseUntil = now + leaseMs` and
   * returned oldest first.
   */
  claimDue(now: number, leaseMs: number): Promise<OutboxItem[]>;
  update(id: string, patch: Partial<OutboxItem>): Promise<void>;
  getBlob(id: string): Promise<StoredBlob | undefined>;
  /** Blobs are only needed until their item is synced. */
  deleteBlob(id: string): Promise<void>;
}

export type TransportResult =
  { ok: true } | { ok: false; kind: 'retryable' | 'auth' | 'permanent'; message: string };

export interface SyncTransport {
  putBlob(id: string, blob: StoredBlob): Promise<TransportResult>;
  postItem(item: OutboxItem, deviceSentAt: string): Promise<TransportResult>;
}

export interface SyncOptions {
  store: OutboxStore;
  transport: SyncTransport;
  now?: () => number;
  random?: () => number;
  leaseMs?: number;
}

export interface SyncReport {
  attempted: number;
  synced: number;
  retrying: number;
  failed: number;
  authRequired: boolean;
}

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
// Short, because a reload mid-upload leaves the item claimed until the lease lapses, and a double
// send after a lapsed lease is harmless (the server de-duplicates on the item id).
export const DEFAULT_LEASE_MS = 30_000;

/**
 * Exponential backoff with "equal jitter": half the window is fixed, half random. Full jitter can
 * produce near-zero delays that hammer a struggling server; no jitter makes every phone on a site
 * retry in lockstep when signal returns.
 */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const { store, transport } = opts;

  const report: SyncReport = {
    attempted: 0,
    synced: 0,
    retrying: 0,
    failed: 0,
    authRequired: false,
  };
  const items = await store.claimDue(now(), leaseMs);

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    report.attempted++;
    const result = await sendItem(item, store, transport, now);

    if (result.ok) {
      await store.update(item.id, {
        status: 'synced',
        syncedAt: now(),
        lastError: null,
        leaseUntil: 0,
      });
      for (const blobId of item.blobIds) await store.deleteBlob(blobId);
      report.synced++;
      continue;
    }

    if (result.kind === 'auth') {
      // The session has expired. Every remaining item would fail the same way, so release them
      // all untouched and stop; the app asks the user to sign in again, then resumes.
      report.authRequired = true;
      await store.update(item.id, {
        status: 'auth_required',
        lastError: result.message,
        leaseUntil: 0,
      });
      for (const rest of items.slice(i + 1)) {
        await store.update(rest.id, { status: 'auth_required', leaseUntil: 0 });
      }
      break;
    }

    const attempts = item.attempts + 1;
    if (result.kind === 'permanent') {
      // The server rejected the content itself (validation, permission). Retrying cannot help,
      // so park it visibly with the reason. It is never discarded.
      await store.update(item.id, {
        status: 'failed',
        attempts,
        lastError: result.message,
        leaseUntil: 0,
      });
      report.failed++;
    } else {
      await store.update(item.id, {
        status: 'pending',
        attempts,
        lastError: result.message,
        nextAttemptAt: now() + backoffDelay(attempts, random),
        leaseUntil: 0,
      });
      report.retrying++;
    }
  }
  return report;
}

async function sendItem(
  item: OutboxItem,
  store: OutboxStore,
  transport: SyncTransport,
  now: () => number,
): Promise<TransportResult> {
  try {
    for (const blobId of item.blobIds) {
      const blob = await store.getBlob(blobId);
      // Already uploaded and cleaned up on an earlier attempt that synced the blob but not the item.
      if (!blob) continue;
      const r = await transport.putBlob(blobId, blob);
      if (!r.ok) return r;
    }
    return await transport.postItem(item, new Date(now()).toISOString());
  } catch (err) {
    // A thrown error (fetch rejecting while offline) is always worth retrying.
    return {
      ok: false,
      kind: 'retryable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Maps an HTTP status from the API to how the engine should treat it. */
export function classifyHttpStatus(status: number): TransportResult {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401)
    return { ok: false, kind: 'auth', message: 'Signed out — sign in again to sync' };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { ok: false, kind: 'retryable', message: `Server busy (${status})` };
  }
  return { ok: false, kind: 'permanent', message: `Rejected by server (${status})` };
}
