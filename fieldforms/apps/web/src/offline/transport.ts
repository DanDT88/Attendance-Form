import { classifyHttpStatus, type SyncTransport } from '@fieldforms/shared/sync';

export const CSRF_HEADER = { 'x-fieldforms': '1' } as const;

/** The sync engine's network side: plain fetch, usable from the page and the service worker. */
export function fetchTransport(base = ''): SyncTransport {
  return {
    async putBlob(id, blob) {
      const res = await fetch(`${base}/api/blobs/${id}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { ...CSRF_HEADER, 'content-type': blob.contentType },
        body: blob.data as BodyInit,
      });
      return classifyHttpStatus(res.status);
    },
    async postItem(item, deviceSentAt) {
      // Registers and form submissions share the outbox; each has its own idempotent endpoint.
      const endpoint = item.type === 'form' ? 'form-submissions' : 'registers';
      const res = await fetch(`${base}/api/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...CSRF_HEADER, 'content-type': 'application/json' },
        body: JSON.stringify({ ...item.payload, deviceSentAt }),
      });
      const result = classifyHttpStatus(res.status);
      if (!result.ok && result.kind === 'permanent') {
        // Surface the server's reason so the supervisor can see why it was rejected.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error) return { ...result, message: body.error };
      }
      return result;
    },
  };
}
