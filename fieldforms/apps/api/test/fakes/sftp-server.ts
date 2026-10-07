import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

/**
 * An SFTP server for tests, built on ssh2's Server and backed by a temporary directory that
 * plays the server's "/". It implements what the SFTP destination uses (realpath, stat/lstat,
 * mkdir, open/write/close, rename, remove and posix-rename@openssh.com) with OpenSSH's
 * semantics: a plain rename onto an existing file fails, posix-rename replaces it.
 */

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;

export type SftpOp =
  | 'OPEN'
  | 'WRITE'
  | 'CLOSE'
  | 'STAT'
  | 'LSTAT'
  | 'MKDIR'
  | 'RENAME'
  | 'REMOVE'
  | 'REALPATH'
  | 'POSIX_RENAME';

export interface FakeSftpOptions {
  username?: string;
  password?: string;
  /** The client's public key (OpenSSH format) allowed to log in. */
  publicKey?: string;
  /** Advertise and accept posix-rename@openssh.com. */
  posixRename?: boolean;
  /** The login folder (realpath of "."). */
  home?: string;
}

export interface FakeSftp {
  port: number;
  /** The directory that plays the server's "/". */
  root: string;
  hostKeySha256: string;
  /** Read when a session starts. */
  posixRename: boolean;
  /** Every request, as "OP /path". */
  log: string[];
  /** Answers the next request of this kind with an SFTP status (default: permission denied). */
  failNext(op: SftpOp, status?: number): void;
  /** Folders (server paths) where mkdir is refused with "permission denied". */
  denyMkdir: Set<string>;
  /** Runs before a request is answered (to change files behind the client's back). */
  before?: (op: SftpOp, path: string) => Promise<void> | void;
  /** The local path of a server path. */
  local(p: string): string;
  /** Files (server paths) under a server folder, recursively. */
  files(dir?: string): Promise<string[]>;
  sessions: number;
  close(): Promise<void>;
}

/** The SHA256 fingerprint of an OpenSSH public key line, as OpenSSH prints it. */
export function fingerprintOf(publicKey: string): string {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** An SFTP VERSION packet (v3) that advertises posix-rename@openssh.com. */
function versionWithPosixRename(): Buffer {
  const str = (s: string) => {
    const b = Buffer.from(s);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const body = Buffer.concat([
    Buffer.from([2, 0, 0, 0, 3]),
    str('posix-rename@openssh.com'),
    str('1'),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}
const PLAIN_VERSION = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);

function readString(buf: Buffer, offset: number): [string, number] {
  const len = buf.readUInt32BE(offset);
  return [buf.subarray(offset + 4, offset + 4 + len).toString('utf8'), offset + 4 + len];
}

function statusOf(err: unknown): number {
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS.PERMISSION_DENIED;
    default:
      return STATUS.FAILURE;
  }
}

export async function startSftpServer(opts: FakeSftpOptions = {}): Promise<FakeSftp> {
  const root = await mkdtemp(path.join(tmpdir(), 'ff-sftp-'));
  const home = opts.home ?? '/home/fieldforms';
  await fs.mkdir(path.join(root, home), { recursive: true });
  const hostKey = utils.generateKeyPairSync('ed25519');
  const allowedKey = opts.publicKey ? utils.parseKey(opts.publicKey) : null;
  if (allowedKey instanceof Error) throw allowedKey;
  const username = opts.username ?? 'fieldforms';
  const failures = new Map<SftpOp, number>();

  const toServer = (p: string) => path.posix.resolve(home, p || '.');
  const local = (p: string) => path.join(root, toServer(p));

  const fake: FakeSftp = {
    port: 0,
    root,
    hostKeySha256: fingerprintOf(hostKey.public),
    posixRename: opts.posixRename ?? true,
    log: [],
    sessions: 0,
    denyMkdir: new Set(),
    failNext: (op, status = STATUS.PERMISSION_DENIED) => void failures.set(op, status),
    local,
    async files(dir = '/') {
      const out: string[] = [];
      const walk = async (p: string) => {
        for (const e of await fs.readdir(local(p), { withFileTypes: true })) {
          const child = path.posix.join(p, e.name);
          if (e.isDirectory()) await walk(child);
          else out.push(child);
        }
      };
      await walk(dir);
      return out.sort();
    },
    close: async () => {
      for (const c of clients) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };

  const clients = new Set<ssh2.Connection>();
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    (client as unknown as { setNoDelay(on: boolean): void }).setNoDelay(true);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx: any) => {
      if (ctx.method !== 'none') fake.log.push(`AUTH ${ctx.method}`);
      if (ctx.username !== username) return ctx.reject();
      if (ctx.method === 'password' && opts.password && ctx.password === opts.password)
        return ctx.accept();
      if (
        ctx.method === 'publickey' &&
        allowedKey &&
        ctx.key.algo === allowedKey.type &&
        Buffer.compare(ctx.key.data, allowedKey.getPublicSSH()) === 0
      ) {
        // Without a signature the client is asking whether the key would do.
        if (!ctx.signature) return ctx.accept();
        if (allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession: any) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp: any) => {
          fake.sessions++;
          const sftp = acceptSftp();
          serve(sftp);
        });
      });
    });
  });

  /** Answers SFTP requests from the temporary directory. */
  function serve(sftp: any) {
    if (fake.posixRename) {
      // ssh2's server always sends a VERSION without extensions; swap in one that has it.
      const proto = sftp._protocol;
      const withExt = versionWithPosixRename();
      sftp._protocol = new Proxy(proto, {
        get(target, prop) {
          if (prop === 'channelData')
            return (id: number, data: Buffer) =>
              target.channelData(id, data.equals(PLAIN_VERSION) ? withExt : data);
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    }
    const handles = new Map<number, fs.FileHandle>();
    let nextHandle = 1;
    const handleOf = (h: Buffer) => handles.get(h.readUInt32BE(0));
    const failed = (op: SftpOp, reqid: number) => {
      const status = failures.get(op);
      if (status === undefined) return false;
      failures.delete(op);
      sftp.status(reqid, status);
      return true;
    };
    const attrsOf = (st: import('node:fs').Stats) => ({
      mode: st.mode,
      uid: st.uid,
      gid: st.gid,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    });
    const on = (event: string, fn: (reqid: number, ...args: any[]) => Promise<void>) =>
      sftp.on(event, (reqid: number, ...args: any[]) => {
        fn(reqid, ...args).catch((err) => sftp.status(reqid, statusOf(err)));
      });

    on('REALPATH', async (reqid, p: string) => {
      fake.log.push(`REALPATH ${p}`);
      if (failed('REALPATH', reqid)) return;
      const v = toServer(p);
      sftp.name(reqid, [{ filename: v, longname: v, attrs: {} }]);
    });
    for (const op of ['STAT', 'LSTAT'] as const)
      on(op, async (reqid, p: string) => {
        fake.log.push(`${op} ${toServer(p)}`);
        if (failed(op, reqid)) return;
        const st = op === 'STAT' ? await fs.stat(local(p)) : await fs.lstat(local(p));
        sftp.attrs(reqid, attrsOf(st));
      });
    on('MKDIR', async (reqid, p: string) => {
      fake.log.push(`MKDIR ${toServer(p)}`);
      if (failed('MKDIR', reqid)) return;
      if (fake.denyMkdir.has(toServer(p))) return sftp.status(reqid, STATUS.PERMISSION_DENIED);
      await fs.mkdir(local(p));
      sftp.status(reqid, STATUS.OK);
    });
    on('OPEN', async (reqid, p: string, flags: number) => {
      fake.log.push(`OPEN ${toServer(p)}`);
      await fake.before?.('OPEN', toServer(p));
      if (failed('OPEN', reqid)) return;
      const fh = await fs.open(local(p), utils.sftp.flagsToString(flags) ?? 'r');
      const id = nextHandle++;
      handles.set(id, fh);
      const h = Buffer.alloc(4);
      h.writeUInt32BE(id);
      sftp.handle(reqid, h);
    });
    on('WRITE', async (reqid, h: Buffer, offset: number, data: Buffer) => {
      if (failed('WRITE', reqid)) return;
      const fh = handleOf(h);
      if (!fh) return sftp.status(reqid, STATUS.FAILURE);
      await fh.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS.OK);
    });
    on('FSETSTAT', async (reqid) => sftp.status(reqid, STATUS.OK));
    on('SETSTAT', async (reqid) => sftp.status(reqid, STATUS.OK));
    on('FSTAT', async (reqid, h: Buffer) => {
      const fh = handleOf(h);
      if (!fh) return sftp.status(reqid, STATUS.FAILURE);
      sftp.attrs(reqid, attrsOf(await fh.stat()));
    });
    on('CLOSE', async (reqid, h: Buffer) => {
      if (failed('CLOSE', reqid)) return;
      const id = h.readUInt32BE(0);
      await handles.get(id)?.close();
      handles.delete(id);
      sftp.status(reqid, STATUS.OK);
    });
    on('RENAME', async (reqid, from: string, to: string) => {
      fake.log.push(`RENAME ${toServer(from)} ${toServer(to)}`);
      await fake.before?.('RENAME', toServer(to));
      if (failed('RENAME', reqid)) return;
      // OpenSSH links the new name, so it never replaces an existing file.
      const exists = await fs.lstat(local(to)).then(
        () => true,
        () => false,
      );
      if (exists) return sftp.status(reqid, STATUS.FAILURE);
      await fs.rename(local(from), local(to));
      sftp.status(reqid, STATUS.OK);
    });
    on('REMOVE', async (reqid, p: string) => {
      fake.log.push(`REMOVE ${toServer(p)}`);
      if (failed('REMOVE', reqid)) return;
      await fs.unlink(local(p));
      sftp.status(reqid, STATUS.OK);
    });
    on('EXTENDED', async (reqid, name: string, data: Buffer) => {
      if (name !== 'posix-rename@openssh.com' || !fake.posixRename)
        return sftp.status(reqid, STATUS.OP_UNSUPPORTED);
      const [from, next] = readString(data, 0);
      const [to] = readString(data, next);
      fake.log.push(`POSIX_RENAME ${toServer(from)} ${toServer(to)}`);
      if (failed('POSIX_RENAME', reqid)) return;
      await fs.rename(local(from), local(to));
      sftp.status(reqid, STATUS.OK);
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.port = (server.address() as AddressInfo).port;
  return fake;
}
