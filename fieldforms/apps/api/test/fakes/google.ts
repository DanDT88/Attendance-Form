import { randomBytes, verify, type KeyObject } from 'node:crypto';
import { FakeServer, json, type FakeReply, type FakeRequest } from './server.js';

/**
 * A fake of Google's token endpoint, Drive v3 and Sheets v4, as far as the adapters use them.
 *
 * The token endpoint verifies the JWT assertion's RS256 signature with the test key pair's
 * public key and checks iss, aud, scope, sub and the lifetime. Drive keeps Shared Drive rules:
 * Shared Drive items are invisible without supportsAllDrives (and, in lists,
 * includeItemsFromAllDrives with corpora=allDrives), files in My Drive fail with
 * storageQuotaExceeded, and only ids from generateIds may be used. Queries must quote and escape
 * their literals.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const FOLDER = 'application/vnd.google-apps.folder';

export interface FakeDriveFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  driveId?: string;
  appProperties?: Record<string, string>;
  data?: Buffer;
  createdTime: string;
  trashed?: boolean;
  /** The service account may only read it (Viewer). */
  readOnly?: boolean;
}

export interface FakeSpreadsheet {
  title: string;
  tabs: Map<string, unknown[][]>;
  /** Not shared with the service account. */
  forbidden?: boolean;
}

const LIT = "'((?:[^'\\\\]|\\\\.)*)'";
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const FOLDER_QUERY = new RegExp(
  `^${LIT} in parents and name\\s*=\\s*${LIT} and mimeType\\s*=\\s*${LIT} and trashed\\s*=\\s*false$`,
);
const PROPERTY_QUERY = new RegExp(
  `^appProperties has \\{ key\\s*=\\s*${LIT} and value\\s*=\\s*${LIT} \\} and trashed\\s*=\\s*false$`,
);

const googleError = (code: number, reason: string, message: string, status = 'FAILED') =>
  json(code, { error: { code, message, status, errors: [{ domain: 'global', reason, message }] } });

let clock = 0;
const created = () => new Date(Date.UTC(2026, 9, 7, 8, 0, 0) + clock++ * 1000).toISOString();

export class FakeGoogle {
  server: FakeServer;
  /** Accepted assertions' claims, in order. */
  tokenRequests: {
    iss: string;
    scope: string;
    sub?: string;
    aud: string;
    iat: number;
    exp: number;
  }[] = [];
  /** Assertions refused, with why. */
  refused: string[] = [];
  tokens = new Map<string, { scope: string; sub?: string }>();
  files = new Map<string, FakeDriveFile>();
  drives = new Map<string, string>();
  generated = new Set<string>();
  sheets = new Map<string, FakeSpreadsheet>();
  appends: { spreadsheetId: string; range: string; query: URLSearchParams; values: unknown[][] }[] =
    [];
  sessions = new Map<
    string,
    {
      method: 'POST' | 'PATCH';
      id?: string;
      metadata: Partial<FakeDriveFile>;
      query: URLSearchParams;
    }
  >();

  constructor(
    public opts: { publicKey: KeyObject; clientEmail: string; subject?: string; scopes?: string[] },
  ) {
    this.server = new FakeServer((r) => this.handle(r));
  }

  get url() {
    return this.server.url;
  }

  get endpoints() {
    return {
      googleToken: `${this.url}/token`,
      googleDrive: `${this.url}/drive/v3`,
      googleUpload: `${this.url}/upload/drive/v3`,
      googleSheets: `${this.url}/v4`,
    };
  }

  async start() {
    await this.server.start();
    return this;
  }

  close() {
    return this.server.close();
  }

  /** A Shared Drive with a root folder, and a My Drive folder. */
  seedDrive() {
    this.drives.set('DRIVE0001', 'Operations');
    this.files.set('SHAREDFOLDER01', {
      id: 'SHAREDFOLDER01',
      name: 'Reports',
      parents: ['DRIVE0001'],
      mimeType: FOLDER,
      driveId: 'DRIVE0001',
      createdTime: created(),
    });
    this.files.set('MYDRIVEFOLDER1', {
      id: 'MYDRIVEFOLDER1',
      name: 'Mine',
      parents: ['root'],
      mimeType: FOLDER,
      createdTime: created(),
    });
  }

  folder(parent: string, name: string, extra: Partial<FakeDriveFile> = {}): FakeDriveFile {
    const p = this.files.get(parent);
    const f: FakeDriveFile = {
      id: `F${randomBytes(8).toString('hex')}`,
      name,
      parents: [parent],
      mimeType: FOLDER,
      driveId: p?.driveId,
      createdTime: created(),
      ...extra,
    };
    this.files.set(f.id, f);
    return f;
  }

  childrenOf(parent: string, name?: string) {
    return [...this.files.values()].filter(
      (f) => f.parents.includes(parent) && !f.trashed && (name === undefined || f.name === name),
    );
  }

  private handle(r: FakeRequest): FakeReply {
    if (r.method === 'POST' && r.path === '/token') return this.token(r);
    const auth = /^Bearer (.+)$/.exec(String(r.headers.authorization ?? ''))?.[1];
    // Every Drive and Sheets call needs a token issued here (resumable session URLs too).
    const grant = auth ? this.tokens.get(auth) : undefined;
    if (!grant)
      return json(401, {
        error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' },
      });
    if (r.path.startsWith('/v4/')) {
      if (grant.scope !== SHEETS_SCOPE)
        return json(403, {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Request had insufficient authentication scopes.',
            details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
          },
        });
      return this.sheetsApi(r);
    }
    if (grant.scope !== DRIVE_SCOPE)
      return googleError(403, 'insufficientPermissions', 'Insufficient Permission');
    return this.drive(r);
  }

  // ------------------------------------------------------------------ token

  private token(r: FakeRequest): FakeReply {
    const form = new URLSearchParams(r.body.toString());
    const refuse = (why: string) => {
      this.refused.push(why);
      return json(400, { error: 'invalid_grant', error_description: `Invalid JWT: ${why}` });
    };
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      return json(400, { error: 'unsupported_grant_type' });
    const parts = (form.get('assertion') ?? '').split('.');
    if (parts.length !== 3) return refuse('malformed');
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'RS256' || header.typ !== 'JWT') return refuse('alg');
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      this.opts.publicKey,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) return refuse('Invalid JWT Signature.');
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (c.iss !== this.opts.clientEmail) return refuse('iss');
    if (c.aud !== `${this.url}/token`) return refuse('aud');
    if (!(this.opts.scopes ?? [DRIVE_SCOPE, SHEETS_SCOPE]).includes(c.scope)) {
      this.refused.push('scope');
      return json(400, {
        error: 'unauthorized_client',
        error_description: 'Client is unauthorized to retrieve access tokens using this method',
      });
    }
    if (c.sub !== this.opts.subject) return refuse('sub');
    if (typeof c.iat !== 'number' || c.exp - c.iat !== 3600) return refuse('lifetime');
    this.tokenRequests.push(c);
    const token = `ya29.${randomBytes(24).toString('hex')}`;
    this.tokens.set(token, { scope: c.scope, sub: c.sub });
    return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
  }

  // ------------------------------------------------------------------ drive

  private visible(f: FakeDriveFile | undefined, r: FakeRequest): f is FakeDriveFile {
    return !!f && (!f.driveId || r.query.get('supportsAllDrives') === 'true');
  }

  private notFound(id: string) {
    return googleError(404, 'notFound', `File not found: ${id}.`);
  }

  private drive(r: FakeRequest): FakeReply {
    const m = (re: RegExp) => re.exec(r.path);
    let x: RegExpExecArray | null;
    if (r.method === 'GET' && r.path === '/drive/v3/files/generateIds') {
      const n = Number(r.query.get('count') ?? 10);
      const ids = Array.from({ length: n }, () => `G${randomBytes(16).toString('hex')}`);
      ids.forEach((i) => this.generated.add(i));
      return json(200, { kind: 'drive#generatedIds', space: 'drive', ids });
    }
    if (r.method === 'GET' && r.path === '/drive/v3/files') return this.list(r);
    if (r.method === 'POST' && r.path === '/drive/v3/files') {
      const meta = JSON.parse(r.body.toString()) as Partial<FakeDriveFile>;
      return this.create(r, meta, undefined);
    }
    if ((x = m(/^\/drive\/v3\/drives\/([^/]+)$/)) && r.method === 'GET') {
      const name = this.drives.get(decodeURIComponent(x[1]!));
      return name ? json(200, { name }) : this.notFound(x[1]!);
    }
    if ((x = m(/^\/drive\/v3\/files\/([^/]+)$/))) {
      const f = this.files.get(decodeURIComponent(x[1]!));
      if (!this.visible(f, r)) return this.notFound(x[1]!);
      if (r.method === 'GET')
        return json(200, {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          driveId: f.driveId,
          trashed: !!f.trashed,
          capabilities: { canAddChildren: !f.readOnly },
        });
      if (r.method === 'PATCH') {
        const meta = JSON.parse(r.body.toString() || '{}');
        if (meta.trashed) f.trashed = true;
        return json(200, { id: f.id });
      }
    }
    if (r.method === 'POST' && r.path === '/upload/drive/v3/files') {
      const type = r.query.get('uploadType');
      if (type === 'multipart') {
        const { metadata, content } = parseMultipart(r.body, String(r.headers['content-type']));
        return this.create(r, metadata, content);
      }
      if (type === 'resumable') return this.startSession(r, 'POST');
      return json(400, { error: { code: 400, message: 'uploadType' } });
    }
    if (r.method === 'PUT' && r.path === '/upload/drive/v3/files' && r.query.get('upload_id'))
      return this.finishSession(r);
    if ((x = m(/^\/upload\/drive\/v3\/files\/([^/]+)$/))) {
      const id = decodeURIComponent(x[1]!);
      if (r.method === 'PUT' && r.query.get('upload_id')) return this.finishSession(r);
      if (r.method !== 'PATCH') return json(405, {});
      const f = this.files.get(id);
      if (!this.visible(f, r)) return this.notFound(id);
      if (r.query.get('uploadType') === 'media') {
        f.data = r.body;
        return json(200, { id: f.id });
      }
      if (r.query.get('uploadType') === 'resumable') return this.startSession(r, 'PATCH', id);
    }
    return json(404, { error: { code: 404, message: `No route ${r.method} ${r.path}` } });
  }

  private list(r: FakeRequest): FakeReply {
    const q = r.query.get('q') ?? '';
    const allDrives =
      r.query.get('supportsAllDrives') === 'true' &&
      r.query.get('includeItemsFromAllDrives') === 'true' &&
      r.query.get('corpora') === 'allDrives';
    let found: FakeDriveFile[];
    let x: RegExpExecArray | null;
    if ((x = FOLDER_QUERY.exec(q))) {
      const [parent, name, mime] = [unescape(x[1]!), unescape(x[2]!), unescape(x[3]!)];
      found = this.childrenOf(parent, name).filter((f) => f.mimeType === mime);
    } else if ((x = PROPERTY_QUERY.exec(q))) {
      const [key, value] = [unescape(x[1]!), unescape(x[2]!)];
      found = [...this.files.values()].filter(
        (f) => !f.trashed && f.appProperties?.[key] === value,
      );
    } else return googleError(400, 'invalid', `Invalid Value: ${q}`, 'INVALID_ARGUMENT');
    found = found.filter((f) => !f.driveId || allDrives);
    if (r.query.get('orderBy') === 'createdTime')
      found.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    return json(200, {
      files: found.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime })),
    });
  }

  private create(
    r: FakeRequest,
    meta: Partial<FakeDriveFile>,
    content: Buffer | undefined,
  ): FakeReply {
    const parentId = meta.parents?.[0] ?? 'root';
    const parent = this.files.get(parentId);
    if (!this.visible(parent, r) || parent.mimeType !== FOLDER) return this.notFound(parentId);
    if (parent.readOnly)
      return googleError(
        403,
        'insufficientFilePermissions',
        'The user does not have sufficient permissions for this file.',
      );
    const isFolder = meta.mimeType === FOLDER;
    // Service accounts have no quota: files (not folders) in My Drive fail.
    if (!isFolder && !parent.driveId)
      return googleError(
        403,
        'storageQuotaExceeded',
        'Service Accounts do not have storage quota. Leverage shared drives instead.',
      );
    let id = meta.id;
    if (id) {
      if (this.files.has(id))
        return googleError(409, 'duplicate', 'A file already exists with the provided ID.');
      if (!this.generated.has(id))
        return googleError(400, 'invalid', 'The provided file ID is not usable.');
    } else id = `N${randomBytes(8).toString('hex')}`;
    const f: FakeDriveFile = {
      id,
      name: String(meta.name),
      parents: [parentId],
      mimeType: meta.mimeType ?? 'application/octet-stream',
      driveId: parent.driveId,
      appProperties: meta.appProperties,
      data: content,
      createdTime: created(),
    };
    this.files.set(id, f);
    return json(200, { id });
  }

  private startSession(r: FakeRequest, method: 'POST' | 'PATCH', id?: string): FakeReply {
    if (id && !this.visible(this.files.get(id), r)) return this.notFound(id);
    const meta = JSON.parse(r.body.toString() || '{}') as Partial<FakeDriveFile>;
    if (!id && meta.id && this.files.has(meta.id))
      return googleError(409, 'duplicate', 'A file already exists with the provided ID.');
    const sid = randomBytes(8).toString('hex');
    this.sessions.set(sid, { method, id, metadata: meta, query: r.query });
    const path = id ? `/upload/drive/v3/files/${id}` : '/upload/drive/v3/files';
    return {
      status: 200,
      headers: { location: `${this.url}${path}?uploadType=resumable&upload_id=${sid}` },
    };
  }

  private finishSession(r: FakeRequest): FakeReply {
    const s = this.sessions.get(r.query.get('upload_id') ?? '');
    if (!s) return json(404, { error: { code: 404, message: 'No session' } });
    if (s.method === 'PATCH') {
      const f = this.files.get(s.id!)!;
      f.data = r.body;
      return json(200, { id: f.id });
    }
    return this.create({ ...r, query: s.query }, s.metadata, r.body);
  }

  // ------------------------------------------------------------------ sheets

  private sheetsApi(r: FakeRequest): FakeReply {
    const x = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+))?$/.exec(r.path);
    if (!x) return json(404, { error: { code: 404, message: 'No route' } });
    const book = this.sheets.get(decodeURIComponent(x[1]!));
    if (!book)
      return json(404, {
        error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' },
      });
    if (book.forbidden)
      return json(403, {
        error: {
          code: 403,
          message: 'The caller does not have permission',
          status: 'PERMISSION_DENIED',
        },
      });
    if (!x[2]) {
      if (r.method !== 'GET') return json(405, {});
      return json(200, {
        properties: { title: book.title },
        sheets: [...book.tabs.keys()].map((title) => ({ properties: { title } })),
      });
    }
    let range = decodeURIComponent(x[2]);
    const append = range.endsWith(':append');
    if (append) range = range.slice(0, -':append'.length);
    const q = /^'((?:[^']|'')*)'!(.+)$/.exec(range);
    const tab = q ? book.tabs.get(q[1]!.replace(/''/g, "'")) : undefined;
    if (!q || !tab)
      return json(400, {
        error: {
          code: 400,
          message: `Unable to parse range: ${range}`,
          status: 'INVALID_ARGUMENT',
        },
      });
    const cells = q[2]!;
    if (r.method === 'GET' && cells === '1:1') {
      const row = tab[0] ?? [];
      return json(200, {
        range,
        majorDimension: 'ROWS',
        ...(row.some((v) => v !== '' && v !== null && v !== undefined) ? { values: [row] } : {}),
      });
    }
    const body = JSON.parse(r.body.toString() || '{}') as { range?: string; values?: unknown[][] };
    if (body.range !== range) return json(400, { error: { code: 400, message: 'range mismatch' } });
    if (r.method === 'PUT' && cells === 'A1') {
      if (
        r.query.get('valueInputOption') !== 'RAW' &&
        r.query.get('valueInputOption') !== 'USER_ENTERED'
      )
        return json(400, { error: { code: 400, message: 'valueInputOption' } });
      tab[0] = [...(body.values?.[0] ?? [])];
      return json(200, { updatedRange: `${range}`, updatedRows: 1 });
    }
    if (r.method === 'POST' && append) {
      const values = body.values ?? [];
      let last = tab.length;
      while (last > 0 && !(tab[last - 1] ?? []).some((v) => v !== '' && v != null)) last--;
      tab.splice(last, 0, ...values.map((v) => [...v]));
      this.appends.push({
        spreadsheetId: decodeURIComponent(x[1]!),
        range,
        query: r.query,
        values,
      });
      const name = q[1]!;
      return json(200, {
        spreadsheetId: x[1],
        tableRange: `'${name}'!A1:C${last}`,
        updates: {
          updatedRange: `'${name}'!A${last + 1}:C${last + values.length}`,
          updatedRows: values.length,
        },
      });
    }
    return json(405, {});
  }
}

/** Splits a multipart/related body into its metadata (JSON) and content parts. */
export function parseMultipart(
  body: Buffer,
  contentType: string,
): { metadata: Partial<FakeDriveFile>; content: Buffer; contentType: string } {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error('no boundary');
  const delim = Buffer.from(`--${boundary}`);
  const parts: { headers: string; content: Buffer }[] = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delim, start);
    if (next < 0) throw new Error('unterminated multipart body');
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    parts.push({ headers: part.subarray(0, split).toString(), content: part.subarray(split + 4) });
    pos = next;
  }
  if (parts.length !== 2) throw new Error(`expected 2 parts, got ${parts.length}`);
  return {
    metadata: JSON.parse(parts[0]!.content.toString()),
    content: Buffer.from(parts[1]!.content),
    contentType: /content-type:\s*([^\r\n]+)/i.exec(parts[1]!.headers)?.[1] ?? '',
  };
}
