import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { localDb } from '../offline/db';
import { getSyncState, subscribeSync } from '../offline/sync';

export function useSyncState() {
  const [s, setS] = useState(getSyncState());
  useEffect(() => subscribeSync(setS), []);
  return s;
}

export function useOutboxCounts() {
  return (
    useLiveQuery(async () => {
      const all = await localDb.outbox.toArray();
      const count = (st: string) => all.filter((i) => i.status === st).length;
      return {
        pending: count('pending') + count('syncing'),
        failed: count('failed'),
        auth: count('auth_required'),
        synced: count('synced'),
      };
    }, []) ?? { pending: 0, failed: 0, auth: 0, synced: 0 }
  );
}

/** Always-visible sync status: what is waiting, what failed, and whether it is sending now. */
export function SyncChip() {
  const c = useOutboxCounts();
  const s = useSyncState();
  let cls = 'chip ok';
  let text = 'All synced';
  if (c.failed) {
    cls = 'chip bad';
    text = `${c.failed} failed`;
  } else if (c.auth) {
    cls = 'chip warn';
    text = `${c.auth} waiting for sign-in`;
  } else if (c.pending) {
    cls = 'chip warn';
    text = s.running ? `Syncing ${c.pending}…` : `${c.pending} pending`;
  }
  return (
    <Link to="/outbox" className={cls} data-testid="sync-chip">
      {text}
    </Link>
  );
}
