import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/** POPIA notice: shown on first sign-in and again whenever the notice version changes. */
export function ConsentPage() {
  const { me, refresh, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  return (
    <div className="login">
      <h1>Privacy notice</h1>
      <div className="card notice">
        {me.privacyNotice.text.split('\n\n').map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <p className="muted">Notice version {me.privacyNotice.version}</p>
      </div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api('/consent', { method: 'POST', body: { version: me.privacyNotice.version } });
          await refresh();
        }}
      >
        I have read and accept this notice
      </button>
      <button className="link" onClick={() => void signOut()}>
        Cancel and sign out
      </button>
    </div>
  );
}
