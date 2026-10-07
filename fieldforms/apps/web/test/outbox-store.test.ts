import 'fake-indexeddb/auto';
import { runSync, type SyncTransport, type TransportResult } from '@fieldforms/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { cacheSet, currentOwnerId, dexieOutboxStore, enqueue, FieldFormsDb, requeue } from '../src/offline/db';

let db: FieldFormsDb;
let n = 0;
beforeEach(async () => {
  db = new FieldFormsDb(`test-${n++}`);
  await db.open();
});

const photo = (id: string) => ({ id, data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), contentType: 'image/jpeg' });

function server(script: (TransportResult | 'throw')[] = []) {
  const stored = new Map<string, unknown>();
  const blobs = new Set<string>();
  const t: SyncTransport & { stored: typeof stored; blobs: typeof blobs; posts: number } = {
    stored,
    blobs,
    posts: 0,
    async putBlob(id) {
      blobs.add(id);
      return { ok: true };
    },
    async postItem(item) {
      t.posts++;
      const next = script.shift();
      if (next === 'throw') throw new TypeError('Failed to fetch');
      if (next && !next.ok) return next;
      stored.set(item.id, item.payload);
      return { ok: true };
    },
  };
  return t;
}

describe('IndexedDB outbox store', () => {
  it('saves a register and its photos together and syncs them with the shared engine', async () => {
    await enqueue({ id: 'r1', type: 'register', label: 'x', ownerId: 'u1', payload: { id: 'r1' } }, [photo('p1'), photo('p2')], db);
    expect(await db.blobs.count()).toBe(2);

    const s = server();
    const report = await runSync({ store: dexieOutboxStore('u1', db), transport: s });

    expect(report.synced).toBe(1);
    expect([...s.blobs].sort()).toEqual(['p1', 'p2']);
    expect(s.stored.has('r1')).toBe(true);
    expect((await db.outbox.get('r1'))!.status).toBe('synced');
    expect(await db.blobs.count()).toBe(0);
  });

  it('rolls back the whole capture if any part fails to save', async () => {
    await enqueue({ id: 'dup', type: 'register', label: 'x', ownerId: 'u1', payload: {} }, [], db);
    await expect(enqueue({ id: 'dup', type: 'register', label: 'x', ownerId: 'u1', payload: {} }, [photo('orphan')], db)).rejects.toThrow();
    expect(await db.blobs.get('orphan')).toBeUndefined();
  });

  it('survives going offline: keeps the item, backs off, then sends it once', async () => {
    await enqueue({ id: 'r1', type: 'register', label: 'x', ownerId: 'u1', payload: { id: 'r1' } }, [], db);
    const s = server(['throw']);
    let now = 1_000;
    const store = dexieOutboxStore('u1', db);

    await runSync({ store, transport: s, now: () => now, random: () => 0 });
    expect(await db.outbox.get('r1')).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Failed to fetch' });

    now += 60_000;
    await runSync({ store, transport: s, now: () => now });
    expect((await db.outbox.get('r1'))!.status).toBe('synced');
    expect(s.stored.size).toBe(1);
  });

  it('only sends items captured by the signed-in user', async () => {
    await enqueue({ id: 'mine', type: 'register', label: 'x', ownerId: 'u1', payload: {} }, [], db);
    await enqueue({ id: 'theirs', type: 'register', label: 'x', ownerId: 'u2', payload: {} }, [], db);
    const s = server();
    await runSync({ store: dexieOutboxStore('u1', db), transport: s });
    expect([...s.stored.keys()]).toEqual(['mine']);
    expect((await db.outbox.get('theirs'))!.status).toBe('pending');
  });

  it('parks items when the session expires and requeues them after sign-in', async () => {
    await enqueue({ id: 'a', type: 'register', label: 'x', ownerId: 'u1', payload: {} }, [], db);
    await enqueue({ id: 'b', type: 'register', label: 'x', ownerId: 'u1', payload: {} }, [], db);
    const s = server([{ ok: false, kind: 'auth', message: 'signed out' }]);
    await runSync({ store: dexieOutboxStore('u1', db), transport: s });
    expect((await db.outbox.toArray()).map((i) => i.status)).toEqual(['auth_required', 'auth_required']);

    expect(await requeue((i) => i.status === 'auth_required', db)).toBe(2);
    await runSync({ store: dexieOutboxStore('u1', db), transport: s });
    expect(s.stored.size).toBe(2);
  });

  it('claims atomically so two runners never take the same item', async () => {
    await enqueue({ id: 'a', type: 'register', label: 'x', ownerId: 'u1', payload: {} }, [], db);
    const store = dexieOutboxStore('u1', db);
    const [x, y] = await Promise.all([store.claimDue(10, 60_000), store.claimDue(10, 60_000)]);
    expect(x.length + y.length).toBe(1);
  });

  it('remembers the signed-in user for the service worker', async () => {
    expect(await currentOwnerId(db)).toBeNull();
    await cacheSet('me', { id: 'u9' }, db);
    expect(await currentOwnerId(db)).toBe('u9');
  });
});
