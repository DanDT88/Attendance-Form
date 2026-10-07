import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const [mode, setMode] = useState<'pin' | 'office'>('pin');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ id: string; label: string }[]>('/auth/providers'),
  });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (mode === 'pin') {
        await api('/auth/pin', {
          method: 'POST',
          body: { employeeNo: f.get('employeeNo'), pin: f.get('pin') },
        });
      } else {
        await api('/auth/password', {
          method: 'POST',
          body: { email: f.get('email'), password: f.get('password') },
        });
      }
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No connection. You need signal to sign in the first time.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>FieldForms</h1>
      <div className="tabs">
        <button className={mode === 'pin' ? 'active' : ''} onClick={() => setMode('pin')}>
          Supervisor
        </button>
        <button className={mode === 'office' ? 'active' : ''} onClick={() => setMode('office')}>
          Office
        </button>
      </div>
      {(error || params.get('error')) && <p className="error">{error ?? params.get('error')}</p>}
      <form onSubmit={submit} className="card stack">
        {mode === 'pin' ? (
          <>
            <label>
              Employee number
              <input
                name="employeeNo"
                autoComplete="username"
                required
                autoCapitalize="characters"
              />
            </label>
            <label>
              PIN
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                required
                maxLength={6}
              />
            </label>
          </>
        ) : (
          <>
            {providers.data?.map((p) => (
              <a key={p.id} className="button secondary" href={`/api/auth/oidc/${p.id}/start`}>
                Sign in with {p.label}
              </a>
            ))}
            {!!providers.data?.length && <p className="muted center">or with a password</p>}
            <label>
              Email
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
          </>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
