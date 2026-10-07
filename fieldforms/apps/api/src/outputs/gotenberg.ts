import type { PdfConverter } from './types.js';

/**
 * Gotenberg client: Chromium HTML → PDF and LibreOffice → PDF, with basic auth, a deadline from
 * the caller's signal, and a transient DeliveryError (errorClass 'unreachable') when the service
 * is down or answers 5xx. Without a URL every call fails permanently with a clear message.
 */
export function gotenbergConverter(_opts: {
  url: string | undefined;
  username?: string;
  password?: string;
}): PdfConverter {
  throw new Error('The Gotenberg client is not built yet');
}
