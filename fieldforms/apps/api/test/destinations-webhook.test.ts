import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildDocumentModel,
  destinationSettingsSchemas,
  INCLUDE_ALL,
  templateData,
  type FormDefinition,
} from '@fieldforms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { webhookAdapter } from '../src/destinations/adapters/webhook.js';
import {
  webhookDriver,
  webhookSecretSchema,
  webhookTarget,
} from '../src/destinations/connections/webhook.js';
import {
  DEFAULT_ENDPOINTS,
  DeliveryError,
  redact,
  type AdapterEnv,
  type DeliveryContext,
  type OpenConnection,
} from '../src/destinations/types.js';
import { renderLiquid } from '../src/lib/liquid.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import type { RenderedFile } from '../src/outputs/types.js';
import { classify } from '../src/services/delivery-runner.js';

/** Tests reach the fake receiver on loopback; production allows public addresses only. */
const dev = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
const strict = parseNetworkPolicy({});

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
let base: string;
let received: Received[] = [];
let reply: (res: ServerResponse) => void;
const hanging: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const res of hanging) res.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  received = [];
  reply = (res) =>
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' }).end('ok');
});

const PATH_TOKEN = 'k7Hq2Zp9Xw';
const QUERY_TOKEN = 'qT0kenVa1ue55';
const SIGNING = 'whsec_0123456789abcdefSIGN';

function conn(secrets: Record<string, string> = {}): OpenConnection {
  return {
    id: randomUUID(),
    kind: 'webhook',
    config: { urlOrigin: base },
    secrets: {
      url: `${base}/hooks/catch/123456/${PATH_TOKEN}/?token=${QUERY_TOKEN}`,
      signingSecret: SIGNING,
      ...secrets,
    },
  };
}

const NOW = new Date('2026-10-07T10:00:00Z');
function envWith(over: Partial<AdapterEnv> = {}): AdapterEnv {
  return {
    policy: dev,
    vendorPolicy: strict,
    mailer: {
      async send() {
        throw new Error('webhooks send no email');
      },
    },
    endpoints: DEFAULT_ENDPOINTS,
    signal: AbortSignal.timeout(10_000),
    now: () => NOW,
    emailAttachmentLimit: 1024 * 1024,
    ...over,
  };
}

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: false },
  fields: [
    { id: 'litres', type: 'number', label: 'Litres' },
    { id: 'where', type: 'text', label: 'Where' },
  ],
};

function makeCtx(o: { resend?: boolean; test?: boolean; files?: RenderedFile[] } = {}) {
  const id = randomUUID();
  const deliveryId = randomUUID();
  const generation = o.resend ? 2 : 1;
  const model = buildDocumentModel(
    def,
    { litres: 12, where: 'Bay 3' },
    {
      form: { id: randomUUID(), name: 'Spill report', version: 1, versionId: randomUUID() },
      submission: {
        id,
        receivedAt: '2026-10-07T08:00:00Z',
        capturedAt: null,
        clockSkewFlag: false,
        siteId: null,
        site: 'Bay 3',
        region: '',
        company: '',
        submittedBy: 'Sam',
        taskTitle: '',
        url: `https://ff.example/submissions/${id}`,
      },
      branding: { name: 'Acme', colour: '#123456', logoBlobId: null, footer: '' },
    },
    { include: INCLUDE_ALL },
  );
  const data = templateData(model);
  const ctx: DeliveryContext = {
    delivery: {
      id: deliveryId,
      generation,
      attempt: 3,
      idempotencyKey: `${deliveryId}.${generation}`,
      resend: !!o.resend,
    },
    test: o.test ? { tester: { email: 'admin@acme.test', name: 'Ada' } } : null,
    model,
    files: o.files ?? [],
    json: { schema: 'fieldforms.submission/1', submission: { id }, answers: model.raw },
    value: () => null,
    liquid: (t, c) => renderLiquid(t, data, c),
    contacts: { submitterEmail: null, taskSenderEmail: null, siteRecipients: [], siteManagers: [] },
    target: null,
    link: model.submission.url,
  };
  return ctx;
}

const settings = (s: Record<string, unknown> = {}) => destinationSettingsSchemas.webhook.parse(s);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function verifySignature(header: string | undefined, body: string, secret: string): number {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  expect(m).not.toBeNull();
  const expected = createHmac('sha256', secret).update(`${m![1]}.${body}`).digest('hex');
  expect(m![2]).toBe(expected);
  return Number(m![1]);
}

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

/** What the pipeline would store for an error, with the connection's secrets. */
function stored(err: unknown, secrets: Record<string, string>): string {
  const c = classify(err, secrets);
  return `${c.message} ${c.detail ?? ''}`;
}

describe('webhook delivery', () => {
  it('posts the submission, signed, with its idempotency key', async () => {
    const ctx = makeCtx();
    const r = await webhookAdapter.deliver(ctx, settings(), conn(), envWith());
    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`/hooks/catch/123456/${PATH_TOKEN}/?token=${QUERY_TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['user-agent']).toBe('FieldForms');
    expect(req.headers['idempotency-key']).toBe(ctx.delivery.idempotencyKey);
    expect(req.headers['x-fieldforms-delivery']).toBe(ctx.delivery.idempotencyKey);
    expect(req.headers['x-fieldforms-resend']).toBeUndefined();
    expect(req.headers['x-fieldforms-test']).toBeUndefined();
    const t = verifySignature(req.headers['x-fieldforms-signature'] as string, req.body, SIGNING);
    expect(t).toBe(Math.floor(NOW.getTime() / 1000));

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toEqual({
      event: 'submission',
      test: false,
      delivery: { id: ctx.delivery.id, generation: 1, attempt: 3 },
      submission: ctx.json,
    });

    expect(r).toEqual({
      outcome: 'delivered',
      target: { origin: base, path: '/hooks/catch/*/*/' },
      evidence: { status: 200, contentLength: 2, sha256: sha256('ok') },
    });
    expect(JSON.stringify(r)).not.toContain(PATH_TOKEN);
    expect(JSON.stringify(r)).not.toContain(QUERY_TOKEN);
  });

  it('marks resends and test sends', async () => {
    await webhookAdapter.deliver(makeCtx({ resend: true }), settings(), conn(), envWith());
    expect(received[0]!.headers['x-fieldforms-resend']).toBe('1');
    expect(received[0]!.headers['x-fieldforms-test']).toBeUndefined();
    expect(JSON.parse(received[0]!.body).delivery.generation).toBe(2);

    await webhookAdapter.deliver(makeCtx({ test: true }), settings(), conn(), envWith());
    expect(received[1]!.headers['x-fieldforms-test']).toBe('1');
    expect(received[1]!.headers['x-fieldforms-resend']).toBeUndefined();
    expect(JSON.parse(received[1]!.body).test).toBe(true);
  });

  it('adds the documents only when asked', async () => {
    const files: RenderedFile[] = [
      {
        filename: 'Spill - Bay 3.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1'),
      },
      { filename: 'Spill - Bay 3.json', contentType: 'application/json', data: Buffer.from('{}') },
    ];
    await webhookAdapter.deliver(makeCtx({ files }), settings(), conn(), envWith());
    expect(JSON.parse(received[0]!.body).files).toBeUndefined();

    await webhookAdapter.deliver(
      makeCtx({ files }),
      settings({ includeFiles: true }),
      conn(),
      envWith(),
    );
    const sent = JSON.parse(received[1]!.body).files as Record<string, unknown>[];
    expect(sent).toEqual(
      files.map((f) => ({
        filename: f.filename,
        contentType: f.contentType,
        size: f.data.length,
        sha256: sha256(f.data),
        data: f.data.toString('base64'),
      })),
    );
    verifySignature(
      received[1]!.headers['x-fieldforms-signature'] as string,
      received[1]!.body,
      SIGNING,
    );
  });

  it('sends no signature without a signing secret', async () => {
    await webhookAdapter.deliver(makeCtx(), settings(), conn({ signingSecret: '' }), envWith());
    const c = conn();
    delete c.secrets.signingSecret;
    await webhookAdapter.deliver(makeCtx(), settings(), c, envWith());
    expect(received.map((r) => r.headers['x-fieldforms-signature'])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('treats 409 as already delivered', async () => {
    reply = (res) => res.writeHead(409).end('duplicate');
    const r = await webhookAdapter.deliver(makeCtx(), settings(), conn(), envWith());
    expect(r.outcome).toBe('already_present');
    // Sent chunked: no declared length.
    expect(r.evidence).toEqual({ status: 409, contentLength: null, sha256: sha256('duplicate') });
  });

  it('does not follow redirects', async () => {
    reply = (res) => res.writeHead(302, { Location: `${base}/elsewhere` }).end();
    const err = await failure(webhookAdapter.deliver(makeCtx(), settings(), conn(), envWith()));
    expect(err).toMatchObject({ permanent: true, errorClass: 'rejected', status: 302 });
    expect(err.message).toContain('redirects are not followed');
    expect(received).toHaveLength(1);
  });

  it.each([
    [500, false, 'unreachable'],
    [503, false, 'unreachable'],
    [429, false, 'unreachable'],
    [408, false, 'unreachable'],
    [400, true, 'rejected'],
    [401, true, 'credentials'],
    [403, true, 'credentials'],
    [404, true, 'not_found'],
    [413, true, 'too_large'],
  ])('classifies HTTP %i (permanent: %s)', async (status, permanent, errorClass) => {
    reply = (res) => res.writeHead(status).end('{"error":"REPLY-BODY-SECRET"}');
    const c = conn();
    const err = await failure(webhookAdapter.deliver(makeCtx(), settings(), c, envWith()));
    expect(err).toMatchObject({ permanent, errorClass, status });
    expect(err.message).toBe(`Receiver returned HTTP ${status}`);
    expect(stored(err, c.secrets)).not.toContain('REPLY-BODY-SECRET');
  });

  it('never keeps a reply body, and reads only the first 64 KB of it', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 'REPLY-BODY-SECRET ');
    reply = (res) => {
      res.writeHead(200, { 'Content-Length': String(big.length) });
      res.end(big);
    };
    const r = await webhookAdapter.deliver(makeCtx(), settings(), conn(), envWith());
    expect(r.evidence).toEqual({
      status: 200,
      contentLength: big.length,
      sha256: sha256(big.subarray(0, 64 * 1024)),
    });
    expect(JSON.stringify(r)).not.toContain('REPLY-BODY-SECRET');
  });

  it('refuses the cloud metadata address and unlisted private networks', async () => {
    for (const url of [
      `http://169.254.169.254/latest/meta-data/${PATH_TOKEN}`,
      'https://169.254.169.254/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/',
      'https://10.99.0.1/hook',
    ]) {
      const c = conn({ url });
      const err = await failure(webhookAdapter.deliver(makeCtx(), settings(), c, envWith()));
      expect(err).toMatchObject({
        message: 'Address not allowed',
        permanent: true,
        errorClass: 'network_policy',
      });
      expect(stored(err, c.secrets)).not.toContain(PATH_TOKEN);
    }
  });

  it('refuses a host name that resolves to a refused address', async () => {
    const c = conn({ url: `http://localhost:${new URL(base).port}/hooks` });
    const err = await failure(
      webhookAdapter.deliver(makeCtx(), settings(), c, envWith({ policy: strict })),
    );
    expect(err).toMatchObject({ permanent: true, errorClass: 'network_policy' });
    expect(received).toHaveLength(0);
  });

  it('allows plain http only to listed private networks', async () => {
    const err = await failure(
      webhookAdapter.deliver(
        makeCtx(),
        settings(),
        conn(),
        envWith({ policy: parseNetworkPolicy({ DESTINATIONS_ALLOW_SAME_NETWORK: 'true' }) }),
      ),
    );
    expect(err).toMatchObject({ errorClass: 'network_policy' });
    expect(received).toHaveLength(0);
  });

  it('keeps the URL and the signing secret out of errors', async () => {
    const c = conn({
      url: `http://127.0.0.1:1/hooks/${PATH_TOKEN}?token=${QUERY_TOKEN}`,
    });
    const err = await failure(webhookAdapter.deliver(makeCtx(), settings(), c, envWith()));
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
    expect(err.message).toBe('Could not connect to the receiver');
    const text = stored(err, c.secrets);
    for (const secret of [PATH_TOKEN, QUERY_TOKEN, SIGNING, '127.0.0.1:1'])
      expect(text).not.toContain(secret);
    expect(redact(err.detail ?? '', c.secrets)).toBe(err.detail ?? '');
  });

  it('times out, worth retrying, when the receiver does not answer', async () => {
    reply = (res) => {
      hanging.push(res);
    };
    const err = await failure(
      webhookAdapter.deliver(
        makeCtx(),
        settings(),
        conn(),
        envWith({ signal: AbortSignal.timeout(300) }),
      ),
    );
    expect(err).toMatchObject({
      message: 'Timed out waiting for the receiver',
      permanent: false,
      errorClass: 'unreachable',
    });
  });

  it('needs a connection with a URL', async () => {
    const c = conn();
    delete c.secrets.url;
    for (const x of [null, c, conn({ url: 'not a url' })]) {
      const err = await failure(webhookAdapter.deliver(makeCtx(), settings(), x, envWith()));
      expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
    }
  });

  it('records the origin and a path with token-like segments masked, never the query', () => {
    expect(webhookTarget(new URL('https://h.example/api/v2/fieldforms/inbound?key=abc'))).toEqual({
      origin: 'https://h.example',
      path: '/api/v2/fieldforms/inbound',
    });
    expect(
      webhookTarget(new URL('https://hooks.zapier.com/hooks/catch/1234567/abc12de/')).path,
    ).toBe('/hooks/catch/*/*/');
    expect(webhookTarget(new URL('https://x.example/t/AbCdEfGhIjKlMnOpQrStUvWxYz')).path).toBe(
      '/t/*',
    );
  });
});

describe('webhook connection', () => {
  it('validates the secrets an admin enters', () => {
    const ok = (s: Record<string, unknown>) => webhookSecretSchema.safeParse(s).success;
    expect(ok({ url: 'https://h.example/hook' })).toBe(true);
    expect(ok({ url: 'http://10.20.0.5/hook', signingSecret: 'a'.repeat(16) })).toBe(true);
    expect(ok({ url: 'https://h.example/hook', signingSecret: '' })).toBe(true);
    expect(ok({ url: 'https://h.example/hook', signingSecret: 'short' })).toBe(false);
    expect(ok({ url: 'https://h.example/hook', signingSecret: 'a'.repeat(201) })).toBe(false);
    expect(ok({ url: 'ftp://h.example/hook' })).toBe(false);
    expect(ok({ url: 'javascript:alert(1)' })).toBe(false);
    expect(ok({ url: 'https://user:pass@h.example/hook' })).toBe(false);
    expect(ok({ url: `https://h.example/${'a'.repeat(2000)}` })).toBe(false);
    expect(ok({ url: 'https://h.example/hook', other: 'x' })).toBe(false);
    expect(ok({})).toBe(false);
    // Not URLs at all: a validation error, never an exception.
    for (const url of ['not a url', '', 'https://', 'http://exa mple.com/'])
      expect(webhookSecretSchema.safeParse({ url }).error?.issues[0]?.message).toBe(
        'A full URL, starting with https://',
      );
  });

  it('checks with a signed ping and reports the status', async () => {
    const r = await webhookDriver.check(conn(), envWith());
    expect(r).toMatchObject({
      ok: true,
      summary: 'The receiver answered HTTP 200',
      facts: { receiver: base, signed: 'yes' },
      warnings: [],
    });
    expect(JSON.parse(received[0]!.body)).toEqual({ event: 'ping' });
    verifySignature(
      received[0]!.headers['x-fieldforms-signature'] as string,
      received[0]!.body,
      SIGNING,
    );
  });

  it('reports a failing receiver, a redirect and a missing signing secret', async () => {
    reply = (res) => res.writeHead(500).end('stack trace with REPLY-BODY-SECRET');
    const failed = await webhookDriver.check(conn(), envWith());
    expect(failed).toMatchObject({ ok: false, summary: 'The receiver returned HTTP 500' });
    expect(JSON.stringify(failed)).not.toContain('REPLY-BODY-SECRET');

    reply = (res) => res.writeHead(301, { Location: 'https://elsewhere.example/' }).end();
    const moved = await webhookDriver.check(conn({ signingSecret: '' }), envWith());
    expect(moved.ok).toBe(false);
    expect(moved.facts).toMatchObject({ signed: 'no' });
    expect(moved.warnings).toHaveLength(2);
  });

  it('refuses to check an address the policy does not allow', async () => {
    const err = await failure(
      webhookDriver.check(conn({ url: 'http://169.254.169.254/' }), envWith()),
    );
    expect(err).toMatchObject({ errorClass: 'network_policy', permanent: true });
  });
});
