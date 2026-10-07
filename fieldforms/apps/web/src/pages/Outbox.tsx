import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '../lib/auth';
import { localDb, requeue } from '../offline/db';
import { requestSync, syncNow } from '../offline/sync';
import { useSyncState } from '../components/SyncChip';

const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting to send',
  syncing: 'Sending…',
  synced: 'Sent',
  failed: 'Rejected',
  auth_required: 'Sign in again to send',
};

export function OutboxPage() {
  const { me, refresh } = useAuth();
  const items =
    useLiveQuery(() => localDb.outbox.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const s = useSyncState();

  return (
    <div className="stack">
      <div className="card row">
        <div>
          <b>Outbox</b>
          <div className="muted small">
            {s.running
              ? 'Sending…'
              : s.lastRun
                ? `Last checked ${new Date(s.lastRun).toLocaleTimeString('en-ZA')}`
                : 'Not checked yet'}
          </div>
        </div>
        <button
          onClick={() => void syncNow({ now: true })}
          disabled={s.running}
          data-testid="sync-now"
        >
          Sync now
        </button>
      </div>
      {s.authRequired && (
        <div className="card warn">
          Your session has expired. Your registers are safe on this phone.{' '}
          <button className="link" onClick={() => void refresh()}>
            Sign in again
          </button>
        </div>
      )}
      {!items.length && <p className="muted center">Nothing captured on this phone yet.</p>}
      <ul className="outbox">
        {items.map((i) => (
          <li
            key={i.id}
            className={`status-${i.status}`}
            data-testid="outbox-item"
            data-status={i.status}
          >
            <div>
              <b>{i.label}</b>
              <div className="small muted">
                Captured {new Date(i.createdAt).toLocaleString('en-ZA')}
                {i.syncedAt ? ` · sent ${new Date(i.syncedAt).toLocaleString('en-ZA')}` : ''}
                {i.attempts ? ` · ${i.attempts} attempt${i.attempts > 1 ? 's' : ''}` : ''}
              </div>
              {i.lastError && i.status !== 'synced' && (
                <div className="small error">{i.lastError}</div>
              )}
              {i.ownerId && me && i.ownerId !== me.id && (
                <div className="small warn-text">
                  Captured by another user; it is sent when they sign in.
                </div>
              )}
            </div>
            <div className="right">
              <span className="pill">{STATUS_TEXT[i.status] ?? i.status}</span>
              {i.status === 'failed' && (
                <button
                  className="link"
                  onClick={async () => {
                    await requeue((x) => x.id === i.id);
                    requestSync();
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
