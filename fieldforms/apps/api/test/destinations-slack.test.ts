import { randomUUID } from 'node:crypto';
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
import { slackAdapter } from '../src/destinations/adapters/slack.js';
import { slackDriver, slackSecretSchema } from '../src/destinations/connections/slack.js';
import {
  DEFAULT_ENDPOINTS,
  DeliveryError,
  type AdapterEnv,
  type DeliveryContext,
  type OpenConnection,
} from '../src/destinations/types.js';
import { renderLiquid } from '../src/lib/liquid.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import { classify } from '../src/services/delivery-runner.js';

/** The fake Slack is on loopback: only the vendor policy allows it, as for real vendors. */
const loopback = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
const strict = parseNetworkPolicy({});

interface Received {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
let base: string;
let received: Received[] = [];
let reply: (res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
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
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  received = [];
  reply = (res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
});

const TOKEN = 'XyZ0123456789abcdefTOKEN';
const hookUrl = () => `${base}/services/T0001/B0002/${TOKEN}`;

function conn(webhookUrl = hookUrl(), channelLabel = '#site-reports'): OpenConnection {
  return { id: randomUUID(), kind: 'slack', config: { channelLabel }, secrets: { webhookUrl } };
}

function envWith(over: Partial<AdapterEnv> = {}): AdapterEnv {
  return {
    // Admin-configured hosts stay strict: Slack must go through the vendor policy.
    policy: strict,
    vendorPolicy: loopback,
    mailer: {
      async send() {
        throw new Error('Slack sends no email');
      },
    },
    endpoints: {
      ...DEFAULT_ENDPOINTS,
      slackHooks: new RegExp(`^${base.replace(/[.:/]/g, '\\$&')}/services/`),
    },
    signal: AbortSignal.timeout(10_000),
    now: () => new Date(),
    emailAttachmentLimit: 1024 * 1024,
    ...over,
  };
}

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: false },
  fields: [
    { id: 'where', type: 'text', label: 'Where' },
    { id: 'notes', type: 'text', label: 'Notes' },
  ],
};

function makeCtx(o: { where?: string; site?: string; test?: boolean } = {}): DeliveryContext {
  const id = randomUUID();
  const deliveryId = randomUUID();
  const model = buildDocumentModel(
    def,
    { where: o.where ?? 'Bay 3', notes: 'private notes' },
    {
      form: { id: randomUUID(), name: 'Spill report', version: 1, versionId: randomUUID() },
      submission: {
        id,
        receivedAt: '2026-10-07T08:00:00Z',
        capturedAt: '2026-10-07T07:58:00Z',
        clockSkewFlag: false,
        siteId: null,
        site: o.site ?? 'Bay 3',
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
  return {
    delivery: {
      id: deliveryId,
      generation: 1,
      attempt: 1,
      idempotencyKey: `${deliveryId}.1`,
      resend: false,
    },
    test: o.test ? { tester: { email: 'admin@acme.test', name: 'Ada' } } : null,
    model,
    files: [{ filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF') }],
    json: { answers: model.raw },
    value: () => null,
    liquid: (t, c) => renderLiquid(t, data, c),
    contacts: { submitterEmail: null, taskSenderEmail: null, siteRecipients: [], siteManagers: [] },
    target: null,
    earlierEvidence: [],
    link: model.submission.url,
  };
}

const settings = (s: Record<string, unknown> = {}) => destinationSettingsSchemas.slack.parse(s);

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

describe('slack delivery', () => {
  it('posts only the rendered message text', async () => {
    const ctx = makeCtx();
    const r = await slackAdapter.deliver(ctx, settings(), conn(), envWith());
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe(`/services/T0001/B0002/${TOKEN}`);
    expect(received[0]!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['text']);
    expect(body.text).toBe(
      `*Spill report* from Bay 3 (2026-10-07 09:58) <${ctx.link}|Open in FieldForms>`,
    );
    // No files, no answers beyond what the template asks for.
    expect(received[0]!.body).not.toContain('private notes');
    expect(received[0]!.body).not.toContain('%PDF');
    expect(r).toEqual({
      outcome: 'delivered',
      target: { service: 'slack', channel: '#site-reports' },
      evidence: { status: 200 },
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('escapes mentions and links in answers, keeping the template’s own', async () => {
    const ctx = makeCtx({ site: '<!channel> & <https://evil.test|click here>', where: '<@U123>' });
    await slackAdapter.deliver(
      ctx,
      settings({ message: '<!here> {{ _site }} at {{ where }} <{{ _url }}|Open>' }),
      conn(),
      envWith(),
    );
    const text = JSON.parse(received[0]!.body).text as string;
    expect(text).toBe(
      `<!here> &lt;!channel&gt; &amp; &lt;https://evil.test|click here&gt; at &lt;@U123&gt; <${ctx.link}|Open>`,
    );
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<https://evil.test');
  });

  it('marks test sends', async () => {
    await slackAdapter.deliver(
      makeCtx({ test: true }),
      settings({ message: 'Hi' }),
      conn(),
      envWith(),
    );
    expect(JSON.parse(received[0]!.body).text).toBe('[TEST] Hi');
  });

  it('refuses a message that renders empty', async () => {
    const err = await failure(
      slackAdapter.deliver(makeCtx(), settings({ message: '{{ nothing }}' }), conn(), envWith()),
    );
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
    expect(received).toHaveLength(0);
  });

  it('only posts to URLs that match the Slack pattern', async () => {
    const env = envWith();
    for (const url of [
      `${base}/other/T0001/B0002/${TOKEN}`,
      `${base.replace('127.0.0.1', 'localhost')}/services/T/B/${TOKEN}`,
      `https://hooks.slack.com.evil.test/services/T/B/${TOKEN}`,
      'not a url',
      '',
    ]) {
      const err = await failure(slackAdapter.deliver(makeCtx(), settings(), conn(url), env));
      expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
      expect(err.message).not.toContain(TOKEN);
    }
    // The production pattern: hooks.slack.com only.
    const prod = envWith({ endpoints: DEFAULT_ENDPOINTS });
    const err = await failure(slackAdapter.deliver(makeCtx(), settings(), conn(), prod));
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
    expect(received).toHaveLength(0);
  });

  it('uses the vendor network policy, not the one for admin-configured hosts', async () => {
    const err = await failure(
      slackAdapter.deliver(
        makeCtx(),
        settings(),
        conn(),
        envWith({ policy: loopback, vendorPolicy: strict }),
      ),
    );
    expect(err).toMatchObject({ permanent: true, errorClass: 'network_policy' });
    expect(received).toHaveLength(0);
  });

  it.each([
    [400, 'invalid_payload', true, 'rejected'],
    [403, 'invalid_token', true, 'credentials'],
    [403, 'action_prohibited', true, 'credentials'],
    [404, 'channel_not_found', true, 'credentials'],
    [404, 'no_service', true, 'credentials'],
    [410, 'channel_is_archived', true, 'credentials'],
    [401, null, true, 'credentials'],
    [302, null, true, 'rejected'],
    [429, null, false, 'unreachable'],
    [500, null, false, 'unreachable'],
    [503, null, false, 'unreachable'],
  ])('classifies HTTP %i %s', async (status, code, permanent, errorClass) => {
    reply = (res) =>
      res.writeHead(status, { Location: 'https://elsewhere.test/' }).end(code ?? 'oops');
    const c = conn();
    const err = await failure(slackAdapter.deliver(makeCtx(), settings(), c, envWith()));
    expect(err).toMatchObject({ permanent, errorClass, status });
    expect(err.message).toContain(`Slack returned HTTP ${status}`);
    if (code) expect(err.message).toContain(`(${code})`);
    expect(received).toHaveLength(1);
  });

  it('quotes only known Slack error codes from a reply', async () => {
    reply = (res) => res.writeHead(400).end('<html>REPLY-BODY-SECRET</html>');
    const err = await failure(slackAdapter.deliver(makeCtx(), settings(), conn(), envWith()));
    expect(err.message).toBe('Slack returned HTTP 400');
    expect(JSON.stringify(classify(err))).not.toContain('REPLY-BODY-SECRET');
  });

  it('keeps the webhook URL out of connection errors', async () => {
    const c = conn(`http://127.0.0.1:1/services/T0001/B0002/${TOKEN}`);
    const env = envWith({
      endpoints: { ...DEFAULT_ENDPOINTS, slackHooks: /^http:\/\/127\.0\.0\.1:1\/services\// },
    });
    const err = await failure(slackAdapter.deliver(makeCtx(), settings(), c, env));
    expect(err).toMatchObject({ message: 'Could not connect to Slack', permanent: false });
    const s = classify(err, c.secrets);
    expect(`${s.message} ${s.detail ?? ''}`).not.toContain(TOKEN);
    expect(`${s.message} ${s.detail ?? ''}`).not.toContain('127.0.0.1:1');
  });
});

describe('slack connection', () => {
  it('accepts only Slack incoming-webhook URLs', () => {
    const ok = (webhookUrl: string) => slackSecretSchema.safeParse({ webhookUrl }).success;
    expect(ok('https://hooks.slack.com/services/T0001/B0002/abcdef')).toBe(true);
    expect(ok('https://hooks.slack.com/workflows/T0001/A0002/123/abc')).toBe(true);
    expect(ok('http://hooks.slack.com/services/T0001/B0002/abcdef')).toBe(false);
    expect(ok('https://hooks.slack.com.evil.test/services/T/B/x')).toBe(false);
    expect(ok('https://evil.test/https://hooks.slack.com/services/')).toBe(false);
    expect(ok('https://hooks.slack.com/api/chat.postMessage')).toBe(false);
  });

  it('posts "FieldForms is connected" and reports Slack’s answer', async () => {
    const r = await slackDriver.check(conn(), envWith());
    expect(r).toMatchObject({ ok: true, facts: { channel: '#site-reports' } });
    expect(JSON.parse(received[0]!.body)).toEqual({ text: 'FieldForms is connected' });

    reply = (res) => res.writeHead(404).end('channel_not_found');
    const failed = await slackDriver.check(conn(), envWith());
    expect(failed).toMatchObject({
      ok: false,
      summary: 'Slack returned HTTP 404 (channel_not_found)',
    });
  });

  it('refuses to check a URL that is not Slack’s', async () => {
    const err = await failure(
      slackDriver.check(conn('https://evil.test/services/T/B/x'), envWith()),
    );
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
    expect(received).toHaveLength(0);
  });
});
