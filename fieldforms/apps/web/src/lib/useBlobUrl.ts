import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { localDb } from '../offline/db';

/**
 * An object URL for a photo or signature: from the phone's storage while it is a draft or waiting
 * to sync, otherwise from the server.
 */
export function useBlobUrl(id: string | null | undefined): string | null {
  const local = useLiveQuery(
    async () => (id ? ((await localDb.blobs.get(id)) ?? null) : null),
    [id],
  );
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    if (local === undefined) return; // still loading
    if (local) {
      const u = URL.createObjectURL(local.data);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    setUrl(`/api/blobs/${id}`);
  }, [id, local]);
  return url;
}
