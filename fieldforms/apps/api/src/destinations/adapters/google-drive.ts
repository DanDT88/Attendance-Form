import { randomBytes } from 'node:crypto';
import type { DestinationSettings } from '@fieldforms/shared';
import type { RenderedFile } from '../../outputs/types.js';
import { plannedUploads, uploadName } from '../naming.js';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type DeliveryContext,
  type DestinationAdapter,
  type OpenConnection,
} from '../types.js';
import { DRIVE_SCOPE, googleApi, type GoogleConfig } from '../vendors/google-auth.js';
import {
  requireConnection,
  requireString,
  unexpectedReply,
  vendorRequest,
  type VendorApi,
} from '../vendors/http.js';

/**
 * Google Drive: files go into a folder on a Shared Drive (service accounts have no storage of
 * their own), in subfolders from the folder template, created when missing.
 *
 * Idempotency: the target fixes one pre-generated file id per file (files.generateIds), so a
 * retry after a lost reply creates the same id again and Drive answers 409: already there. A
 * resend (a later generation) finds the delivery's earlier files by their `fieldformsDelivery`
 * app property and replaces their content; files it cannot find are created.
 */

type Settings = DestinationSettings<'google_drive'>;

const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Drive's simple and multipart uploads take up to 5 MB; larger files use a resumable session. */
export const DRIVE_SIMPLE_LIMIT = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 180_000;
const ALL_DRIVES = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: 'allDrives',
} as const;

export interface DriveTarget {
  /** The configured Shared Drive folder. */
  folderId: string;
  /** The folder the files go into (the configured one, or a subfolder of it). */
  parentId: string;
  folder: string;
  files: { name: string; id: string }[];
}

/** A string literal in a Drive query: backslashes and quotes escaped. */
export const driveLiteral = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const mapDriveError: VendorApi['mapError'] = (info, detail) => {
  if (info.reason === 'storageQuotaExceeded')
    return new DeliveryError(
      'Service accounts have no Drive storage of their own: choose a folder on a Shared Drive and add the service account to it',
      { permanent: true, errorClass: 'settings', detail, status: info.status },
    );
  if (info.reason === 'insufficientFilePermissions')
    return new DeliveryError(
      'The service account may not add files to the folder: give it the Contributor role or above',
      { permanent: true, errorClass: 'credentials', detail, status: info.status },
    );
  return undefined;
};

const driveApi = (conn: OpenConnection<GoogleConfig> | null, env: AdapterEnv) =>
  googleApi('Google Drive', requireConnection(conn, 'Google'), DRIVE_SCOPE, env, mapDriveError);

const NOT_FOUND = 'The Drive folder was not found, or it is not shared with the service account';

interface DriveFile {
  id: string;
  name?: string;
  createdTime?: string;
}

/** Files matching a query, across pages (a delivery of photos can have many). */
async function listFiles(api: VendorApi, q: string, fields: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const reply = await vendorRequest(api, `${api.env.endpoints.googleDrive}/files`, {
      query: {
        q,
        fields: `nextPageToken,files(${fields})`,
        pageSize: 1000,
        pageToken,
        ...ALL_DRIVES,
      },
    });
    const j = reply.json<{ files?: DriveFile[]; nextPageToken?: unknown }>();
    if (Array.isArray(j.files)) out.push(...j.files.filter((f) => typeof f?.id === 'string'));
    pageToken =
      typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

/** The oldest folder of that name in the parent, so concurrent creators settle on one. */
async function findFolder(api: VendorApi, parent: string, name: string) {
  const q = `${driveLiteral(parent)} in parents and name=${driveLiteral(name)} and mimeType='${FOLDER_MIME}' and trashed=false`;
  const files = await listFiles(api, q, 'id,name,createdTime');
  files.sort(
    (a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || a.id.localeCompare(b.id),
  );
  return files[0]?.id ?? null;
}

async function createFolder(api: VendorApi, parent: string, name: string): Promise<string> {
  const reply = await vendorRequest(api, `${api.env.endpoints.googleDrive}/files`, {
    query: { supportsAllDrives: true, fields: 'id' },
    json: { name, mimeType: FOLDER_MIME, parents: [parent] },
    notFound: NOT_FOUND,
  });
  const created = requireString(api, reply.json<{ id?: unknown }>().id, 'folder id');
  // Another delivery may have created the same folder at the same moment: everyone settles on
  // the oldest. The spare one is left (empty) rather than trashed, since a delivery that saw
  // only it may be uploading into it.
  return (await findFolder(api, parent, name)) ?? created;
}

/** Finds or creates each folder segment under the configured folder; returns the last one's id. */
export async function ensureFolders(api: VendorApi, root: string, folder: string): Promise<string> {
  let parent = root;
  for (const name of folder.split('/').filter(Boolean))
    parent = (await findFolder(api, parent, name)) ?? (await createFolder(api, parent, name));
  return parent;
}

async function generateIds(api: VendorApi, count: number): Promise<string[]> {
  if (!count) return [];
  const reply = await vendorRequest(api, `${api.env.endpoints.googleDrive}/files/generateIds`, {
    query: { count, space: 'drive', type: 'files' },
  });
  const ids = reply.json<{ ids?: unknown }>().ids;
  if (
    !Array.isArray(ids) ||
    ids.length < count ||
    !ids.every((i) => typeof i === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(i))
  )
    unexpectedReply(api, 'generated ids');
  return (ids as string[]).slice(0, count);
}

/** multipart/related: the metadata part, then the content. */
function multipart(metadata: unknown, file: RenderedFile): { body: Buffer; contentType: string } {
  const boundary = `fieldforms-${randomBytes(16).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/**
 * A resumable upload in one PUT, for files over the multipart limit. The session URL must be on
 * the upload endpoint's origin: file content never goes anywhere else.
 */
async function resumable(
  api: VendorApi,
  method: 'POST' | 'PATCH',
  url: string,
  metadata: unknown,
  file: RenderedFile,
): Promise<{ status: number; id?: string }> {
  const start = await vendorRequest(api, url, {
    method,
    query: { uploadType: 'resumable', supportsAllDrives: true, fields: 'id' },
    json: metadata,
    headers: {
      'x-upload-content-type': file.contentType,
      'x-upload-content-length': String(file.data.length),
    },
    allow: [409],
    notFound: NOT_FOUND,
  });
  if (start.status === 409) return { status: 409 };
  const location = start.headers.get('location') ?? '';
  let session: URL | null = null;
  try {
    session = new URL(location);
  } catch {
    /* checked below */
  }
  if (!session || session.origin !== new URL(api.env.endpoints.googleUpload).origin)
    throw new DeliveryError('Google Drive sent an unexpected reply', {
      permanent: false,
      errorClass: 'unreachable',
      detail: 'The upload session is not on the upload endpoint',
    });
  const done = await vendorRequest(api, session.toString(), {
    method: 'PUT',
    body: file.data,
    contentType: file.contentType,
    allow: [409],
    label: 'upload session',
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  if (done.status === 409) return { status: 409 };
  return { status: done.status, id: done.json<{ id?: string }>().id };
}

/** Creates a file with its pre-generated id: 'created', or 'exists' if that id is taken (409). */
async function createFile(
  api: VendorApi,
  ctx: DeliveryContext,
  parentId: string,
  name: string,
  id: string,
  file: RenderedFile,
): Promise<'created' | 'exists'> {
  const metadata = {
    id,
    name,
    parents: [parentId],
    appProperties: {
      fieldformsDelivery: ctx.delivery.id,
      fieldformsGeneration: String(ctx.delivery.generation),
    },
  };
  const url = `${api.env.endpoints.googleUpload}/files`;
  if (file.data.length > DRIVE_SIMPLE_LIMIT) {
    const r = await resumable(api, 'POST', url, metadata, file);
    return r.status === 409 ? 'exists' : 'created';
  }
  const { body, contentType } = multipart(metadata, file);
  const reply = await vendorRequest(api, url, {
    method: 'POST',
    query: { uploadType: 'multipart', supportsAllDrives: true, fields: 'id' },
    body,
    contentType,
    allow: [409],
    notFound: NOT_FOUND,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  return reply.status === 409 ? 'exists' : 'created';
}

/** Replaces an earlier file's content (a resend). */
async function updateFile(api: VendorApi, id: string, file: RenderedFile): Promise<void> {
  const url = `${api.env.endpoints.googleUpload}/files/${encodeURIComponent(id)}`;
  if (file.data.length > DRIVE_SIMPLE_LIMIT) {
    const r = await resumable(api, 'PATCH', url, {}, file);
    if (r.status === 409) unexpectedReply(api, 'updated file');
    return;
  }
  await vendorRequest(api, url, {
    method: 'PATCH',
    query: { uploadType: 'media', supportsAllDrives: true, fields: 'id' },
    body: file.data,
    contentType: file.contentType,
    notFound: 'The earlier file of this delivery was not found',
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

function readTarget(t: Record<string, unknown> | null): DriveTarget | null {
  if (!t || typeof t.parentId !== 'string' || !Array.isArray(t.files)) return null;
  const files = (t.files as { name?: unknown; id?: unknown }[]).filter(
    (f): f is { name: string; id: string } =>
      typeof f?.name === 'string' && typeof f?.id === 'string',
  );
  return {
    folderId: String(t.folderId ?? ''),
    parentId: t.parentId,
    folder: String(t.folder ?? ''),
    files,
  };
}

async function resolve(
  api: VendorApi,
  ctx: DeliveryContext,
  settings: Settings,
): Promise<DriveTarget> {
  const planned = await plannedUploads(ctx, settings.folder);
  // Nothing to upload (an images format without photos): no folders either.
  const parentId = planned.files.length
    ? await ensureFolders(api, settings.folderId, planned.folder)
    : settings.folderId;
  const ids = await generateIds(api, planned.files.length);
  return {
    folderId: settings.folderId,
    parentId,
    folder: planned.folder,
    files: planned.files.map((f, i) => ({ name: f.name, id: ids[i]! })),
  };
}

export const googleDriveAdapter: DestinationAdapter<Settings, GoogleConfig> = {
  kind: 'google_drive',

  async resolveTarget(ctx, settings, conn, env) {
    const api = await driveApi(conn, env);
    return { ...(await resolve(api, ctx, settings)) };
  },

  async deliver(ctx, settings, conn, env) {
    const api = await driveApi(conn, env);
    const target = readTarget(ctx.target) ?? (await resolve(api, ctx, settings));
    if (!ctx.files.length)
      return {
        outcome: 'skipped',
        detail: 'There were no documents to upload',
        target: { ...target },
        evidence: {},
      };

    // Pair each document with its fixed name and id. If the settings changed between attempts
    // and a document has no id yet, it gets one now.
    const uploads: { name: string; id: string; file: RenderedFile }[] = [];
    const unpaired: RenderedFile[] = [];
    const byName = new Map(target.files.map((f) => [f.name, f.id]));
    for (const file of ctx.files) {
      const name = uploadName(ctx, file);
      const id = byName.get(name);
      if (id) uploads.push({ name, id, file });
      else unpaired.push(file);
    }
    if (unpaired.length) {
      const ids = await generateIds(api, unpaired.length);
      unpaired.forEach((file, i) =>
        uploads.push({ name: uploadName(ctx, file), id: ids[i]!, file }),
      );
    }

    // A resend replaces the files the delivery made before (found by its app property).
    const earlier =
      ctx.delivery.generation > 1
        ? await listFiles(
            api,
            `appProperties has { key='fieldformsDelivery' and value=${driveLiteral(ctx.delivery.id)} } and trashed=false`,
            'id,name',
          )
        : [];

    const results: { name: string; id: string; status: 'created' | 'updated' | 'present' }[] = [];
    for (const u of uploads) {
      const before = earlier.find((f) => f.name === u.name);
      if (before) {
        await updateFile(api, before.id, u.file);
        results.push({ name: u.name, id: before.id, status: 'updated' });
        continue;
      }
      const r = await createFile(api, ctx, target.parentId, u.name, u.id, u.file);
      results.push({ name: u.name, id: u.id, status: r === 'exists' ? 'present' : 'created' });
    }

    return {
      outcome: results.every((r) => r.status === 'present') ? 'already_present' : 'delivered',
      target: {
        folderId: target.folderId,
        parentId: target.parentId,
        folder: target.folder,
        files: results.map((r) => ({ name: r.name, id: r.id })),
      },
      evidence: {
        fileIds: results.map((r) => r.id),
        created: results.filter((r) => r.status === 'created').length,
        updated: results.filter((r) => r.status === 'updated').length,
        alreadyPresent: results.filter((r) => r.status === 'present').length,
      },
    };
  },

  async check(settings, conn, env): Promise<CheckResult> {
    const api = await driveApi(conn, env);
    const reply = await vendorRequest(
      api,
      `${env.endpoints.googleDrive}/files/${encodeURIComponent(settings.folderId)}`,
      {
        query: {
          fields: 'id,name,driveId,mimeType,trashed,capabilities(canAddChildren)',
          supportsAllDrives: true,
        },
        notFound: NOT_FOUND,
      },
    );
    const f = reply.json<{
      name?: string;
      driveId?: string;
      mimeType?: string;
      trashed?: boolean;
      capabilities?: { canAddChildren?: boolean };
    }>();
    const name = f.name ?? settings.folderId;
    if (f.mimeType !== FOLDER_MIME)
      return { ok: false, summary: `'${name}' is a file, not a folder` };
    if (!f.driveId)
      return {
        ok: false,
        summary: `The folder '${name}' is in someone's My Drive. Service accounts have no Drive storage of their own: choose a folder on a Shared Drive and add the service account to it.`,
        facts: { folder: name },
      };
    // The drive's name needs membership of the drive itself; access to the folder is enough to deliver.
    const drive = await vendorRequest(
      api,
      `${env.endpoints.googleDrive}/drives/${encodeURIComponent(f.driveId)}`,
      { query: { fields: 'name' }, allow: [403, 404] },
    );
    const driveName = drive.status === 200 ? drive.json<{ name?: string }>().name : undefined;
    const warnings: string[] = [];
    if (f.trashed) warnings.push('The folder is in the trash');
    if (f.capabilities?.canAddChildren === false)
      warnings.push(
        'The service account cannot add files to this folder: give it the Contributor role or above',
      );
    return {
      ok: !f.trashed && f.capabilities?.canAddChildren !== false,
      summary: driveName
        ? `Folder '${name}' on the '${driveName}' Shared Drive`
        : `Folder '${name}' on a Shared Drive`,
      facts: { folder: name, drive: driveName ?? f.driveId },
      warnings,
    };
  },
};
