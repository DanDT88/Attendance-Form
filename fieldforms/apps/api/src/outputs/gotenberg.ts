import { DeliveryError, redact } from '../destinations/types.js';
import type { PdfConverter } from './types.js';

/** Longest a single conversion may take, whatever deadline the caller has. */
export const GOTENBERG_TIMEOUT_MS = 60_000;

/**
 * Gotenberg client: Chromium HTML → PDF and LibreOffice → PDF, with basic auth, a deadline from
 * the caller's signal, and a transient DeliveryError (errorClass 'unreachable') when the service
 * is down or answers 5xx. Without a URL every call fails permanently with a clear message.
 *
 * Gotenberg is an internal service set by the operator (not by admins in the app), so a plain
 * fetch is used rather than the outbound network guard.
 */
export function gotenbergConverter(opts: {
  url: string | undefined;
  username?: string;
  password?: string;
}): PdfConverter {
  const base = opts.url?.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  if (opts.username) {
    const token = Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64');
    headers.authorization = `Basic ${token}`;
    secrets.token = token;
    if (opts.password) secrets.password = opts.password;
  }

  async function convert(path: string, form: FormData, signal: AbortSignal): Promise<Buffer> {
    if (!base) {
      throw new DeliveryError('PDF conversion is not configured', {
        permanent: true,
        errorClass: 'settings',
      });
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(GOTENBERG_TIMEOUT_MS)]);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        body: form,
        headers,
        redirect: 'error',
        signal: deadline,
      });
    } catch (err) {
      throw unreachable(networkDetail(err, signal), secrets);
    }
    if (!res.ok) {
      // Never keep Gotenberg's body: it can echo the document being converted.
      await res.body?.cancel().catch(() => undefined);
      throw statusError(res.status, path, secrets);
    }
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw unreachable(networkDetail(err, signal), secrets);
    }
  }

  return {
    htmlToPdf(html, signal) {
      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html; charset=utf-8' }), 'index.html');
      // Our layouts set the page size with CSS @page and colour their header bars.
      form.append('preferCssPageSize', 'true');
      form.append('printBackground', 'true');
      return convert('/forms/chromium/convert/html', form, signal);
    },
    officeToPdf(file, filename, signal) {
      const form = new FormData();
      // LibreOffice picks the importer by extension; the rest of the name is not needed.
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() ?? 'docx';
      form.append('files', new Blob([new Uint8Array(file)]), `document.${ext}`);
      return convert('/forms/libreoffice/convert', form, signal);
    },
  };
}

function unreachable(detail: string, secrets: Record<string, string>): DeliveryError {
  return new DeliveryError('PDF conversion service could not be reached', {
    permanent: false,
    errorClass: 'unreachable',
    detail: redact(detail, secrets),
  });
}

/** 5xx, 408 and 429 are worth retrying; a 4xx means this document cannot be converted. */
function statusError(status: number, path: string, secrets: Record<string, string>) {
  const detail = redact(`Gotenberg ${path} answered HTTP ${status}`, secrets);
  if (status >= 500 || status === 408 || status === 429) {
    return new DeliveryError(`PDF conversion service returned HTTP ${status}`, {
      permanent: false,
      errorClass: 'unreachable',
      detail,
      status,
    });
  }
  if (status === 401 || status === 403) {
    return new DeliveryError('PDF conversion service rejected its credentials', {
      permanent: true,
      errorClass: 'settings',
      detail,
      status,
    });
  }
  return new DeliveryError(`PDF conversion failed (HTTP ${status})`, {
    permanent: true,
    errorClass: status === 413 ? 'too_large' : 'template',
    detail,
    status,
  });
}

/** What went wrong in safe words: a timeout, the caller's deadline, or a socket error code. */
function networkDetail(err: unknown, callerSignal: AbortSignal): string {
  if (callerSignal.aborted) return 'Gotenberg request stopped at the attempt deadline';
  const e = err as { name?: string; cause?: { code?: unknown } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return `Gotenberg request timed out after ${GOTENBERG_TIMEOUT_MS / 1000} s`;
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : '';
  return /^[A-Z][A-Z0-9_]{1,40}$/.test(code)
    ? `Gotenberg network error ${code}`
    : 'Gotenberg network error';
}
