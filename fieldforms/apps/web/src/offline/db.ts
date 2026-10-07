import Dexie, { type Table } from 'dexie';
import type { OutboxItem, OutboxStore, StoredBlob } from '@fieldforms/shared';

export interface BlobRow {
  id: string;
  data: Blob;
  contentType: string;
}

export interface CacheRow {
  key: string;
  value: unknown;
  savedAt: number;
}

/**
 * IndexedDB on the device. Shared by the page and the service worker (same origin, same database),
 * so Background Sync can drain the outbox while the app is closed.
 */
export class FieldFormsDb extends Dexie {
  outbox!: Table<OutboxItem, string>;
  blobs!: Table<BlobRow, string>;
  cache!: Table<CacheRow, string>;

  constructor(name = 'fieldforms') {
    super(name);
    this.version(1).stores({
      outbox: 'id, status, nextAttemptAt, createdAt',
      blobs: 'id',
      cache: 'key',
    });
  }
}

export const localDb = new FieldFormsDb();

/**
 * The sync engine's storage, backed by IndexedDB. Only items captured by `ownerId` are claimed:
 * the session cookie decides who the server records as the submitter.
 */
export function dexieOutboxStore(ownerId: string, db: FieldFormsDb = localDb): OutboxStore {
  return {
    async claimDue(now, leaseMs) {
      // One readwrite transaction, so two runners (two tabs, or a tab and the service worker)
      // cannot both claim the same item.
      return db.transaction('rw', db.outbox, async () => {
        const due = await db.outbox
          .filter(
            (i) =>
              i.ownerId === ownerId &&
              ((i.status === 'pending' && i.nextAttemptAt <= now) ||
                (i.status === 'syncing' && i.leaseUntil < now)),
          )
          .toArray();
        due.sort((a, b) => a.createdAt - b.createdAt);
        for (const i of due) {
          i.status = 'syncing';
          i.leaseUntil = now + leaseMs;
          await db.outbox.put(i);
        }
        return due;
      });
    },
    async update(id, patch) {
      await db.outbox.update(id, patch);
    },
    async getBlob(id): Promise<StoredBlob | undefined> {
      const row = await db.blobs.get(id);
      return row ? { data: row.data, contentType: row.contentType } : undefined;
    },
    async deleteBlob(id) {
      await db.blobs.delete(id);
    },
  };
}

/** Puts a register and its photos in the outbox atomically: either all of it is saved, or none. */
export async function enqueue(
  item: Pick<OutboxItem, 'id' | 'type' | 'payload' | 'label' | 'ownerId'>,
  photos: BlobRow[],
  db: FieldFormsDb = localDb,
): Promise<void> {
  await db.transaction('rw', db.outbox, db.blobs, async () => {
    for (const p of photos) await db.blobs.put(p);
    await db.outbox.add({
      ...item,
      blobIds: photos.map((p) => p.id),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      leaseUntil: 0,
      lastError: null,
      createdAt: Date.now(),
      syncedAt: null,
    });
  });
}

/** Lets items parked by a sign-out, or rejected ones the user chose to retry, go again. */
export async function requeue(
  where: (i: OutboxItem) => boolean,
  db: FieldFormsDb = localDb,
): Promise<number> {
  return db.transaction('rw', db.outbox, async () => {
    const items = await db.outbox.filter(where).toArray();
    for (const i of items)
      await db.outbox.update(i.id, { status: 'pending', nextAttemptAt: 0, leaseUntil: 0 });
    return items.length;
  });
}

export async function cacheGet<T>(key: string, db: FieldFormsDb = localDb): Promise<T | undefined> {
  return (await db.cache.get(key))?.value as T | undefined;
}

export async function cacheSet(
  key: string,
  value: unknown,
  db: FieldFormsDb = localDb,
): Promise<void> {
  await db.cache.put({ key, value, savedAt: Date.now() });
}

/** The signed-in user as last seen online; lets the service worker sync while the app is closed. */
export async function currentOwnerId(db: FieldFormsDb = localDb): Promise<string | null> {
  return (await cacheGet<{ id: string }>('me', db))?.id ?? null;
}

/** Synced items are kept for a while so the supervisor can see what went through, then pruned. */
export async function pruneSynced(
  olderThanMs = 7 * 86_400_000,
  db: FieldFormsDb = localDb,
): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  await db.outbox.filter((i) => i.status === 'synced' && (i.syncedAt ?? 0) < cutoff).delete();
}
