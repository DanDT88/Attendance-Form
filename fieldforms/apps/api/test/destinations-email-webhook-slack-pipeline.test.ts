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
  INCLUDE_ALL,
  type DestinationKind,
  type Format,
  type FormDefinition,
} from '@fieldforms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINTS, type Mailer } from '../src/destinations/types.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import { runDelivery, runTest, type PipelineDeps } from '../src/services/delivery-runner.js';
import { planDeliveries, submissionFacts } from '../src/services/deliveries.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

/**
 * The email, webhook and Slack adapters through the real delivery runner: contacts looked up in
 * the database, attempt rows with target and evidence, safe errors, test sends and checks. The
 * documents service is faked (its renderers are tested on their own).
 */
let t: TestContext;
let sup: string;
let formId: string;
let versionId: string;
let deps: PipelineDeps;

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: false },
  fields: [
    { id: 'litres', type: 'number', label: 'Litres' },
    { id: 'where', type: 'text', label: 'Where' },
    { id: 'contact', type: 'text', label: 'Contact email' },
  ],
};

type Sent = Parameters<Mailer['send']>[0];
const mails: Sent[] = [];
const mailer: Mailer = {
  async send(m) {
    mails.push(m);
    return { messageId: `<${randomUUID()}@ff.test>`, response: '250 2.0.0 Ok: queued' };
  },
};

interface Received {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
let base: string;
let received: Received[] = [];
let reply: (res: ServerResponse) => void;

const TOKEN = 'Zq81hTok3nPathSecret';
const QUERY_TOKEN = 'qTok3nQuerySecret99';
const SIGNING = 'whsec_pipeline_signing_0123456789';

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

  t = await createTestContext();
  const admin = await login(t.app, 'admin@acme.test');
  sup = await login(t.app, 'S001');
  const f = await t.app.inject({
    method: 'POST',
    url: '/api/admin/forms',
    headers: { ...H, cookie: admin },
    payload: { name: 'Spill report', definition: def },
  });
  formId = f.json().id;
  await t.app.inject({
    method: 'POST',
    url: `/api/admin/forms/${formId}/publish`,
    headers: { ...H, cookie: admin },
  });
  versionId = (
    await t.owner
      .selectFrom('form_versions')
      .select('id')
      .where('form_id', '=', formId)
      .executeTakeFirstOrThrow()
  ).id;

  const policy = parseNetworkPolicy({
    DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8',
    DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
  });
  deps = {
    db: t.db,
    queue: {
      enqueueRegisterNotify: async () => {},
      enqueueDispatchNotify: async () => {},
      enqueuePlanDeliveries: async (submissionId) =>
        void t.jobs.push({ name: 'plan', data: { submissionId } }),
      enqueueDelivery: async (job, _trx, startAfter) =>
        void t.jobs.push({ name: 'deliver', data: { ...job }, startAfter }),
      enqueueTest: async (testId) => void t.jobs.push({ name: 'test', data: { testId } }),
    },
    blobs: { put: async () => {}, get: async () => null, ensureReady: async () => {} },
    opener: t.opener,
    pdf: t.pdf,
    mailer,
    publicUrl: 'https://ff.example',
    policy,
    vendorPolicy: policy,
    endpoints: {
      ...DEFAULT_ENDPOINTS,
      slackHooks: new RegExp(`^${base.replace(/[.:/]/g, '\\$&')}/services/`),
    },
    emailAttachmentLimit: 10 * 1024 * 1024,
    worker: 'test',
    documents: {
      async loadSubmission(db, id) {
        const facts = (await submissionFacts(db, [id])).get(id);
        if (!facts) return null;
        const row = await db
          .selectFrom('form_submissions')
          .select(['submitted_by', 'dispatch_id'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        const model = buildDocumentModel(
          facts.definition,
          facts.answers,
          {
            form: { id: facts.formId, name: 'Spill report', version: 1, versionId },
            submission: {
              id: facts.id,
              receivedAt: facts.receivedAt,
              capturedAt: facts.capturedAt,
              clockSkewFlag: facts.clockSkewFlag,
              siteId: facts.siteId,
              site: facts.site,
              region: facts.region,
              company: facts.company,
              submittedBy: facts.submittedBy,
              taskTitle: facts.taskTitle,
              url: `https://ff.example/submissions/${facts.id}`,
            },
            branding: { name: 'Acme', colour: '#123456', logoBlobId: null, footer: '' },
          },
          { include: INCLUDE_ALL },
        );
        return {
          model,
          definition: facts.definition,
          versions: [{ version: 1, definition: facts.definition }],
          lists: {},
          answers: facts.answers,
          siteId: facts.siteId,
          submittedBy: row.submitted_by,
          dispatchId: row.dispatch_id,
        };
      },
      async loadTemplate() {
        return null;
      },
      async renderFormat(_d, input) {
        return {
          files: [
            {
              filename: `${input.stem}.json`,
              contentType: 'application/json',
              data: Buffer.from(JSON.stringify(input.model.raw)),
            },
          ],
          cached: false,
        };
      },
      submissionJson: (model) => ({
        schema: 'fieldforms.submission/1',
        id: model.submission.id,
        answers: model.raw,
      }),
      sampleSubmission: (d, form, include) =>
        buildDocumentModel(
          d,
          { litres: 1, where: 'Sample', contact: 'sample@example.com' },
          {
            form,
            submission: {
              id: '00000000-0000-4000-8000-000000000000',
              receivedAt: new Date(),
              capturedAt: null,
              clockSkewFlag: false,
              siteId: null,
              site: 'Sample site',
              region: '',
              company: '',
              submittedBy: 'Sample person',
              taskTitle: '',
              url: '',
              sample: true,
            },
            branding: { name: '', colour: '#000000', logoBlobId: null, footer: '' },
          },
          { include },
        ),
    },
  };
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await t?.close();
});
beforeEach(() => {
  mails.length = 0;
  received = [];
  t.jobs.length = 0;
  reply = (res) => res.writeHead(200, { 'Content-Length': '2' }).end('ok');
});

async function submit(answers: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/form-submissions',
    headers: { ...H, cookie: sup },
    payload: {
      id,
      formVersionId: versionId,
      siteId: t.fx.siteA,
      answers,
      deviceCapturedAt: now,
      deviceSentAt: now,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return id;
}

async function connection(
  kind: 'webhook' | 'slack',
  secrets: Record<string, string>,
  config: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await t.owner
    .insertInto('connections')
    .values({
      id,
      name: `${kind} ${id.slice(0, 4)}`,
      kind,
      config: JSON.stringify(config),
      secrets: t.opener.seal(secrets, `connection:${id}`),
      secret_keys: Object.keys(secrets),
      secrets_version: 1,
    })
    .execute();
  await t.owner
    .insertInto('connection_revisions')
    .values({
      connection_id: id,
      revision: 1,
      name: kind,
      config: JSON.stringify(config),
      secrets_version: 1,
    })
    .execute();
  return id;
}

async function destination(
  kind: DestinationKind,
  settings: Record<string, unknown>,
  connectionId: string | null = null,
  formats: Format[] = ['json'],
): Promise<string> {
  const id = randomUUID();
  const row = {
    name: `${kind} ${id.slice(0, 4)}`,
    connection_id: connectionId,
    formats,
    templates: '{}',
    settings: JSON.stringify(settings),
    include: '{}',
  };
  await t.owner
    .insertInto('destinations')
    .values({ id, form_id: formId, kind, ...row, condition: null, active: true })
    .execute();
  await t.owner
    .insertInto('destination_revisions')
    .values({ destination_id: id, revision: 1, ...row, cross_border: false, active: true })
    .execute();
  return id;
}

/** Plans a fresh submission and runs its delivery to `dest` once. */
async function deliverTo(dest: string, answers: Record<string, unknown> = {}) {
  const s = await submit({ litres: 4, where: 'Bay 3', ...answers });
  await planDeliveries(t.db, deps.queue, s);
  const d = await t.owner
    .selectFrom('deliveries')
    .selectAll()
    .where('submission_id', '=', s)
    .where('destination_id', '=', dest)
    .executeTakeFirstOrThrow();
  const outcome = await runDelivery(deps, { deliveryId: d.id, generation: 1 });
  const after = await t.owner
    .selectFrom('deliveries')
    .selectAll()
    .where('id', '=', d.id)
    .executeTakeFirstOrThrow();
  const attempts = await t.owner
    .selectFrom('delivery_attempts')
    .selectAll()
    .where('delivery_id', '=', d.id)
    .execute();
  return { outcome, delivery: after, attempt: attempts[0]!, submissionId: s };
}

async function runTestRow(values: {
  kind: 'check' | 'test_send';
  destination_id?: string;
  connection_id?: string;
}) {
  const row = await t.owner
    .insertInto('destination_tests')
    .values({ ...values, requested_by: t.fx.users.admin })
    .returning('id')
    .executeTakeFirstOrThrow();
  const status = await runTest(deps, row.id);
  const done = await t.owner
    .selectFrom('destination_tests')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
  return { status, result: done.result as Record<string, unknown> };
}

describe('email through the pipeline', () => {
  it("sends to the site's recipients and managers and records recipients and SMTP evidence", async () => {
    const dest = await destination('email', {
      recipients: {
        addresses: ['team@acme.test'],
        siteRecipients: true,
        siteManagers: true,
        submitter: true,
      },
    });
    const r = await deliverTo(dest);
    expect(r.outcome).toBe('delivered');
    expect(mails).toHaveLength(1);
    // Site A has no recipients of its own, so the company's; Bea manages only site B; the
    // supervisor who submitted has no email address.
    const to = ['team@acme.test', 'ops@acme.test', 'manager@acme.test'];
    expect(mails[0]!.to).toEqual(to);
    expect(mails[0]!.attachments.map((a) => a.contentType)).toEqual(['application/json']);
    expect(mails[0]!.headers?.['X-FieldForms-Delivery']).toBe(`${r.delivery.id}.1`);
    expect(r.delivery.status).toBe('delivered');
    expect(r.attempt.target).toEqual({ to, cc: [] });
    expect(r.attempt.evidence).toMatchObject({
      response: '250 2.0.0 Ok: queued',
      attached: true,
      bytes: mails[0]!.attachments[0]!.content.length,
    });
  });

  it('is skipped when no source gives an address', async () => {
    const dest = await destination('email', { recipients: { fields: ['contact'] } });
    const r = await deliverTo(dest, { contact: 'not an address' });
    expect(r.outcome).toBe('skipped');
    expect(r.delivery.status).toBe('skipped');
    expect(r.attempt.detail).toBe('No recipients');
    expect(mails).toHaveLength(0);
  });

  it('sends to an address from a form field', async () => {
    const dest = await destination('email', { recipients: { fields: ['contact'] } });
    const r = await deliverTo(dest, { contact: 'Client@Example.com' });
    expect(r.outcome).toBe('delivered');
    expect(mails[0]!.to).toEqual(['client@example.com']);
  });

  it('sends a test only to the admin who asked for it', async () => {
    const dest = await destination('email', {
      recipients: { addresses: ['team@acme.test'], siteManagers: true },
    });
    const r = await runTestRow({ kind: 'test_send', destination_id: dest });
    expect(r.status).toBe('ok');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual(['admin@acme.test']);
    expect(mails[0]!.subject).toMatch(/^\[TEST\] /);
    expect(r.result).toMatchObject({
      summary: 'Test sent',
      target: { to: ['admin@acme.test'], cc: [] },
    });
  });
});

describe('webhook through the pipeline', () => {
  const secrets = () => ({
    url: `${base}/hooks/${TOKEN}?key=${QUERY_TOKEN}`,
    signingSecret: SIGNING,
  });

  it('delivers signed JSON and records only safe facts', async () => {
    const conn = await connection('webhook', secrets(), { urlOrigin: base });
    const dest = await destination('webhook', { includeFiles: true }, conn);
    const r = await deliverTo(dest);
    expect(r.outcome).toBe('delivered');
    expect(received).toHaveLength(1);
    expect(received[0]!.headers['idempotency-key']).toBe(`${r.delivery.id}.1`);
    expect(received[0]!.headers['x-fieldforms-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const body = JSON.parse(received[0]!.body);
    expect(body).toMatchObject({
      event: 'submission',
      test: false,
      delivery: { id: r.delivery.id, generation: 1, attempt: 1 },
      submission: { id: r.submissionId },
    });
    expect(body.files).toHaveLength(1);
    expect(r.attempt.target).toEqual({ origin: base, path: '/hooks/*' });
    expect(r.attempt.evidence).toMatchObject({ status: 200, contentLength: 2 });
    const stored = JSON.stringify([r.attempt, r.delivery]);
    for (const secret of [TOKEN, QUERY_TOKEN, SIGNING]) expect(stored).not.toContain(secret);
  });

  it('retries a server error later, with a safe error and no reply body', async () => {
    reply = (res) => res.writeHead(500).end(`trace REPLY-BODY-SECRET ${TOKEN}`);
    const conn = await connection('webhook', secrets());
    const dest = await destination('webhook', {}, conn);
    const r = await deliverTo(dest);
    expect(r.outcome).toBe('retry');
    expect(r.delivery).toMatchObject({
      status: 'pending',
      last_error: 'Receiver returned HTTP 500',
      last_error_class: 'unreachable',
    });
    const stored = JSON.stringify([r.attempt, r.delivery]);
    for (const secret of ['REPLY-BODY-SECRET', TOKEN, QUERY_TOKEN, SIGNING])
      expect(stored).not.toContain(secret);
  });

  it('fails at once, as not allowed, for the cloud metadata address', async () => {
    const conn = await connection('webhook', { url: `http://169.254.169.254/latest/${TOKEN}` });
    const dest = await destination('webhook', {}, conn);
    const r = await deliverTo(dest);
    expect(r.outcome).toBe('failed');
    expect(r.delivery).toMatchObject({
      status: 'failed',
      last_error: 'Address not allowed',
      last_error_class: 'network_policy',
    });
    expect(JSON.stringify(r.attempt)).not.toContain(TOKEN);
  });

  it('checks a saved connection with a signed ping and stores a safe summary', async () => {
    const conn = await connection('webhook', secrets());
    const r = await runTestRow({ kind: 'check', connection_id: conn });
    expect(r.status).toBe('ok');
    expect(JSON.parse(received[0]!.body)).toEqual({ event: 'ping' });
    const row = await t.owner
      .selectFrom('connections')
      .select(['last_check_ok', 'last_check_detail'])
      .where('id', '=', conn)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      last_check_ok: true,
      last_check_detail: 'The receiver answered HTTP 200',
    });
    expect(JSON.stringify(r.result)).not.toContain(TOKEN);
  });

  it('marks a test send', async () => {
    const conn = await connection('webhook', secrets());
    const dest = await destination('webhook', {}, conn);
    const r = await runTestRow({ kind: 'test_send', destination_id: dest });
    expect(r.status).toBe('ok');
    expect(received[0]!.headers['x-fieldforms-test']).toBe('1');
    expect(JSON.parse(received[0]!.body).test).toBe(true);
  });
});

describe('slack through the pipeline', () => {
  it('posts the message and records the channel, never the URL', async () => {
    const conn = await connection(
      'slack',
      { webhookUrl: `${base}/services/T0001/B0002/${TOKEN}` },
      { channelLabel: '#spills' },
    );
    const dest = await destination(
      'slack',
      { message: '{{ _form }} at {{ where }}: <{{ _url }}|open>' },
      conn,
      [],
    );
    const r = await deliverTo(dest, { where: '<!channel> Bay 3' });
    expect(r.outcome).toBe('delivered');
    expect(JSON.parse(received[0]!.body)).toEqual({
      text: `Spill report at &lt;!channel&gt; Bay 3: <https://ff.example/submissions/${r.submissionId}|open>`,
    });
    expect(r.attempt.target).toEqual({ service: 'slack', channel: '#spills' });
    expect(r.attempt.evidence).toEqual({ status: 200 });
    expect(JSON.stringify(r.attempt)).not.toContain(TOKEN);
  });

  it('fails permanently when Slack says the channel is gone', async () => {
    reply = (res) => res.writeHead(404).end('channel_not_found');
    const conn = await connection('slack', { webhookUrl: `${base}/services/T0001/B0002/${TOKEN}` });
    const dest = await destination('slack', {}, conn, []);
    const r = await deliverTo(dest);
    expect(r.outcome).toBe('failed');
    expect(r.delivery).toMatchObject({
      last_error: 'Slack returned HTTP 404 (channel_not_found)',
      last_error_class: 'credentials',
    });
  });
});
