import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { cacheGet, cacheSet, localDb, requeue } from '../offline/db';
import { requestSync } from '../offline/sync';
import { api, ApiError, type Bootstrap, type Me } from './api';

interface AuthState {
  me: Me | null;
  /** True when the server could not be reached and `me` comes from the device cache. */
  offline: boolean;
  loading: boolean;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

/** Refreshes everything a supervisor needs offline. Failure keeps the previous copy. */
export async function refreshBootstrap(): Promise<Bootstrap | undefined> {
  try {
    const b = await api<Bootstrap>('/sync/bootstrap');
    await cacheSet('bootstrap', b);
    return b;
  } catch {
    return cacheGet<Bootstrap>('bootstrap');
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api<Me>('/me');
      const previous = await cacheGet<Me>('me');
      if (previous && previous.id !== fresh.id) {
        // A different person signed in on this phone: their cached roster is not ours.
        await localDb.cache.delete('bootstrap');
      }
      await cacheSet('me', fresh);
      // Registers parked when the session expired can go now that this user is signed in again.
      await requeue((i) => i.status === 'auth_required' && i.ownerId === fresh.id);
      setMe(fresh);
      setOffline(false);
      void refreshBootstrap();
      requestSync();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Signed out (or the session expired). Keep the cached identity so queued registers still
        // belong to their owner, but show the sign-in screen.
        setMe(null);
        setOffline(false);
      } else {
        // No connection: carry on as the last signed-in user.
        const cached = await cacheGet<Me>('me');
        setMe(cached ?? null);
        setOffline(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
    const onOnline = () => void refresh();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  return <Ctx.Provider value={{ me, offline, loading, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
