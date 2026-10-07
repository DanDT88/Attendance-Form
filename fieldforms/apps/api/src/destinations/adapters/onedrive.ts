import type { DestinationSettings } from '@fieldforms/shared';
import type { RenderedFile } from '../../outputs/types.js';
import { renderLiquid } from '../../lib/liquid.js';
import { plannedUploads, renderFolder, uploadName } from '../naming.js';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type DeliveryContext,
  type DestinationAdapter,
  type OpenConnection,
} from '../types.js';
import { graphApi, type MicrosoftConfig } from '../vendors/microsoft-auth.js';
import {
  requireConnection,
  requireString,
  unexpectedReply,
  vendorRequest,
  type VendorApi,
} from '../vendors/http.js';

/**
 * OneDrive and SharePoint through Microsoft Graph: a document library on a site, or a user's
 * OneDrive. Files are uploaded by path (Graph creates missing folders) with conflictBehavior
 * `fail`, then tagged with the delivery id in their description. When the name is taken, the
 * file is replaced only if its description names this delivery (a retry or a resend); a file
 * with exactly our content is already there (a retry whose tag was lost); anything else belongs
 * to another submission and fails the delivery as a conflict.
 */

type Settings = DestinationSettings<'onedrive'>;
type Location = Settings['location'];

/** Graph's simple upload takes up to 4 MB; larger files go through an upload session. */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Session chunks: a multiple of 320 KiB, at most 3.75 MiB (12 × 320 KiB). */
export const SESSION_CHUNK = 12 * 320 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface OneDriveTarget {
  driveId: string;
  /** Library or OneDrive name, for display. */
  drive: string;
  site?: string;
  folderPath: string;
  files: string[];
}

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  description?: string;
  eTag?: string;
  folder?: unknown;
  '@microsoft.graph.downloadUrl'?: string;
}

const tagOf = (deliveryId: string) => `FieldForms delivery ${deliveryId}`;

/** Each path segment percent-encoded; "/" stays the separator. */
export const encodePath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');

/** Graph ids (sites carry commas: "host,guid,guid"). */
const encodeId = (id: string) => encodeURIComponent(id).replace(/%2C/gi, ',');

const mapGraphError: VendorApi['mapError'] = (info, detail) => {
  if (info.status === 401 || info.status === 403)
    return new DeliveryError('The app has no access to this site or drive', {
      permanent: true,
      errorClass: 'credentials',
      detail,
      status: info.status,
    });
  // Locked (open for editing elsewhere): worth waiting for.
  if (info.status === 423)
    return new DeliveryError('The file is locked', {
      permanent: false,
      errorClass: 'unreachable',
      detail,
      status: info.status,
    });
  return undefined;
};

const oneDriveApi = (conn: OpenConnection<MicrosoftConfig> | null, env: AdapterEnv) =>
  graphApi(requireConnection(conn, 'Microsoft'), env, mapGraphError);

/** The site's host and server-relative path ("/sites/Ops"), from the URL an admin pasted. */
export function sitePathOf(siteUrl: string): { host: string; path: string } {
  let u: URL;
  try {
    u = new URL(siteUrl);
  } catch {
    throw new DeliveryError('The SharePoint site URL is not valid', {
      permanent: true,
      errorClass: 'settings',
    });
  }
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(u.hostname))
    throw new DeliveryError('The SharePoint site URL is not valid', {
      permanent: true,
      errorClass: 'settings',
    });
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  // ".../sites/Ops/Shared Documents/Forms/AllItems.aspx" is the Ops site; a bare host is the root site.
  const path =
    (segs[0]?.toLowerCase() === 'sites' || segs[0]?.toLowerCase() === 'teams') && segs[1]
      ? `/${segs[0]}/${segs[1]}`
      : '';
  return { host: u.hostname.toLowerCase(), path };
}

/** Pages of a Graph collection, following @odata.nextLink on the Graph origin only. */
async function collection<T>(api: VendorApi, url: string, notFound: string): Promise<T[]> {
  const out: T[] = [];
  const origin = new URL(api.env.endpoints.microsoftGraph).origin;
  let next: string | undefined = url;
  for (let page = 0; next && page < 10; page++) {
    const j: { value?: T[]; '@odata.nextLink'?: unknown } = (
      await vendorRequest(api, next, { notFound })
    ).json();
    out.push(...(Array.isArray(j.value) ? j.value : []));
    const link = j['@odata.nextLink'];
    next = typeof link === 'string' && link.startsWith(`${origin}/`) ? link : undefined;
  }
  return out;
}

/** The drive (library or OneDrive) a location names. */
export async function resolveDrive(
  api: VendorApi,
  location: Location,
): Promise<{ driveId: string; drive: string; site?: string }> {
  const graph = api.env.endpoints.microsoftGraph;
  if (location.type === 'user') {
    const reply = await vendorRequest(
      api,
      `${graph}/users/${encodeURIComponent(location.user)}/drive`,
      {
        query: { $select: 'id,name,driveType' },
        notFound: 'The user was not found, or has no OneDrive',
      },
    );
    const d = reply.json<{ id?: unknown; name?: unknown }>();
    return {
      driveId: requireString(api, d.id, 'drive id'),
      drive: typeof d.name === 'string' ? d.name : 'OneDrive',
    };
  }
  const { host, path } = sitePathOf(location.siteUrl);
  const siteReply = await vendorRequest(
    api,
    path ? `${graph}/sites/${host}:/${encodePath(path)}` : `${graph}/sites/${host}`,
    { query: { $select: 'id,displayName,name' }, notFound: 'The SharePoint site was not found' },
  );
  const site = siteReply.json<{ id?: unknown; displayName?: unknown; name?: unknown }>();
  const siteId = requireString(api, site.id, 'site id');
  const siteName =
    typeof site.displayName === 'string'
      ? site.displayName
      : typeof site.name === 'string'
        ? site.name
        : host;
  const drives = await collection<{ id?: string; name?: string; webUrl?: string }>(
    api,
    `${graph}/sites/${encodeId(siteId)}/drives?$select=id,name,webUrl`,
    'The SharePoint site was not found',
  );
  const want = location.library.trim().toLowerCase();
  const lastSegment = (url?: string) => {
    try {
      return decodeURIComponent(new URL(url ?? '').pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      return '';
    }
  };
  // A library is listed by its title ("Documents"); its URL may differ ("Shared Documents").
  const lib =
    drives.find((d) => d.name?.trim().toLowerCase() === want) ??
    drives.find((d) => lastSegment(d.webUrl).toLowerCase() === want);
  if (!lib?.id)
    throw new DeliveryError(`There is no library named '${location.library}' on the site`, {
      permanent: true,
      errorClass: 'not_found',
    });
  return { driveId: lib.id, drive: lib.name ?? location.library, site: siteName };
}

const itemUrl = (api: VendorApi, driveId: string, path: string) =>
  `${api.env.endpoints.microsoftGraph}/drives/${encodeId(driveId)}/root:/${encodePath(path)}`;

type Behavior = 'fail' | 'replace';

/** One upload: the item, or 'conflict' when the name is taken and behaviour is 'fail'. */
async function upload(
  api: VendorApi,
  driveId: string,
  path: string,
  file: RenderedFile,
  behavior: Behavior,
): Promise<DriveItem | 'conflict'> {
  const base = itemUrl(api, driveId, path);
  if (file.data.length <= SIMPLE_UPLOAD_LIMIT) {
    // Written by hand: Graph expects the "@" of this parameter as it is.
    const reply = await vendorRequest(
      api,
      `${base}:/content?@microsoft.graph.conflictBehavior=${behavior}`,
      {
        method: 'PUT',
        body: file.data,
        contentType: file.contentType,
        allow: [409],
        notFound: 'The drive was not found',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      },
    );
    return reply.status === 409 ? 'conflict' : reply.json<DriveItem>();
  }
  const created = await vendorRequest(api, `${base}:/createUploadSession`, {
    method: 'POST',
    json: { item: { '@microsoft.graph.conflictBehavior': behavior } },
    allow: [409],
    notFound: 'The drive was not found',
  });
  if (created.status === 409) return 'conflict';
  const uploadUrl = requireString(
    api,
    created.json<{ uploadUrl?: unknown }>().uploadUrl,
    'uploadUrl',
  );
  // The session URL is pre-authenticated (a token in its path or query): never send ours to it,
  // and never put it in a detail.
  const session = { ...api, token: undefined };
  try {
    const total = file.data.length;
    for (let start = 0; start < total; start += SESSION_CHUNK) {
      const end = Math.min(total, start + SESSION_CHUNK);
      const reply = await vendorRequest(session, uploadUrl, {
        method: 'PUT',
        body: file.data.subarray(start, end),
        contentType: 'application/octet-stream',
        headers: { 'content-range': `bytes ${start}-${end - 1}/${total}` },
        allow: [409],
        label: 'upload session',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      if (reply.status === 409) return 'conflict';
      if (end === total) return reply.json<DriveItem>();
    }
    return unexpectedReply(api, 'uploaded item');
  } catch (err) {
    // Best effort: cancel the session so the partial upload is discarded.
    await vendorRequest(session, uploadUrl, {
      method: 'DELETE',
      label: 'upload session',
      allow: [404],
    }).catch(() => undefined);
    throw err;
  }
}

/**
 * Sets the item's description to the delivery tag; false when the drive refused or did not
 * keep it (Graph documents `description` for OneDrive personal). The file is delivered either
 * way, so a refusal does not fail the delivery.
 */
async function tag(api: VendorApi, driveId: string, itemId: string, deliveryId: string) {
  const reply = await vendorRequest(
    api,
    `${api.env.endpoints.microsoftGraph}/drives/${encodeId(driveId)}/items/${encodeURIComponent(itemId)}`,
    { method: 'PATCH', json: { description: tagOf(deliveryId) }, allow: [400] },
  );
  if (reply.status === 400) return false;
  const kept = reply.json<DriveItem>().description;
  return kept === tagOf(deliveryId);
}

/** Whether the existing item holds exactly these bytes (compared by size, then content). */
async function sameContent(api: VendorApi, item: DriveItem, file: RenderedFile): Promise<boolean> {
  const url = item['@microsoft.graph.downloadUrl'];
  if (item.size !== file.data.length || typeof url !== 'string') return false;
  const reply = await vendorRequest({ ...api, token: undefined }, url, {
    label: 'download',
    maxBytes: file.data.length + 1,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  return reply.body.equals(file.data);
}

function readTarget(t: Record<string, unknown> | null): OneDriveTarget | null {
  if (!t || typeof t.driveId !== 'string' || typeof t.folderPath !== 'string') return null;
  return {
    driveId: t.driveId,
    drive: String(t.drive ?? ''),
    site: typeof t.site === 'string' ? t.site : undefined,
    folderPath: t.folderPath,
    files: Array.isArray(t.files) ? t.files.filter((f): f is string => typeof f === 'string') : [],
  };
}

export const onedriveAdapter: DestinationAdapter<Settings, MicrosoftConfig> = {
  kind: 'onedrive',

  async resolveTarget(ctx, settings, conn, env) {
    const api = await oneDriveApi(conn, env);
    const drive = await resolveDrive(api, settings.location);
    const planned = await plannedUploads(ctx, settings.folder);
    const target: OneDriveTarget = {
      ...drive,
      folderPath: planned.folder,
      files: planned.files.map((f) => f.name),
    };
    return { ...target };
  },

  async deliver(ctx, settings, conn, env) {
    const api = await oneDriveApi(conn, env);
    let target = readTarget(ctx.target);
    if (!target) {
      const drive = await resolveDrive(api, settings.location);
      const planned = await plannedUploads(ctx, settings.folder);
      target = { ...drive, folderPath: planned.folder, files: planned.files.map((f) => f.name) };
    }
    if (!ctx.files.length)
      return {
        outcome: 'skipped',
        detail: 'There were no documents to upload',
        target: { ...target },
        evidence: {},
      };

    const items: { name: string; id?: string; status: 'created' | 'replaced' | 'present' }[] = [];
    const warnings = new Set<string>();
    for (const file of ctx.files) {
      const name = uploadName(ctx, file);
      const path = target.folderPath ? `${target.folderPath}/${name}` : name;
      let item = await upload(api, target.driveId, path, file, 'fail');
      let status: 'created' | 'replaced' | 'present' = 'created';
      if (item === 'conflict') {
        const existing = (
          await vendorRequest(api, itemUrl(api, target.driveId, path), {
            notFound: 'The file could not be read back',
          })
        ).json<DriveItem>();
        if (existing.description?.includes(ctx.delivery.id)) {
          // Ours: a retry, or a resend replacing the earlier file of this delivery.
          item = await upload(api, target.driveId, path, file, 'replace');
          if (item === 'conflict') unexpectedReply(api, 'replaced item');
          status = 'replaced';
        } else if (await sameContent(api, existing, file)) {
          // Exactly what we would write: an earlier attempt whose reply or tag was lost.
          item = existing;
          status = 'present';
        } else {
          throw new DeliveryError('Name already used by another submission', {
            permanent: true,
            errorClass: 'conflict',
            detail: `${name} exists in ${target.drive} and is not from this delivery`,
          });
        }
      }
      const id = (item as DriveItem).id;
      if (id && !(await tag(api, target.driveId, id, ctx.delivery.id)))
        warnings.add(
          'The library did not keep the delivery tag (file description), so a resend with changed documents will report a name conflict',
        );
      items.push({ name, id, status });
    }

    return {
      outcome: items.every((i) => i.status === 'present') ? 'already_present' : 'delivered',
      target: {
        driveId: target.driveId,
        drive: target.drive,
        ...(target.site ? { site: target.site } : {}),
        folderPath: target.folderPath,
        files: items.map((i) => i.name),
      },
      evidence: {
        items: items.map((i) => ({ name: i.name, id: i.id ?? null, status: i.status })),
        ...(warnings.size ? { warning: [...warnings].join('; ') } : {}),
      },
    };
  },

  async check(settings, conn, env): Promise<CheckResult> {
    const api = await oneDriveApi(conn, env);
    const drive = await resolveDrive(api, settings.location);
    // The folder's fixed part (before any {{ }}), cleaned as deliveries clean it; a missing
    // folder is created with the first delivery.
    const fixed: string[] = [];
    for (const seg of settings.folder.split('/')) {
      if (/[{%]/.test(seg)) break;
      fixed.push(seg);
    }
    const noData = { liquid: (t: string) => renderLiquid(t, {}, 'line') };
    const folder = await renderFolder(
      noData as Pick<DeliveryContext, 'liquid'> as DeliveryContext,
      fixed.join('/'),
    );
    const warnings: string[] = [];
    let ok = true;
    if (folder) {
      const reply = await vendorRequest(api, itemUrl(api, drive.driveId, folder), {
        query: { $select: 'id,name,folder' },
        allow: [404],
      });
      if (reply.status === 404)
        warnings.push(
          `The folder '${folder}' does not exist yet: it is created with the first delivery`,
        );
      else if (!reply.json<DriveItem>().folder) {
        ok = false;
        warnings.push(`'${folder}' is a file, not a folder`);
      }
    }
    const where = drive.site
      ? `Library '${drive.drive}' on site '${drive.site}'`
      : `OneDrive of ${settings.location.type === 'user' ? settings.location.user : drive.drive}`;
    const facts: Record<string, string> = { drive: drive.drive };
    if (drive.site) facts.site = drive.site;
    if (folder) facts.folder = folder;
    return {
      ok,
      summary: folder ? `${where}, folder '${folder}'` : where,
      facts,
      warnings,
    };
  },
};
