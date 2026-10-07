import { randomBytes } from 'node:crypto';
import { FakeServer, json, type FakeReply, type FakeRequest } from './server.js';

/**
 * A fake of the Microsoft identity platform's token endpoint and Microsoft Graph's drive API,
 * as far as the OneDrive adapter uses them: sites by path, a site's drives, a user's drive,
 * uploads by path (missing folders are created) with conflictBehavior, upload sessions (no
 * Authorization header allowed, chunks of at most 3.75 MiB in multiples of 320 KiB, in order),
 * item descriptions and pre-authenticated download URLs.
 */

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export interface FakeItem {
  id: string;
  name: string;
  folder?: boolean;
  data?: Buffer;
  description?: string;
}

const graphError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, innerError: { date: '2026-10-07T08:00:00' } } });

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class FakeMicrosoft {
  server: FakeServer;
  tokenRequests: URLSearchParams[] = [];
  tokens = new Set<string>();
  roles = ['Sites.Selected'];
  sites = new Map<
    string,
    { id: string; displayName: string; drives: { id: string; name: string; webUrl: string }[] }
  >();
  users = new Map<string, { id: string; name: string }>();
  /** Items per drive, keyed by lower-case path ("FieldForms/a.pdf" → "fieldforms/a.pdf"). */
  drives = new Map<string, Map<string, FakeItem>>();
  /** SharePoint may not keep descriptions; switch off to see the adapter's warning. */
  keepsDescription = true;
  sessions = new Map<
    string,
    {
      driveId: string;
      path: string;
      behavior: string;
      total?: number;
      chunks: Buffer[];
      next: number;
    }
  >();
  chunkSizes: number[] = [];

  constructor(private opts: { tenant: string; clientId: string; clientSecret: string }) {
    this.server = new FakeServer((r) => this.handle(r));
  }

  get url() {
    return this.server.url;
  }

  get endpoints() {
    return { microsoftLogin: `${this.url}/login`, microsoftGraph: `${this.url}/graph` };
  }

  async start() {
    await this.server.start();
    return this;
  }

  close() {
    return this.server.close();
  }

  seed() {
    this.sites.set('contoso.sharepoint.com:/sites/Ops', {
      id: 'contoso.sharepoint.com,1111aaaa-0000-4000-8000-000000000001,2222bbbb-0000-4000-8000-000000000002',
      displayName: 'Operations',
      drives: [
        {
          id: 'b!opsdocs',
          name: 'Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/Ops/Shared%20Documents',
        },
        {
          id: 'b!opsreports',
          name: 'Field Reports',
          webUrl: 'https://contoso.sharepoint.com/sites/Ops/FieldReports',
        },
      ],
    });
    this.users.set('thandi@contoso.co.za', { id: 'b!thandi', name: 'OneDrive' });
    for (const d of ['b!opsdocs', 'b!opsreports', 'b!thandi']) this.drives.set(d, new Map());
  }

  item(driveId: string, path: string): FakeItem | undefined {
    return this.drives.get(driveId)?.get(path.toLowerCase());
  }

  put(driveId: string, path: string, item: Omit<FakeItem, 'id' | 'name'>): FakeItem {
    const items = this.drives.get(driveId)!;
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      if (!items.has(p.toLowerCase()))
        items.set(p.toLowerCase(), {
          id: `D${randomBytes(6).toString('hex')}`,
          name: segs[i - 1]!,
          folder: true,
        });
    }
    const existing = items.get(path.toLowerCase());
    const it: FakeItem = {
      id: existing?.id ?? `I${randomBytes(8).toString('hex')}`,
      name: segs[segs.length - 1]!,
      description: existing?.description,
      ...item,
    };
    items.set(path.toLowerCase(), it);
    return it;
  }

  private view(it: FakeItem) {
    return {
      id: it.id,
      name: it.name,
      ...(it.folder
        ? { folder: { childCount: 0 } }
        : {
            size: it.data?.length ?? 0,
            file: { mimeType: 'application/octet-stream' },
            '@microsoft.graph.downloadUrl': `${this.url}/download/${it.id}?tempauth=dl-${it.id}`,
          }),
      ...(it.description !== undefined ? { description: it.description } : {}),
    };
  }

  private handle(r: FakeRequest): FakeReply {
    if (r.method === 'POST' && r.path.startsWith('/login/')) return this.token(r);
    if (r.path.startsWith('/upload/')) return this.session(r);
    if (r.path.startsWith('/download/')) {
      const id = r.path.slice('/download/'.length);
      for (const items of this.drives.values())
        for (const it of items.values())
          if (it.id === id) return { status: 200, body: it.data ?? '' };
      return json(404, {});
    }
    const auth = /^Bearer (.+)$/.exec(String(r.headers.authorization ?? ''))?.[1];
    if (!auth || !this.tokens.has(auth))
      return graphError(401, 'InvalidAuthenticationToken', 'Access token is empty.');
    return this.graph(r);
  }

  private token(r: FakeRequest): FakeReply {
    const tenant = decodeURIComponent(r.path.split('/')[2] ?? '');
    const form = new URLSearchParams(r.body.toString());
    this.tokenRequests.push(form);
    if (
      tenant !== this.opts.tenant ||
      r.path !== `/login/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
    )
      return json(400, {
        error: 'invalid_request',
        error_description: `AADSTS90002: Tenant '${tenant}' not found.`,
        error_codes: [90002],
      });
    if (form.get('grant_type') !== 'client_credentials' || form.get('scope') !== GRAPH_SCOPE)
      return json(400, { error: 'invalid_scope', error_codes: [70011] });
    if (
      form.get('client_id') !== this.opts.clientId ||
      form.get('client_secret') !== this.opts.clientSecret
    )
      // Echo what was sent, as some services do: the adapter must never pass it on.
      return json(401, {
        error: 'invalid_client',
        error_description: `AADSTS7000215: Invalid client secret provided: ${form.get('client_secret')}`,
        error_codes: [7000215],
      });
    const token = [
      b64url({ typ: 'JWT', alg: 'RS256' }),
      b64url({ aud: 'https://graph.microsoft.com', tid: tenant, roles: this.roles }),
      randomBytes(16).toString('base64url'),
    ].join('.');
    this.tokens.add(token);
    return json(200, { token_type: 'Bearer', expires_in: 3599, access_token: token });
  }

  private graph(r: FakeRequest): FakeReply {
    let x: RegExpExecArray | null;
    // Sites by host and path, or the root site.
    if (r.method === 'GET' && (x = /^\/graph\/sites\/([^/:]+)(?::(\/.+))?$/.exec(r.path))) {
      const key = x[2] ? `${x[1]}:${decodeURIComponent(x[2])}` : x[1]!;
      const site = this.sites.get(key);
      return site
        ? json(200, { id: site.id, displayName: site.displayName, name: site.displayName })
        : graphError(404, 'itemNotFound', 'Requested site could not be found');
    }
    if (r.method === 'GET' && (x = /^\/graph\/sites\/([^/]+)\/drives$/.exec(r.path))) {
      const id = decodeURIComponent(x[1]!);
      const site = [...this.sites.values()].find((s) => s.id === id);
      return site ? json(200, { value: site.drives }) : graphError(404, 'itemNotFound', 'No site');
    }
    if (r.method === 'GET' && (x = /^\/graph\/users\/([^/]+)\/drive$/.exec(r.path))) {
      const d = this.users.get(decodeURIComponent(x[1]!).toLowerCase());
      return d
        ? json(200, { id: d.id, name: d.name, driveType: 'business' })
        : graphError(404, 'ResourceNotFound', 'User not found');
    }
    if (
      (x = /^\/graph\/drives\/([^/]+)\/root:\/(.+):\/(content|createUploadSession)$/.exec(r.path))
    ) {
      const driveId = decodeURIComponent(x[1]!);
      if (!this.drives.has(driveId)) return graphError(404, 'itemNotFound', 'Drive not found');
      const path = x[2]!.split('/').map(decodeURIComponent).join('/');
      if (x[3] === 'content') {
        if (r.method !== 'PUT') return json(405, {});
        const m = /^@microsoft\.graph\.conflictBehavior=(fail|replace)$/.exec(r.rawQuery);
        if (!m) return graphError(400, 'invalidRequest', 'conflictBehavior');
        if (r.body.length > 4 * 1024 * 1024) return graphError(413, 'requestTooLarge', 'Too large');
        const existing = this.item(driveId, path);
        if (existing && m[1] === 'fail')
          return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
        const it = this.put(driveId, path, { data: r.body });
        return json(existing ? 200 : 201, this.view(it));
      }
      if (r.method !== 'POST') return json(405, {});
      const body = JSON.parse(r.body.toString() || '{}');
      const behavior = body?.item?.['@microsoft.graph.conflictBehavior'] ?? 'rename';
      if (this.item(driveId, path) && behavior === 'fail')
        return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
      const sid = randomBytes(8).toString('hex');
      this.sessions.set(sid, { driveId, path, behavior, chunks: [], next: 0 });
      return json(200, {
        uploadUrl: `${this.url}/upload/${sid}?tempauth=session-token-${sid}`,
        expirationDateTime: '2026-10-08T08:00:00Z',
      });
    }
    if (r.method === 'GET' && (x = /^\/graph\/drives\/([^/]+)\/root:\/(.+)$/.exec(r.path))) {
      const it = this.item(
        decodeURIComponent(x[1]!),
        x[2]!.split('/').map(decodeURIComponent).join('/'),
      );
      return it
        ? json(200, this.view(it))
        : graphError(404, 'itemNotFound', 'The resource could not be found.');
    }
    if (r.method === 'PATCH' && (x = /^\/graph\/drives\/([^/]+)\/items\/([^/]+)$/.exec(r.path))) {
      const items = this.drives.get(decodeURIComponent(x[1]!));
      const it = [...(items?.values() ?? [])].find((i) => i.id === decodeURIComponent(x![2]!));
      if (!it) return graphError(404, 'itemNotFound', 'No item');
      const body = JSON.parse(r.body.toString() || '{}');
      if (this.keepsDescription && typeof body.description === 'string')
        it.description = body.description;
      return json(200, this.view(it));
    }
    return graphError(404, 'invalidRequest', `No route ${r.method} ${r.path}`);
  }

  private session(r: FakeRequest): FakeReply {
    const sid = r.path.slice('/upload/'.length);
    const s = this.sessions.get(sid);
    if (!s || r.query.get('tempauth') !== `session-token-${sid}`)
      return graphError(404, 'itemNotFound', 'No session');
    // Graph refuses an Authorization header on the pre-authenticated URL.
    if (r.headers.authorization) return graphError(401, 'unauthenticated', 'Do not send a token');
    if (r.method === 'DELETE') {
      this.sessions.delete(sid);
      return { status: 204 };
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(r.headers['content-range'] ?? ''));
    if (r.method !== 'PUT' || !m) return graphError(400, 'invalidRequest', 'Content-Range');
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const size = end - start + 1;
    this.chunkSizes.push(size);
    if (start !== s.next || size !== r.body.length)
      return graphError(416, 'invalidRange', 'Unexpected range');
    if (size > 3_932_160 || (end + 1 < total && size % 327_680 !== 0))
      return graphError(400, 'invalidRequest', 'Chunk size');
    s.chunks.push(r.body);
    s.next = end + 1;
    if (s.next < total) return json(202, { nextExpectedRanges: [`${s.next}-`] });
    this.sessions.delete(sid);
    const existing = this.item(s.driveId, s.path);
    if (existing && s.behavior === 'fail')
      return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
    const it = this.put(s.driveId, s.path, { data: Buffer.concat(s.chunks) });
    return json(existing ? 200 : 201, this.view(it));
  }
}
