import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { DEFAULT_FILENAME } from '@fieldforms/shared';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sftpAdapter } from '../src/destinations/adapters/sftp.js';
import {
  hostKeyFingerprint,
  normalizeFingerprint,
  sftpDriver,
  sftpSecretSchema,
  type SftpConfig,
} from '../src/destinations/connections/sftp.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import { adapterEnv, fileContext, pdf, STRICT } from './fakes/file-delivery.js';
import { startSftpServer, type FakeSftp } from './fakes/sftp-server.js';

const PASSWORD = 'sftp-Pa55word-not-for-logs';
const PASSPHRASE = 'key-passphrase-1234';
const HOME = '/home/fieldforms';
const STATUS = ssh2.utils.sftp.STATUS_CODE;
const clientKey = ssh2.utils.generateKeyPairSync('ed25519', {
  passphrase: PASSPHRASE,
  cipher: 'aes256-ctr',
  rounds: 4,
});
const otherKey = ssh2.utils.generateKeyPairSync('ed25519');

let server: FakeSftp;
beforeAll(async () => {
  server = await startSftpServer({ password: PASSWORD, publicKey: clientKey.public, home: HOME });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  server.posixRename = true;
  server.log.length = 0;
  server.before = undefined;
  server.denyMkdir.clear();
  await fs.rm(server.local('/srv'), { recursive: true, force: true });
  await fs.rm(server.local(HOME), { recursive: true, force: true });
  await fs.mkdir(server.local(HOME), { recursive: true });
});

const conn = (
  config: Partial<SftpConfig> = {},
  secrets: Record<string, string> = { password: PASSWORD },
): OpenConnection<SftpConfig> => ({
  id: 'conn-1',
  kind: 'sftp',
  config: {
    host: '127.0.0.1',
    port: server.port,
    username: 'fieldforms',
    hostKeySha256: server.hostKeySha256,
    ...config,
  },
  secrets,
});
const settings = (folder = 'reports/{{ _site }}') => ({ folder, filename: DEFAULT_FILENAME });

/** Runs one attempt the way the pipeline does: fix the target on the first, then deliver. */
async function attempt(
  ctx: ReturnType<typeof fileContext>,
  folder?: string,
  c: OpenConnection<SftpConfig> = conn(),
) {
  ctx.target ??= await sftpAdapter.resolveTarget!(ctx, settings(folder), c, adapterEnv());
  return sftpAdapter.deliver(ctx, settings(folder), c, adapterEnv());
}

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

const read = (p: string) => fs.readFile(server.local(p), 'utf8');
const partFiles = async () => (await server.files('/')).filter((f) => f.endsWith('.part'));

describe('SFTP adapter', () => {
  it('uploads to a temporary name, renames it into place and creates the folders', async () => {
    const ctx = fileContext({
      files: [pdf('Site inspection abcdef12.pdf', 'one'), pdf('Photos abcdef12.pdf', 'two')],
    });
    const r = await attempt(ctx);
    expect(r.outcome).toBe('delivered');
    const folder = `${HOME}/reports/Durban North`;
    expect(await server.files('/')).toEqual([
      `${folder}/Photos abcdef12.pdf`,
      `${folder}/Site inspection abcdef12.pdf`,
    ]);
    expect(await read(`${folder}/Site inspection abcdef12.pdf`)).toBe('%PDF-1.7 one');
    // Written under a hidden temporary name, then renamed (a plain rename: the first upload).
    const tmp = `${folder}/.Site inspection abcdef12.pdf.${ctx.delivery.idempotencyKey}.1.part`;
    expect(server.log).toContain(`OPEN ${tmp}`);
    expect(server.log).toContain(`RENAME ${tmp} ${folder}/Site inspection abcdef12.pdf`);
    expect(server.log).toContain(`MKDIR ${HOME}/reports`);
    expect(r.target).toEqual({
      host: '127.0.0.1',
      port: server.port,
      folder: 'reports/Durban North',
      paths: [
        'reports/Durban North/Site inspection abcdef12.pdf',
        'reports/Durban North/Photos abcdef12.pdf',
      ],
    });
    expect(r.evidence).toEqual({
      paths: [`${folder}/Site inspection abcdef12.pdf`, `${folder}/Photos abcdef12.pdf`],
      sizes: [12, 12],
    });
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });

  it('fixes the target for the generation: retries reuse it', async () => {
    const ctx = fileContext();
    const target = await sftpAdapter.resolveTarget!(ctx, settings(), conn(), adapterEnv());
    expect(target).toEqual({
      folder: 'reports/Durban North',
      paths: ['reports/Durban North/Site inspection abcdef12.pdf'],
      fixedOnAttempt: 1,
    });
    // The folder template changed since: the retry still goes where the first attempt went.
    const retry = fileContext({ attempt: 2, target });
    await sftpAdapter.deliver(retry, settings('elsewhere'), conn(), adapterEnv());
    expect(await server.files('/')).toEqual([
      `${HOME}/reports/Durban North/Site inspection abcdef12.pdf`,
    ]);
  });

  it('writes to an absolute folder when the template starts with "/"', async () => {
    await fs.mkdir(server.local('/srv'), { recursive: true });
    const r = await attempt(fileContext(), '/srv/in/{{ _company }}');
    expect(r.target.folder).toBe('/srv/in/Delta Facilities');
    expect(await server.files('/srv')).toEqual([
      '/srv/in/Delta Facilities/Site inspection abcdef12.pdf',
    ]);
  });

  it('writes to the login folder by default ("."), never above it', async () => {
    await attempt(fileContext(), '.');
    await attempt(
      fileContext({
        submissionId: 'bbbbbbbb-0000-4000-8000-000000000002',
        files: [pdf('B bbbbbbbb.pdf', 'b')],
      }),
      '../../{{ _site }}',
    );
    expect(await server.files('/')).toEqual([
      `${HOME}/Durban North/B bbbbbbbb.pdf`,
      `${HOME}/Site inspection abcdef12.pdf`,
    ]);
  });

  it('replaces its own file on a retry with posix-rename', async () => {
    const first = fileContext();
    await attempt(first);
    const retry = fileContext({
      attempt: 2,
      target: first.target,
      files: [pdf('Site inspection abcdef12.pdf', 'retried')],
    });
    server.log.length = 0;
    const r = await attempt(retry);
    expect(r.outcome).toBe('delivered');
    const final = `${HOME}/reports/Durban North/Site inspection abcdef12.pdf`;
    expect(await read(final)).toBe('%PDF-1.7 retried');
    expect(server.log.some((l) => l.startsWith('POSIX_RENAME ') && l.endsWith(final))).toBe(true);
    expect(server.log.some((l) => l.startsWith('REMOVE '))).toBe(false);
    expect(await partFiles()).toEqual([]);
  });

  it('replaces its own file on a resend without posix-rename (remove, then rename)', async () => {
    await attempt(fileContext());
    server.posixRename = false;
    server.log.length = 0;
    // A resend is a new generation with a freshly fixed target.
    const resend = fileContext({
      generation: 2,
      files: [pdf('Site inspection abcdef12.pdf', 'resent')],
    });
    const r = await attempt(resend);
    expect(r.outcome).toBe('delivered');
    const final = `${HOME}/reports/Durban North/Site inspection abcdef12.pdf`;
    expect(await read(final)).toBe('%PDF-1.7 resent');
    expect(server.log.some((l) => l.startsWith('POSIX_RENAME'))).toBe(false);
    const remove = server.log.indexOf(`REMOVE ${final}`);
    const rename = server.log.findIndex((l) => l.startsWith('RENAME ') && l.endsWith(final));
    expect(remove).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(remove);
    expect(await partFiles()).toEqual([]);
  });

  it("refuses another submission's file on the first upload and leaves it alone", async () => {
    const final = `${HOME}/reports/Durban North/Site inspection abcdef12.pdf`;
    await fs.mkdir(server.local(`${HOME}/reports/Durban North`), { recursive: true });
    await fs.writeFile(server.local(final), 'theirs');
    for (const posix of [true, false]) {
      server.posixRename = posix;
      server.log.length = 0;
      const err = await failure(attempt(fileContext()));
      expect(err.errorClass).toBe('conflict');
      expect(err.permanent).toBe(true);
      expect(err.message).toBe('A file with that name belongs to another submission');
      expect(await read(final)).toBe('theirs');
      // Found before anything was uploaded.
      expect(server.log.some((l) => l.startsWith('OPEN '))).toBe(false);
    }
  });

  it('fails as a conflict when a file appears at the name during the upload', async () => {
    const final = `${HOME}/reports/Durban North/Site inspection abcdef12.pdf`;
    server.before = async (op, p) => {
      if (op === 'OPEN' && p.endsWith('.part')) await fs.writeFile(server.local(final), 'theirs');
    };
    const err = await failure(attempt(fileContext()));
    expect(err.errorClass).toBe('conflict');
    expect(await read(final)).toBe('theirs');
    expect(await partFiles()).toEqual([]);
  });

  it('removes the temporary file when the rename fails', async () => {
    server.failNext('RENAME', STATUS.PERMISSION_DENIED);
    const err = await failure(attempt(fileContext()));
    expect(err.permanent).toBe(true);
    expect(err.errorClass).toBe('rejected');
    expect(err.message).toBe('The SFTP server denied permission');
    expect(await server.files('/')).toEqual([]);
    expect(server.log.some((l) => l.startsWith('REMOVE ') && l.endsWith('.part'))).toBe(true);
  });

  it('removes the temporary file when writing fails, and retries later', async () => {
    // ssh2's write stream reports success after this; the size check catches it.
    server.failNext('WRITE', STATUS.FAILURE);
    const err = await failure(attempt(fileContext()));
    expect(err.permanent).toBe(false);
    expect(err.message).toBe('The upload to the SFTP server was incomplete');
    expect(await server.files('/')).toEqual([]);
    expect(server.log.some((l) => l.startsWith('RENAME'))).toBe(false);
  });

  it('fails permanently when the server refuses to create the file', async () => {
    server.failNext('OPEN', STATUS.PERMISSION_DENIED);
    const err = await failure(attempt(fileContext()));
    expect(err.permanent).toBe(true);
    expect(err.errorClass).toBe('rejected');
    expect(err.detail).toContain('(status 3)');
    expect(await server.files('/')).toEqual([]);
  });

  it('removes the temporary file when a retry cannot posix-rename', async () => {
    const first = fileContext();
    await attempt(first);
    server.failNext('POSIX_RENAME', STATUS.PERMISSION_DENIED);
    const err = await failure(attempt(fileContext({ attempt: 2, target: first.target })));
    expect(err.errorClass).toBe('rejected');
    expect(await partFiles()).toEqual([]);
  });

  it('fails permanently when the folder cannot be created', async () => {
    server.denyMkdir.add(`${HOME}/reports`);
    const err = await failure(attempt(fileContext()));
    expect(err.permanent).toBe(true);
    expect(err.message).toBe('The SFTP server denied permission');
    await fs.writeFile(server.local(`${HOME}/blocked`), 'a file');
    const blocked = await failure(attempt(fileContext(), 'blocked/{{ _site }}'));
    expect(blocked.permanent).toBe(true);
    expect(blocked.message).toBe('A file is in the way of the SFTP folder');
  });

  it('prefixes test sends and lets them replace an earlier test file', async () => {
    await attempt(fileContext({ test: true }));
    const r = await attempt(
      fileContext({ test: true, files: [pdf('Site inspection abcdef12.pdf', 'again')] }),
    );
    expect(r.outcome).toBe('delivered');
    const final = `${HOME}/reports/Durban North/TEST Site inspection abcdef12.pdf`;
    expect(await server.files('/')).toEqual([final]);
    expect(await read(final)).toBe('%PDF-1.7 again');
  });

  it('logs in with a private key and its passphrase', async () => {
    const r = await attempt(
      fileContext(),
      undefined,
      conn({}, { privateKey: clientKey.private, passphrase: PASSPHRASE }),
    );
    expect(r.outcome).toBe('delivered');
    expect(server.log).toContain('AUTH publickey');
  });

  it('fails permanently on wrong credentials, without repeating them', async () => {
    const err = await failure(
      attempt(fileContext(), undefined, conn({}, { password: 'wrong-password-123' })),
    );
    expect(err.errorClass).toBe('credentials');
    expect(err.permanent).toBe(true);
    expect(err.message).toBe('SFTP authentication failed');
    expect(`${err.message} ${err.detail}`).not.toContain('wrong-password-123');

    const key = await failure(
      attempt(fileContext(), undefined, conn({}, { privateKey: otherKey.private })),
    );
    expect(key.errorClass).toBe('credentials');

    const passphrase = await failure(
      attempt(
        fileContext(),
        undefined,
        conn({}, { privateKey: clientKey.private, passphrase: 'nope-nope' }),
      ),
    );
    expect(passphrase.errorClass).toBe('credentials');
    expect(passphrase.message).toBe('The SFTP private key could not be read');
    expect(`${passphrase.message} ${passphrase.detail}`).not.toContain('nope-nope');
  });

  it('refuses a server whose host key does not match the pin, before sending credentials', async () => {
    const wrong = hostKeyFingerprint(Buffer.from('some other key'));
    server.log.length = 0;
    const err = await failure(attempt(fileContext(), undefined, conn({ hostKeySha256: wrong })));
    expect(err.permanent).toBe(true);
    expect(err.errorClass).toBe('credentials');
    expect(err.message).toBe("The server's host key does not match the pinned fingerprint");
    expect(err.detail).toContain(server.hostKeySha256);
    expect(server.log.filter((l) => l.startsWith('AUTH'))).toEqual([]);
    expect(await server.files('/')).toEqual([]);
  });

  it('accepts the pin with or without the prefix and padding', async () => {
    const bare = server.hostKeySha256.replace(/^SHA256:/, '');
    expect(normalizeFingerprint(bare)).toBe(server.hostKeySha256);
    expect(normalizeFingerprint(`${server.hostKeySha256}=`)).toBe(server.hostKeySha256);
    expect((await attempt(fileContext(), undefined, conn({ hostKeySha256: bare }))).outcome).toBe(
      'delivered',
    );
  });

  it('retries when the server is down, and gives up at the deadline', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const down = await failure(attempt(fileContext(), undefined, conn({ port })));
    expect(down.permanent).toBe(false);
    expect(down.errorClass).toBe('unreachable');
    expect(down.detail ?? '').not.toMatch(/connect ECONNREFUSED/);

    // A server that accepts the connection and never speaks.
    const silent: Server = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const c = conn({ port: (silent.address() as AddressInfo).port });
    const ctx = fileContext();
    ctx.target = await sftpAdapter.resolveTarget!(ctx, settings(), c, adapterEnv());
    const started = Date.now();
    const err = await failure(
      sftpAdapter.deliver(ctx, settings(), c, adapterEnv(undefined, AbortSignal.timeout(300))),
    );
    expect(err.message).toBe('Timed out');
    expect(err.permanent).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    silent.close();
  });
});

describe('SFTP address policy', () => {
  it('never connects to the cloud metadata address', async () => {
    for (const host of ['169.254.169.254', '::ffff:169.254.169.254']) {
      const err = await failure(attempt(fileContext(), undefined, conn({ host })));
      expect(err.errorClass).toBe('network_policy');
      expect(err.permanent).toBe(true);
      expect(err.message).toBe('Address not allowed');
    }
  });

  it('refuses loopback unless private ranges allow it', async () => {
    server.log.length = 0;
    for (const host of ['127.0.0.1', 'localhost']) {
      const c = conn({ host });
      const ctx = fileContext();
      ctx.target = await sftpAdapter.resolveTarget!(ctx, settings(), c, adapterEnv());
      const err = await failure(sftpAdapter.deliver(ctx, settings(), c, adapterEnv(STRICT)));
      expect(err.errorClass).toBe('network_policy');
      await expect(sftpDriver.check(c, adapterEnv(STRICT))).rejects.toMatchObject({
        errorClass: 'network_policy',
      });
    }
    expect(server.log).toEqual([]);
  });
});

describe('SFTP connection check', () => {
  it('logs in and shows the host key and login folder when the pin matches', async () => {
    const r = await sftpDriver.check(conn(), adapterEnv());
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual({ hostKeySha256: server.hostKeySha256, loginFolder: HOME });
    expect(r.summary).toContain(HOME);
  });

  it('shows the fingerprint to pin, without logging in, when none is pinned or it differs', async () => {
    server.log.length = 0;
    const unpinned = await sftpDriver.check(conn({ hostKeySha256: '' }), adapterEnv());
    expect(unpinned.ok).toBe(false);
    expect(unpinned.facts).toEqual({ hostKeySha256: server.hostKeySha256 });
    expect(unpinned.summary).toContain(server.hostKeySha256);

    const wrong = hostKeyFingerprint(Buffer.from('rotated'));
    const changed = await sftpDriver.check(conn({ hostKeySha256: wrong }), adapterEnv());
    expect(changed.ok).toBe(false);
    expect(changed.summary).toContain('does not match');
    expect(changed.facts).toEqual({ hostKeySha256: server.hostKeySha256 });
    expect(server.log.filter((l) => l.startsWith('AUTH'))).toEqual([]);
  });

  it('reports wrong credentials as a credentials error', async () => {
    await expect(
      sftpDriver.check(conn({}, { password: 'not-it-at-all' }), adapterEnv()),
    ).rejects.toMatchObject({ errorClass: 'credentials', message: 'SFTP authentication failed' });
  });

  it('validates the secrets an admin enters', () => {
    expect(sftpSecretSchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(
      sftpSecretSchema.safeParse({ privateKey: clientKey.private, passphrase: PASSPHRASE }).success,
    ).toBe(true);
    expect(sftpSecretSchema.safeParse({}).success).toBe(false);
    expect(sftpSecretSchema.safeParse({ password: '', passphrase: 'x' }).success).toBe(false);
    expect(sftpSecretSchema.safeParse({ privateKey: 'not a key' }).success).toBe(false);
    expect(sftpSecretSchema.safeParse({ password: 'x', token: 'y' }).success).toBe(false);
  });
});

describe('SFTP destination check', () => {
  it('reports an existing folder, one to be created, and a file in the way', async () => {
    await fs.mkdir(server.local(`${HOME}/reports`), { recursive: true });
    const exists = await sftpAdapter.check!(settings('reports/{{ _site }}'), conn(), adapterEnv());
    expect(exists.ok).toBe(true);
    expect(exists.summary).toContain(`Folder ${HOME}/reports exists`);
    expect(exists.summary).toContain('created when delivering');

    const missing = await sftpAdapter.check!(settings('/srv/in'), conn(), adapterEnv());
    expect(missing.ok).toBe(true);
    expect(missing.summary).toBe('Folder /srv/in does not exist yet; it will be created in /');

    await fs.writeFile(server.local(`${HOME}/notes`), 'x');
    const file = await sftpAdapter.check!(settings('notes'), conn(), adapterEnv());
    expect(file.ok).toBe(false);
    // Nothing was created by the checks.
    expect(server.log.some((l) => l.startsWith('MKDIR') || l.startsWith('OPEN'))).toBe(false);
  });
});

describe('SFTP with nothing to send', () => {
  it('skips without connecting when the formats produced no files', async () => {
    const sessions = server.sessions;
    const r = await attempt(fileContext({ files: [] }));
    expect(r.outcome).toBe('skipped');
    expect(r.detail).toBe('There were no documents to upload');
    expect(server.sessions).toBe(sessions);
  });
});
