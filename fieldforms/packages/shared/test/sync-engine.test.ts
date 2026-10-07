import { describe, expect, it } from 'vitest';
import {
  BACKOFF_CAP_MS,
  backoffDelay,
  classifyHttpStatus,
  runSync,
  type OutboxItem,
  type OutboxStore,
  type StoredBlob,
  type SyncTransport,
  type TransportResult,
} from '../src/sync/engine.js';

/** In-memory store with the same claim semantics the IndexedDB store implements. */
class MemoryStore implements OutboxStore {
  items = new Map<string, OutboxItem>();
  blobs = new Map<string, StoredBlob>();

  add(partial: Partial<OutboxItem> & { id: string }): void {
    this.items.set(partial.id, {
      type: 'register',
      payload: { id: partial.id },
      blobIds: [],
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      leaseUntil: 0,
      lastError: null,
      createdAt: this.items.size,
      syncedAt: null,
      label: partial.id,
      ...partial,
    });
  }

  async claimDue(now: number, leaseMs: number): Promise<OutboxItem[]> {
    const due = [...this.items.values()]
      .filter(
        (i) =>
          (i.status === 'pending' && i.nextAttemptAt <= now) ||
          (i.status === 'syncing' && i.leaseUntil < now),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const i of due) Object.assign(i, { status: 'syncing', leaseUntil: now + leaseMs });
    return due.map((i) => ({ ...i }));
  }

  async update(id: string, patch: Partial<OutboxItem>): Promise<void> {
    Object.assign(this.items.get(id)!, patch);
  }

  async getBlob(id: string) {
    return this.blobs.get(id);
  }

  async deleteBlob(id: string) {
    this.blobs.delete(id);
  }
}

/** A fake server that stores items by id, like the real idempotent endpoint. */
class FakeServer implements SyncTransport {
  stored = new Map<string, OutboxItem>();
  blobs = new Set<string>();
  posts = 0;
  /** Queue of scripted outcomes for postItem; when empty the request succeeds. */
  script: Array<TransportResult | 'throw' | 'store-then-lose-response'> = [];
  sentAt: string[] = [];

  async putBlob(id: string): Promise<TransportResult> {
    this.blobs.add(id);
    return { ok: true };
  }

  async postItem(item: OutboxItem, deviceSentAt: string): Promise<TransportResult> {
    this.posts++;
    this.sentAt.push(deviceSentAt);
    const next = this.script.shift();
    if (next === 'throw') throw new TypeError('Failed to fetch');
    if (next === 'store-then-lose-response') {
      this.stored.set(item.id, item);
      throw new TypeError('Network connection lost');
    }
    if (next && !next.ok) return next;
    this.stored.set(item.id, item);
    return { ok: true };
  }
}

describe('backoff', () => {
  it('grows exponentially with jitter and is capped', () => {
    const lo = () => 0;
    const hi = () => 1;
    expect(backoffDelay(1, lo)).toBe(1000);
    expect(backoffDelay(1, hi)).toBe(2000);
    expect(backoffDelay(4, hi)).toBe(16_000);
    expect(backoffDelay(50, hi)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelay(50, lo)).toBe(BACKOFF_CAP_MS / 2);
  });
});

describe('classifyHttpStatus', () => {
  it('maps statuses to retry behaviour', () => {
    expect(classifyHttpStatus(201)).toEqual({ ok: true });
    expect(classifyHttpStatus(401)).toMatchObject({ kind: 'auth' });
    expect(classifyHttpStatus(429)).toMatchObject({ kind: 'retryable' });
    expect(classifyHttpStatus(503)).toMatchObject({ kind: 'retryable' });
    expect(classifyHttpStatus(400)).toMatchObject({ kind: 'permanent' });
    expect(classifyHttpStatus(403)).toMatchObject({ kind: 'permanent' });
  });
});

describe('runSync', () => {
  it('sends pending items, uploads their blobs first and cleans up blobs', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    store.blobs.set('b1', { data: new Uint8Array([1]), contentType: 'image/jpeg' });
    store.add({ id: 'a', blobIds: ['b1'] });

    const r = await runSync({ store, transport: server, now: () => 1000 });

    expect(r).toMatchObject({ attempted: 1, synced: 1 });
    expect(server.blobs.has('b1')).toBe(true);
    expect(server.stored.has('a')).toBe(true);
    expect(store.items.get('a')!.status).toBe('synced');
    expect(store.blobs.has('b1')).toBe(false);
  });

  it('stamps deviceSentAt fresh on every attempt', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    server.script = ['throw'];
    store.add({ id: 'a' });
    let t = 10_000;
    await runSync({ store, transport: server, now: () => t, random: () => 0 });
    t = 100_000;
    await runSync({ store, transport: server, now: () => t, random: () => 0 });
    expect(server.sentAt).toEqual([
      new Date(10_000).toISOString(),
      new Date(100_000).toISOString(),
    ]);
  });

  it('keeps an item queued while offline and backs off between attempts', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    server.script = ['throw', 'throw'];
    store.add({ id: 'a' });

    let t = 0;
    const now = () => t;
    await runSync({ store, transport: server, now, random: () => 0 });
    expect(store.items.get('a')).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 1000,
    });

    // Not due yet: nothing is attempted.
    t = 500;
    expect((await runSync({ store, transport: server, now })).attempted).toBe(0);

    t = 1000;
    await runSync({ store, transport: server, now, random: () => 0 });
    expect(store.items.get('a')).toMatchObject({
      status: 'pending',
      attempts: 2,
      nextAttemptAt: 3000,
    });

    t = 3000;
    await runSync({ store, transport: server, now });
    expect(store.items.get('a')!.status).toBe('synced');
    expect(server.stored.size).toBe(1);
  });

  it('a lost response leads to a retry that the idempotent server stores once', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    server.script = ['store-then-lose-response'];
    store.add({ id: 'a' });

    let t = 0;
    await runSync({ store, transport: server, now: () => t, random: () => 0 });
    expect(store.items.get('a')!.status).toBe('pending');
    t = 10_000;
    await runSync({ store, transport: server, now: () => t });

    expect(server.posts).toBe(2);
    expect(server.stored.size).toBe(1);
    expect(store.items.get('a')!.status).toBe('synced');
  });

  it('stops on auth failure and keeps every item for after sign-in', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    server.script = [{ ok: false, kind: 'auth', message: 'signed out' }];
    store.add({ id: 'a' });
    store.add({ id: 'b' });

    const r = await runSync({ store, transport: server });

    expect(r.authRequired).toBe(true);
    expect(server.posts).toBe(1);
    expect(store.items.get('a')!.status).toBe('auth_required');
    expect(store.items.get('b')!.status).toBe('auth_required');
  });

  it('parks permanently rejected items with the reason, and carries on with the rest', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    server.script = [{ ok: false, kind: 'permanent', message: 'Rejected by server (400)' }];
    store.add({ id: 'bad' });
    store.add({ id: 'good' });

    const r = await runSync({ store, transport: server });

    expect(r).toMatchObject({ failed: 1, synced: 1 });
    expect(store.items.get('bad')).toMatchObject({
      status: 'failed',
      lastError: 'Rejected by server (400)',
    });
    expect(store.items.get('good')!.status).toBe('synced');
  });

  it('does not let two concurrent runners double-claim, and reclaims an abandoned lease', async () => {
    const store = new MemoryStore();
    store.add({ id: 'a' });

    const first = await store.claimDue(0, 60_000);
    const second = await store.claimDue(1, 60_000);
    expect(first.map((i) => i.id)).toEqual(['a']);
    expect(second).toEqual([]);

    // The first runner died (tab closed). After the lease lapses another runner picks it up.
    const server = new FakeServer();
    const r = await runSync({ store, transport: server, now: () => 60_001 });
    expect(r.synced).toBe(1);
  });

  it('skips a blob that was already uploaded and cleaned up by an earlier attempt', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    store.add({ id: 'a', blobIds: ['gone'] });
    const r = await runSync({ store, transport: server });
    expect(r.synced).toBe(1);
  });
});
