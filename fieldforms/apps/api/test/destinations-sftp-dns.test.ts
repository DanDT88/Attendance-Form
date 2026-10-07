import type { LookupAddress } from 'node:dns';
import { DEFAULT_FILENAME } from '@fieldforms/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Host names are judged by the addresses they resolve to (and SFTP connects to that address).
 * DNS is faked here so names can point at the metadata service or at loopback.
 */
const records: Record<string, LookupAddress[]> = {
  'metadata.example.test': [{ address: '169.254.169.254', family: 4 }],
  'mixed.example.test': [
    { address: '93.184.215.14', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ],
  'sftp.example.test': [{ address: '127.0.0.1', family: 4 }],
};
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns')>();
  const lookup = (host: string, opts: unknown, cb: (...args: unknown[]) => void) => {
    const list = records[host];
    if (!list) return real.lookup(host, opts as never, cb as never);
    const o = (typeof opts === 'object' ? opts : {}) as { all?: boolean };
    if (o.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  };
  return { ...real, default: { ...real, lookup }, lookup };
});

const { sftpAdapter } = await import('../src/destinations/adapters/sftp.js');
const { sftpDriver } = await import('../src/destinations/connections/sftp.js');
const { DeliveryError } = await import('../src/destinations/types.js');
const { adapterEnv, fileContext } = await import('./fakes/file-delivery.js');
const { startSftpServer } = await import('./fakes/sftp-server.js');

const PASSWORD = 'dns-test-password-1';
let server: Awaited<ReturnType<typeof startSftpServer>>;
beforeAll(async () => {
  server = await startSftpServer({ password: PASSWORD });
});
afterAll(async () => {
  await server.close();
});

const conn = (host: string) => ({
  id: 'conn-dns',
  kind: 'sftp' as const,
  config: { host, port: server.port, username: 'fieldforms', hostKeySha256: server.hostKeySha256 },
  secrets: { password: PASSWORD },
});
const settings = { folder: 'in', filename: DEFAULT_FILENAME };

describe('SFTP host names', () => {
  it('refuses a name that resolves to the metadata address (or has one among its addresses)', async () => {
    for (const host of ['metadata.example.test', 'mixed.example.test']) {
      const ctx = fileContext();
      ctx.target = await sftpAdapter.resolveTarget!(ctx, settings, conn(host), adapterEnv());
      const err = await sftpAdapter
        .deliver(ctx, settings, conn(host), adapterEnv())
        .catch((e) => e);
      expect(err).toBeInstanceOf(DeliveryError);
      expect(err.errorClass).toBe('network_policy');
      expect(err.permanent).toBe(true);
      expect(err.detail).toContain('169.254.169.254');
      await expect(sftpDriver.check(conn(host), adapterEnv())).rejects.toMatchObject({
        errorClass: 'network_policy',
      });
    }
    expect(server.sessions).toBe(0);
  });

  it('connects to the address the name resolved to', async () => {
    const r = await sftpDriver.check(conn('sftp.example.test'), adapterEnv());
    expect(r.ok).toBe(true);
    expect(server.sessions).toBe(1);
  });
});
