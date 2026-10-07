import { posix } from 'node:path';
import type { DestinationSettings } from '@fieldforms/shared';
import { safeFilename } from '../../lib/liquid.js';
import { connectSftp, timedOut, type SftpConfig, type SftpSession } from '../connections/sftp.js';
import { plannedUploads } from '../naming.js';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type DeliveryContext,
  type DestinationAdapter,
  type OpenConnection,
} from '../types.js';

/**
 * Uploads a submission's documents to an SFTP folder.
 *
 * Each file is written to a hidden temporary name in the target folder and then renamed onto
 * its final name, so nobody downstream ever picks up a half-written file. File names carry the
 * submission's short id, and a file is only ever replaced by a retry or resend of the same
 * delivery: SFTP has no metadata to tag a file with, so the first upload of a delivery (the
 * attempt that fixed its target) refuses any file already at its name, and renames with the
 * plain SFTP rename, which OpenSSH refuses onto an existing file. Later attempts and resends
 * replace their own earlier file with posix-rename@openssh.com (atomic), or, on servers without
 * it, by removing the old file first.
 *
 * A folder template starting with "/" is absolute; otherwise it is relative to the login folder.
 */

type Settings = DestinationSettings<'sftp'>;

type SftpTarget = {
  /** The folder as rendered: "" (the login folder), "reports/2026-10" or "/srv/in". */
  folder: string;
  paths: string[];
  /** The attempt that fixed the target: the first one that can have written anything. */
  fixedOnAttempt: number;
};

const joinPath = (folder: string, name: string) =>
  !folder ? name : folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`;

function requireConnection(conn: OpenConnection<SftpConfig> | null): OpenConnection<SftpConfig> {
  if (!conn)
    throw new DeliveryError('The destination has no SFTP connection', {
      permanent: true,
      errorClass: 'settings',
    });
  return conn;
}

async function planTarget(ctx: DeliveryContext, settings: Settings): Promise<SftpTarget> {
  const planned = await plannedUploads(ctx, settings.folder);
  const absolute = settings.folder.trim().startsWith('/');
  const folder = absolute ? `/${planned.folder}` : planned.folder;
  const paths = planned.files.map((f) => joinPath(folder, f.name));
  // File names come from the renderers; refuse anything that would leave the folder anyway.
  for (const f of planned.files)
    if (!f.name || f.name.includes('/') || f.name === '.' || f.name === '..')
      throw new DeliveryError('A document has an unusable file name', {
        permanent: true,
        errorClass: 'internal',
        detail: f.name,
      });
  return { folder, paths, fixedOnAttempt: ctx.delivery.attempt };
}

/** The target fixed for this generation (or planned now), lined up with the rendered files. */
async function targetFor(ctx: DeliveryContext, settings: Settings): Promise<SftpTarget> {
  const t = ctx.target as Partial<SftpTarget> | null;
  if (!t || !Array.isArray(t.paths)) return planTarget(ctx, settings);
  if (t.paths.length !== ctx.files.length)
    throw new DeliveryError("The destination's formats changed during this delivery; resend it", {
      permanent: true,
      errorClass: 'settings',
      detail: `${t.paths.length} planned, ${ctx.files.length} rendered`,
    });
  return {
    folder: typeof t.folder === 'string' ? t.folder : '',
    paths: t.paths.map(String),
    fixedOnAttempt: typeof t.fixedOnAttempt === 'number' ? t.fixedOnAttempt : 1,
  };
}

type OpError = Error & { code?: string | number };

/**
 * An SFTP status (or ssh2-sftp-client's code for one) as a DeliveryError. The server's own
 * message is never passed on; the detail names the operation, our path and the status code.
 */
function opError(op: string, path: string, err: unknown): DeliveryError {
  const code = (err as OpError)?.code;
  const message = (err as OpError)?.message ?? '';
  const detail = `${op} ${path}${code !== undefined ? ` (status ${code})` : ''}`;
  if (code === 2 || code === 'ENOENT')
    return new DeliveryError('The SFTP folder or file was not found', {
      permanent: true,
      errorClass: 'not_found',
      detail,
    });
  if (code === 3 || code === 'EACCES' || (code === 'ERR_BAD_PATH' && /permission/i.test(message)))
    return new DeliveryError('The SFTP server denied permission', {
      permanent: true,
      errorClass: 'rejected',
      detail,
    });
  if (code === 'ERR_BAD_PATH')
    return new DeliveryError('The SFTP folder could not be created', {
      permanent: true,
      errorClass: 'not_found',
      detail,
    });
  if (code === 5 || code === 8)
    return new DeliveryError('The SFTP server does not support the operation', {
      permanent: true,
      errorClass: 'rejected',
      detail,
    });
  if (code === 4)
    // SSH_FX_FAILURE is SFTP v3's catch-all (a full disk among others): worth retrying.
    return new DeliveryError('The SFTP server reported a failure', {
      permanent: false,
      errorClass: 'rejected',
      detail,
    });
  return new DeliveryError('The SFTP connection was lost', {
    permanent: false,
    errorClass: 'unreachable',
    detail,
  });
}

/** Runs one SFTP operation with the attempt's deadline and safe errors. */
async function step<T>(
  env: AdapterEnv,
  op: string,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (env.signal.aborted) throw timedOut();
  try {
    return await fn();
  } catch (err) {
    if (env.signal.aborted) throw timedOut();
    if (err instanceof DeliveryError) throw err;
    throw opError(op, path, err);
  }
}

type Stats = Awaited<ReturnType<SftpSession['client']['stat']>>;

/** stat(), or null when nothing is at the path. */
async function statOrNull(s: SftpSession, env: AdapterEnv, path: string): Promise<Stats | null> {
  try {
    return await step(env, 'stat', path, () => s.client.stat(path));
  } catch (err) {
    if (err instanceof DeliveryError && err.errorClass === 'not_found') return null;
    throw err;
  }
}

/** Creates the folder and any missing parents (like mkdir -p). */
async function mkdirp(s: SftpSession, env: AdapterEnv, folder: string): Promise<void> {
  const existing = await statOrNull(s, env, folder);
  if (existing?.isDirectory) return;
  if (existing)
    throw new DeliveryError('A file is in the way of the SFTP folder', {
      permanent: true,
      errorClass: 'rejected',
      detail: folder,
    });
  const parts = folder.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!dir) continue;
    const st = await statOrNull(s, env, dir);
    if (st?.isDirectory) continue;
    if (st)
      throw new DeliveryError('A file is in the way of the SFTP folder', {
        permanent: true,
        errorClass: 'rejected',
        detail: dir,
      });
    try {
      await step(env, 'mkdir', dir, () => s.client.mkdir(dir, false));
    } catch (err) {
      // Another worker may have created it meanwhile.
      if ((await statOrNull(s, env, dir))?.isDirectory) continue;
      throw err;
    }
  }
}

const conflict = (path: string) =>
  new DeliveryError('A file with that name belongs to another submission', {
    permanent: true,
    errorClass: 'conflict',
    detail: path,
  });

const posixRenameMissing = (err: unknown) =>
  /does not support/i.test((err as OpError)?.message ?? '') || (err as OpError)?.code === 8;

/** Moves the uploaded temporary file onto its final name (see the module comment). */
async function place(
  s: SftpSession,
  env: AdapterEnv,
  tmp: string,
  final: string,
  firstUpload: boolean,
): Promise<void> {
  if (firstUpload) {
    try {
      await step(env, 'rename', final, () => s.client.rename(tmp, final));
    } catch (err) {
      if (env.signal.aborted) throw err;
      if (await statOrNull(s, env, final)) throw conflict(final);
      throw err;
    }
    return;
  }
  try {
    await s.client.posixRename(tmp, final);
    return;
  } catch (err) {
    if (env.signal.aborted) throw timedOut();
    if (!posixRenameMissing(err)) throw opError('posix-rename', final, err);
  }
  // No posix-rename: this delivery's earlier file is removed first (not atomic, but only ours).
  if (await statOrNull(s, env, final))
    await step(env, 'remove', final, () => s.client.delete(final));
  await step(env, 'rename', final, () => s.client.rename(tmp, final));
}

/** Absolute paths: ssh2-sftp-client rewrites relative paths that start with "." itself. */
const absolutePath = (home: string, p: string) =>
  p.startsWith('/') ? posix.normalize(p) : posix.join(home || '/', p || '.');

async function loginFolder(s: SftpSession, env: AdapterEnv): Promise<string> {
  const home = await step(env, 'realpath', '.', () => s.client.realPath('.'));
  return home.startsWith('/') ? home : '/';
}

export const sftpAdapter: DestinationAdapter<Settings, SftpConfig> = {
  kind: 'sftp',

  async resolveTarget(ctx, settings) {
    return planTarget(ctx, settings);
  },

  async deliver(ctx, settings, conn, env) {
    const c = requireConnection(conn);
    const target = await targetFor(ctx, settings);
    // The attempt that fixed the target is the first that can have written anything, so a file
    // already at a final name is not this delivery's. Test files ("TEST " names) may be replaced.
    const firstUpload =
      !ctx.test && ctx.delivery.generation === 1 && target.fixedOnAttempt === ctx.delivery.attempt;
    const where = { host: c.config.host, port: c.config.port ?? 22, folder: target.folder };
    // e.g. the photos format of a submission without photos.
    if (!ctx.files.length)
      return {
        outcome: 'skipped',
        detail: 'There were no documents to upload',
        target: { ...where, paths: [] },
        evidence: {},
      };
    const s = await connectSftp(c, env);
    try {
      const home = await loginFolder(s, env);
      await mkdirp(s, env, absolutePath(home, target.folder));
      const finals = target.paths.map((p) => absolutePath(home, p));
      if (firstUpload)
        for (const final of finals) if (await statOrNull(s, env, final)) throw conflict(final);

      const sizes: number[] = [];
      for (const [i, file] of ctx.files.entries()) {
        const final = finals[i]!;
        const tmp = posix.join(
          posix.dirname(final),
          `.${posix.basename(final)}.${ctx.delivery.idempotencyKey}.${ctx.delivery.attempt}.part`,
        );
        try {
          await step(env, 'upload', tmp, () => s.client.put(file.data, tmp));
          // ssh2's write stream can end "successfully" after the server refused a write, so
          // the size the server holds is checked before the file gets its real name.
          const st = await step(env, 'stat', tmp, () => s.client.stat(tmp));
          if (st.size !== file.data.length)
            throw new DeliveryError('The upload to the SFTP server was incomplete', {
              permanent: false,
              errorClass: 'unreachable',
              detail: `${tmp}: ${st.size} of ${file.data.length} bytes`,
            });
          await place(s, env, tmp, final, firstUpload);
          sizes.push(st.size);
        } catch (err) {
          await s.client.delete(tmp, true).catch(() => undefined);
          throw err;
        }
      }
      return {
        outcome: 'delivered',
        target: { ...where, paths: target.paths },
        evidence: { paths: finals, sizes },
      };
    } finally {
      await s.close();
    }
  },

  /**
   * Read-only: the fixed part of the folder template (before any Liquid tag) exists, or the
   * nearest folder above it does, so it can be created when the first file arrives.
   */
  async check(settings, conn, env): Promise<CheckResult> {
    const c = requireConnection(conn);
    const template = settings.folder.trim();
    const fixedPart = template.split(/\{[{%]/)[0]!;
    const dynamic = fixedPart.length < template.length;
    const segments = fixedPart.split('/');
    // A segment cut by a tag is dynamic too.
    if (dynamic) segments.pop();
    const folder = segments
      .map((seg) => safeFilename(seg, '', 'x').replace(/\.x$/, ''))
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('/');
    const s = await connectSftp(c, env);
    try {
      const home = await loginFolder(s, env);
      const abs = absolutePath(home, template.startsWith('/') ? `/${folder}` : folder);
      const note = dynamic ? ' (subfolders from the template are created when delivering)' : '';
      const st = await statOrNull(s, env, abs);
      if (st?.isDirectory)
        return { ok: true, summary: `Folder ${abs} exists${note}`, facts: { folder: abs } };
      if (st)
        return { ok: false, summary: `${abs} is a file, not a folder`, facts: { folder: abs } };
      let parent = posix.dirname(abs);
      while (parent !== '/' && !(await statOrNull(s, env, parent))) parent = posix.dirname(parent);
      const pst = await statOrNull(s, env, parent);
      if (!pst?.isDirectory)
        return { ok: false, summary: `${parent} is not a folder`, facts: { folder: abs } };
      return {
        ok: true,
        summary: `Folder ${abs} does not exist yet; it will be created in ${parent}${note}`,
        facts: { folder: abs },
      };
    } finally {
      await s.close();
    }
  },
};
