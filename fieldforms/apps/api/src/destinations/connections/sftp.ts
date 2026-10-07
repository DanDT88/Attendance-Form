import { createHash } from 'node:crypto';
import SftpClient from 'ssh2-sftp-client';
import { z } from 'zod';
import { NetworkPolicyError, resolveAllowed } from '../../lib/netguard.js';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type ConnectionDriver,
  type OpenConnection,
} from '../types.js';

/**
 * SFTP connections: a host, port, user and pinned host key, with a password or a private key.
 *
 * The host is resolved once through the address policy and the client connects to that IP, so
 * DNS cannot be rebound between the check and the connection. The server's host key is compared
 * with the pinned SHA256 fingerprint during the handshake, before any credential is sent; a
 * mismatch stops the connection. Errors are mapped to a fixed vocabulary: the library's messages
 * carry raw socket errors and the server's own text, so they are never passed on.
 */

export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  /** OpenSSH-style "SHA256:<base64>" (the prefix and padding are optional). */
  hostKeySha256?: string;
}

const SECRET_KEYS = new Set(['password', 'privateKey', 'passphrase']);

/** One of password or privateKey is needed; empty values count as not set. */
export const sftpSecretSchema = z.record(z.string(), z.string()).superRefine((s, ctx) => {
  for (const key of Object.keys(s))
    if (!SECRET_KEYS.has(key))
      ctx.addIssue({ code: 'custom', path: [key], message: 'Not an SFTP secret' });
  if (!s.password?.trim() && !s.privateKey?.trim())
    ctx.addIssue({
      code: 'custom',
      path: ['password'],
      message: 'Enter a password or a private key',
    });
  if (s.privateKey?.trim() && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(s.privateKey))
    ctx.addIssue({
      code: 'custom',
      path: ['privateKey'],
      message: 'Paste the private key in OpenSSH or PEM format',
    });
});

/** A host key's fingerprint as OpenSSH prints it: "SHA256:" and unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** The pinned fingerprint in the form `hostKeyFingerprint` returns, or null if none is pinned. */
export function normalizeFingerprint(raw: string | undefined | null): string | null {
  const b64 = (raw ?? '')
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
  return /^[A-Za-z0-9+/]{43}$/.test(b64) ? `SHA256:${b64}` : null;
}

/** Reached the attempt's deadline: worth retrying. */
export const timedOut = () =>
  new DeliveryError('Timed out', { permanent: false, errorClass: 'unreachable' });

export class HostKeyMismatch extends DeliveryError {
  /** What the server presented, for the check to show. */
  readonly presented: string;
  readonly pinned: boolean;
  constructor(presented: string, pinned: boolean) {
    super(
      pinned
        ? "The server's host key does not match the pinned fingerprint"
        : "The server's host key has not been pinned",
      { permanent: true, errorClass: 'credentials', detail: `The server presented ${presented}` },
    );
    this.presented = presented;
    this.pinned = pinned;
  }
}

type RawError = Error & { level?: string; code?: string | number };

/** Classifies a failed connection without passing on the library's or the server's text. */
function connectError(err: RawError | undefined, cfg: SftpConfig): DeliveryError {
  const where = `${cfg.host}:${cfg.port ?? 22}`;
  const message = err?.message ?? '';
  if (/privateKey|private key|passphrase/i.test(message) && !err?.level)
    return new DeliveryError('The SFTP private key could not be read', {
      permanent: true,
      errorClass: 'credentials',
      detail: 'Check the key format and its passphrase',
    });
  switch (err?.level) {
    case 'client-authentication':
      return new DeliveryError('SFTP authentication failed', {
        permanent: true,
        errorClass: 'credentials',
        detail: `${cfg.username}@${where}`,
      });
    case 'client-timeout':
      return new DeliveryError('The SFTP server did not answer in time', {
        permanent: false,
        errorClass: 'unreachable',
        detail: where,
      });
    case 'client-socket':
    case 'client-dns':
      return new DeliveryError('The SFTP server could not be reached', {
        permanent: false,
        errorClass: 'unreachable',
        detail: `${where}${typeof err.code === 'string' ? ` (${err.code})` : ''}`,
      });
    case 'handshake':
    case 'protocol': {
      // Only ssh2's own phrase for a failed negotiation, never text the server sent.
      const algo = /no matching [a-z ]+/i.exec(message)?.[0];
      return new DeliveryError('The SSH handshake with the SFTP server failed', {
        permanent: true,
        errorClass: 'rejected',
        detail: algo ? `${where}: ${algo}` : where,
      });
    }
  }
  if (/subsystem/i.test(message))
    return new DeliveryError('The server does not offer SFTP', {
      permanent: true,
      errorClass: 'rejected',
      detail: where,
    });
  return new DeliveryError('The SFTP connection failed', {
    permanent: false,
    errorClass: 'unreachable',
    detail: where,
  });
}

function authOptions(secrets: Record<string, string>) {
  const password = secrets.password || undefined;
  const privateKey = secrets.privateKey?.trim() ? secrets.privateKey : undefined;
  if (!password && !privateKey)
    throw new DeliveryError('The SFTP connection has no password or private key', {
      permanent: true,
      errorClass: 'settings',
    });
  return {
    ...(password ? { password } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(privateKey && secrets.passphrase ? { passphrase: secrets.passphrase } : {}),
  };
}

/** The ssh2 client inside ssh2-sftp-client (not in its type definitions). */
type Raw = { client: { destroy(): void; setNoDelay(noDelay: boolean): void } };

export interface SftpSession {
  client: SftpClient;
  /** The fingerprint the server presented. */
  hostKey: string;
  /** Ends the session; never throws and never hangs. */
  close(): Promise<void>;
}

/**
 * Connects and authenticates. The host key is verified before credentials are sent; an
 * unpinned or different key fails with `HostKeyMismatch`. Aborting `env.signal` drops the socket,
 * so a stuck server cannot hold the attempt past its deadline.
 */
export async function connectSftp(
  conn: OpenConnection<SftpConfig>,
  env: AdapterEnv,
): Promise<SftpSession> {
  const cfg = conn.config;
  if (env.signal.aborted) throw timedOut();
  const auth = authOptions(conn.secrets);
  let ip: string;
  try {
    ip = await resolveAllowed(cfg.host, env.policy);
  } catch (err) {
    const e = err as RawError;
    if (err instanceof NetworkPolicyError)
      throw new DeliveryError('Address not allowed', {
        permanent: true,
        errorClass: 'network_policy',
        detail: e.message,
      });
    throw new DeliveryError('The SFTP host name could not be resolved', {
      permanent: false,
      errorClass: 'unreachable',
      detail: `${cfg.host}${typeof e.code === 'string' ? ` (${e.code})` : ''}`,
    });
  }
  if (env.signal.aborted) throw timedOut();

  const pinned = normalizeFingerprint(cfg.hostKeySha256);
  // Set from callbacks, so held in an object (narrowing does not see closures).
  const seen: { hostKey: string | null; error: RawError | undefined } = {
    hostKey: null,
    error: undefined,
  };
  // The default callbacks print errors (with addresses) to the console; errors are ours to report.
  const client = new SftpClient('fieldforms', { error: () => {}, end: () => {}, close: () => {} });
  const onError = (err: RawError) => {
    seen.error ??= err;
  };
  client.on('error', onError);
  const drop = () => (client as unknown as Raw).client.destroy();
  env.signal.addEventListener('abort', drop, { once: true });
  const close = async () => {
    env.signal.removeEventListener('abort', drop);
    client.removeListener('error', onError);
    // end() waits for the socket to close, which a dead peer never does.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    drop();
  };

  try {
    const connecting = client.connect({
      host: ip,
      port: cfg.port ?? 22,
      username: cfg.username,
      ...auth,
      hostVerifier: (key: Buffer) => {
        seen.hostKey = hostKeyFingerprint(key);
        return pinned !== null && seen.hostKey === pinned;
      },
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    });
    // SFTP is many small request/reply round trips; Nagle's algorithm would delay each one.
    (client as unknown as Raw).client.setNoDelay(true);
    await connecting;
  } catch (err) {
    await close();
    if (env.signal.aborted) throw timedOut();
    if (seen.hostKey && seen.hostKey !== pinned)
      throw new HostKeyMismatch(seen.hostKey, pinned !== null);
    throw connectError(seen.error ?? (err as RawError), cfg);
  }
  return { client, hostKey: seen.hostKey ?? '', close };
}

export const sftpDriver: ConnectionDriver<SftpConfig> = {
  kind: 'sftp',
  secretSchema: sftpSecretSchema,
  /**
   * Shows the server's host key so the admin can pin it. A key that is not pinned (or differs)
   * is reported with its fingerprint and nothing is sent to the server; otherwise it logs in and
   * reads the login folder.
   */
  async check(conn, env): Promise<CheckResult> {
    let session: SftpSession;
    try {
      session = await connectSftp(conn, env);
    } catch (err) {
      if (err instanceof HostKeyMismatch)
        return {
          ok: false,
          summary: err.pinned
            ? `${err.message}: the server presented ${err.presented}. Pin it only if you expected the server's key to change.`
            : `Pin the server's host key to connect: ${err.presented}`,
          facts: { hostKeySha256: err.presented },
        };
      throw err;
    }
    try {
      let home: string;
      try {
        home = await session.client.realPath('.');
      } catch {
        if (env.signal.aborted) throw timedOut();
        throw new DeliveryError('The SFTP server did not report the login folder', {
          permanent: false,
          errorClass: 'unreachable',
        });
      }
      return {
        ok: true,
        summary: `Connected as ${conn.config.username}; login folder ${home || '/'}`,
        facts: { hostKeySha256: session.hostKey, loginFolder: home || '/' },
      };
    } finally {
      await session.close();
    }
  },
};
