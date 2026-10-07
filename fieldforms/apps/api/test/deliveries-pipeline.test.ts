import {
  buildDocumentModel,
  INCLUDE_ALL,
  type DocumentModel,
  type FormDefinition,
} from '@fieldforms/shared';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS, DRIVERS } from '../src/destinations/index.js';
import {
  DEFAULT_ENDPOINTS,
  DeliveryError,
  type DeliveryContext,
  type DestinationAdapter,
  type Mailer,
} from '../src/destinations/types.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import { runAlerts } from '../src/services/delivery-alerts.js';
import {
  backoffSeconds,
  runDelivery,
  runTest,
  type PipelineDeps,
} from '../src/services/delivery-runner.js';
import {
  planDeliveries,
  resendDeliveries,
  retryNow,
  submissionFacts,
  sweepDeliveries,
} from '../src/services/deliveries.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let sup: string;
let formId: string;
let versionId: string;

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Spill report',
  settings: { siteRequired: false },
  fields: [
    { id: 'litres', type: 'number', label: 'Litres' },
    { id: 'where', type: 'text', label: 'Where' },
  ],
};

/** What the fake adapter should do on each call, in order. */
type Step =
  | { ok: true; outcome?: 'delivered' | 'already_present' | 'skipped' }
  | { throw: DeliveryError | Error };
let steps: Step[] = [];
const calls: { ctx: DeliveryContext; settings: unknown }[] = [];
let resolveTargetCalls = 0;

const fakeAdapter: DestinationAdapter = {
  kind: 'webhook',
  async resolveTarget(ctx) {
    resolveTargetCalls++;
    return { path: `/hook/${ctx.model.submission.shortId}` };
  },
  async deliver(ctx, settings) {
    calls.push({ ctx, settings });
    const s = steps.shift() ?? { ok: true };
    if ('throw' in s) throw s.throw;
    return {
      outcome: s.outcome ?? 'delivered',
      target: { ...(ctx.target ?? {}) },
      evidence: { status: 200 },
      detail: s.outcome === 'skipped' ? 'Nothing to do' : undefined,
    };
  },
  async check() {
    return { ok: true, summary: 'Destination fine' };
  },
};

const mails: { to: string[]; subject: string; html: string }[] = [];
let mailDown = false;
const mailer: Mailer = {
  async send(m) {
    if (mailDown) throw new Error('SMTP down');
    mails.push(m);
    return { messageId: 'x' };
  },
};

function modelFor(
  facts: Awaited<ReturnType<typeof submissionFacts>> extends Map<string, infer F> ? F : never,
): DocumentModel {
  return buildDocumentModel(
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
}

let deps: PipelineDeps;

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
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
    endpoints: DEFAULT_ENDPOINTS,
    emailAttachmentLimit: 10 * 1024 * 1024,
    worker: 'test',
    documents: {
      async loadSubmission(db, id) {
        const facts = (await submissionFacts(db, [id])).get(id);
        if (!facts) return null;
        return {
          model: modelFor(facts),
          definition: facts.definition,
          versions: [{ version: 1, definition: facts.definition }],
          lists: {},
          answers: facts.answers,
          siteId: facts.siteId,
          submittedBy: null,
          dispatchId: null,
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
      submissionJson: (model) => ({ id: model.submission.id }),
      sampleSubmission: (d, form, include) =>
        buildDocumentModel(
          d,
          { litres: 1, where: 'Sample' },
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
    adapters: { ...ADAPTERS, webhook: fakeAdapter },
    drivers: {
      ...DRIVERS,
      webhook: {
        kind: 'webhook',
        secretSchema: DRIVERS.webhook.secretSchema,
        async check(conn) {
          return {
            ok: !!conn.secrets.url,
            summary: `Reached ${conn.secrets.url ? 'the URL' : 'nothing'}`,
          };
        },
      },
    },
  };
});
afterAll(async () => t?.close());
beforeEach(() => {
  steps = [];
  calls.length = 0;
  resolveTargetCalls = 0;
  t.jobs.length = 0;
  mails.length = 0;
  mailDown = false;
});

async function submit(litres: number): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/form-submissions',
    headers: { ...H, cookie: sup },
    payload: {
      id,
      formVersionId: versionId,
      answers: { litres, where: 'Bay 3' },
      deviceCapturedAt: now,
      deviceSentAt: now,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return id;
}

const SECRET = 'https://hooks.example/abc?token=super-secret-token-123';

async function connection(): Promise<string> {
  const id = randomUUID();
  await t.owner
    .insertInto('connections')
    .values({
      id,
      name: `Hook ${id.slice(0, 4)}`,
      kind: 'webhook',
      config: '{}',
      secrets: t.opener.seal({ url: SECRET }, `connection:${id}`),
      secret_keys: ['url'],
      secrets_version: 1,
    })
    .execute();
  await t.owner
    .insertInto('connection_revisions')
    .values({ connection_id: id, revision: 1, name: 'Hook', config: '{}', secrets_version: 1 })
    .execute();
  return id;
}

async function destination(
  opts: { condition?: string | null; createdAt?: Date; active?: boolean } = {},
) {
  const conn = await connection();
  const id = randomUUID();
  await t.owner
    .insertInto('destinations')
    .values({
      id,
      form_id: formId,
      name: `Hook ${id.slice(0, 4)}`,
      kind: 'webhook',
      connection_id: conn,
      formats: ['json'],
      settings: JSON.stringify({ includeFiles: false }),
      include: '{}',
      templates: '{}',
      condition: opts.condition ?? null,
      active: opts.active ?? true,
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
    })
    .execute();
  await t.owner
    .insertInto('destination_revisions')
    .values({
      destination_id: id,
      revision: 1,
      name: 'Hook',
      connection_id: conn,
      formats: ['json'],
      templates: '{}',
      settings: '{}',
      include: '{}',
      cross_border: false,
      active: true,
    })
    .execute();
  return id;
}

const deliveryOf = (submissionId: string, destinationId: string) =>
  t.owner
    .selectFrom('deliveries')
    .selectAll()
    .where('submission_id', '=', submissionId)
    .where('destination_id', '=', destinationId)
    .executeTakeFirstOrThrow();
const attemptsOf = (deliveryId: string) =>
  t.owner
    .selectFrom('delivery_attempts')
    .selectAll()
    .where('delivery_id', '=', deliveryId)
    .orderBy('finished_at')
    .execute();

describe('planning', () => {
  it('enqueues planning with the submission and plans each submission once', async () => {
    const dest = await destination();
    const before = new Date(Date.now() + 60_000);
    const late = await destination({ createdAt: before });
    const off = await destination({ active: false });
    const s = await submit(5);
    expect(t.jobs).toEqual([{ name: 'plan', data: { submissionId: s } }]);
    t.jobs.length = 0;
    expect(await planDeliveries(t.db, deps.queue, s)).toBe('planned');
    expect(await planDeliveries(t.db, deps.queue, s)).toBe('already-planned');
    const rows = await t.owner
      .selectFrom('deliveries')
      .select(['destination_id', 'status'])
      .where('submission_id', '=', s)
      .execute();
    // Only destinations that were active and existed when it arrived.
    expect(rows.map((r) => r.destination_id)).toContain(dest);
    expect(rows.map((r) => r.destination_id)).not.toContain(late);
    expect(rows.map((r) => r.destination_id)).not.toContain(off);
    expect(t.jobs.filter((j) => j.name === 'deliver').length).toBe(
      rows.filter((r) => r.status === 'pending').length,
    );
  });
});

describe('delivering', () => {
  it('delivers once even when two workers get the same job, and records the evidence', async () => {
    const dest = await destination();
    const s = await submit(7);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    const [a, b] = await Promise.all([
      runDelivery(deps, { deliveryId: d.id, generation: 1 }),
      runDelivery(deps, { deliveryId: d.id, generation: 1 }),
    ]);
    expect([a, b].sort()).toEqual(['delivered', 'not-claimed']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx.delivery).toMatchObject({
      idempotencyKey: `${d.id}.1`,
      resend: false,
      attempt: 1,
    });
    const after = await deliveryOf(s, dest);
    expect(after).toMatchObject({ status: 'delivered', lease_token: null, last_error: null });
    const [attempt] = await attemptsOf(d.id);
    expect(attempt).toMatchObject({
      outcome: 'delivered',
      generation: 1,
      attempt_no: 1,
      worker: 'test',
    });
    expect((attempt!.documents as { sha256: string }[])[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt!.target).toEqual({ path: `/hook/${s.replace(/-/g, '').slice(0, 8)}` });
    expect(attempt!.destination_revision_id).not.toBeNull();
    expect(attempt!.connection_revision_id).not.toBeNull();
    const destRow = await t.owner
      .selectFrom('destinations')
      .select(['last_success_at', 'failing_since'])
      .where('id', '=', dest)
      .executeTakeFirstOrThrow();
    expect(destRow.last_success_at).not.toBeNull();
    // A job for another generation, or a second job, does nothing.
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('not-claimed');
  });

  it('retries a transient failure later, with the same target, and never stores the secret', async () => {
    const dest = await destination();
    const s = await submit(8);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    t.jobs.length = 0;
    steps = [
      {
        throw: new DeliveryError('Receiver returned HTTP 503', {
          permanent: false,
          errorClass: 'unreachable',
          detail: `POST ${SECRET} failed with token super-secret-token-123`,
        }),
      },
    ];
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('retry');
    const row = await deliveryOf(s, dest);
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 15_000);
    expect(t.jobs).toEqual([
      {
        name: 'deliver',
        data: { deliveryId: d.id, generation: 1 },
        startAfter: row.next_attempt_at,
      },
    ]);
    const [attempt] = await attemptsOf(d.id);
    expect(attempt!.outcome).toBe('retry');
    expect(JSON.stringify(attempt)).not.toContain('super-secret-token-123');
    expect(JSON.stringify(row)).not.toContain('super-secret-token-123');

    // Due again: the second attempt reuses the target fixed by the first.
    await t.owner
      .updateTable('deliveries')
      .set({ next_attempt_at: new Date() })
      .where('id', '=', d.id)
      .execute();
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('delivered');
    expect(resolveTargetCalls).toBe(1);
    expect(calls.at(-1)!.ctx.delivery.attempt).toBe(2);
  });

  it('fails at once on a permanent error and opens an incident on the destination', async () => {
    const dest = await destination();
    const s = await submit(9);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    steps = [
      {
        throw: new DeliveryError('Receiver returned HTTP 401', {
          permanent: true,
          errorClass: 'credentials',
        }),
      },
    ];
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('failed');
    expect(await deliveryOf(s, dest)).toMatchObject({
      status: 'failed',
      last_error_class: 'credentials',
    });
    const row = await t.owner
      .selectFrom('destinations')
      .select(['failing_since', 'consecutive_failures'])
      .where('id', '=', dest)
      .executeTakeFirstOrThrow();
    expect(row.failing_since).not.toBeNull();
    expect(row.consecutive_failures).toBe(1);
  });

  it('gives up after the last attempt, and treats unknown errors as retryable', async () => {
    const dest = await destination();
    const s = await submit(10);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    await t.owner
      .updateTable('deliveries')
      .set({ attempt_count: 29 })
      .where('id', '=', d.id)
      .execute();
    steps = [{ throw: new Error('socket hang up') }];
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('failed');
    const attempts = await attemptsOf(d.id);
    expect(attempts.at(-1)!.detail).toMatch(/^Gave up after 30 attempts: Unexpected error/);
  });

  it('cancels a delivery whose destination was switched off before it ran', async () => {
    const dest = await destination();
    const s = await submit(11);
    await planDeliveries(t.db, deps.queue, s);
    await t.owner
      .updateTable('destinations')
      .set({ active: false })
      .where('id', '=', dest)
      .execute();
    const d = await deliveryOf(s, dest);
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('records a skipped outcome from the adapter', async () => {
    const dest = await destination();
    const s = await submit(12);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    steps = [{ ok: true, outcome: 'skipped' }];
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('skipped');
    expect((await attemptsOf(d.id))[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'Nothing to do',
    });
  });

  it('backs off from 30 s, doubling, capped at an hour', () => {
    expect([1, 2, 3, 8, 9, 20].map((n) => backoffSeconds(n, 0.5))).toEqual([
      30, 60, 120, 3600, 3600, 3600,
    ]);
  });
});

describe('resend and retry', () => {
  it('resends as a new generation with a new idempotency key; a pending one is left alone', async () => {
    const dest = await destination();
    const s = await submit(13);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    expect(
      (await t.db.transaction().execute((trx) => resendDeliveries(trx, deps.queue, [d.id])))
        .skipped,
    ).toEqual([{ id: d.id, reason: 'Already being delivered' }]);
    await runDelivery(deps, { deliveryId: d.id, generation: 1 });
    t.jobs.length = 0;
    const r = await t.db.transaction().execute((trx) => resendDeliveries(trx, deps.queue, [d.id]));
    expect(r.resent).toEqual([d.id]);
    expect(t.jobs).toEqual([
      { name: 'deliver', data: { deliveryId: d.id, generation: 2 }, startAfter: undefined },
    ]);
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('not-claimed');
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 2 })).toBe('delivered');
    expect(calls.at(-1)!.ctx.delivery).toMatchObject({
      idempotencyKey: `${d.id}.2`,
      resend: true,
      attempt: 1,
    });
    expect(resolveTargetCalls).toBe(2);
  });

  it('brings a waiting retry forward', async () => {
    const dest = await destination();
    const s = await submit(14);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    steps = [{ throw: new Error('flaky') }];
    await runDelivery(deps, { deliveryId: d.id, generation: 1 });
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('not-claimed');
    expect(await t.db.transaction().execute((trx) => retryNow(trx, deps.queue, d.id))).toBe(true);
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 1 })).toBe('delivered');
  });
});

describe('sweeper', () => {
  it('returns a vanished worker’s delivery to pending with an abandoned attempt', async () => {
    const dest = await destination();
    const s = await submit(15);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    await t.owner
      .updateTable('deliveries')
      .set({
        status: 'sending',
        lease_token: randomUUID(),
        lease_until: new Date(Date.now() - 1000),
        attempt_count: 1,
      })
      .where('id', '=', d.id)
      .execute();
    t.jobs.length = 0;
    const r = await sweepDeliveries(t.db, deps.queue);
    expect(r.abandoned).toBe(1);
    expect(await deliveryOf(s, dest)).toMatchObject({ status: 'pending', lease_token: null });
    expect((await attemptsOf(d.id)).map((a) => a.outcome)).toEqual(['abandoned']);
    expect(t.jobs).toContainEqual({
      name: 'deliver',
      data: { deliveryId: d.id, generation: 1 },
      startAfter: undefined,
    });
  });

  it('plans submissions that were never planned, after two minutes', async () => {
    const id = randomUUID();
    await t.owner
      .insertInto('form_submissions')
      .values({
        id,
        form_id: formId,
        form_version_id: versionId,
        data: JSON.stringify({ litres: 1 }),
        server_received_at: new Date(Date.now() - 10 * 60_000),
      })
      .execute();
    t.jobs.length = 0;
    await sweepDeliveries(t.db, deps.queue);
    expect(t.jobs).toContainEqual({ name: 'plan', data: { submissionId: id } });
  });
});

describe('alerts', () => {
  it('sends one alert per incident, then a recovery note; nothing is marked when mail is down', async () => {
    const dest = await destination();
    const s = await submit(16);
    await planDeliveries(t.db, deps.queue, s);
    const d = await deliveryOf(s, dest);
    steps = [
      {
        throw: new DeliveryError('Receiver returned HTTP 401', {
          permanent: true,
          errorClass: 'credentials',
        }),
      },
    ];
    await runDelivery(deps, { deliveryId: d.id, generation: 1 });

    mailDown = true;
    await expect(runAlerts(t.db, mailer, 'https://ff.example')).rejects.toThrow('SMTP down');
    mailDown = false;
    await runAlerts(t.db, mailer, 'https://ff.example');
    const incident = mails.filter((m) => m.subject.startsWith('Deliveries failing'));
    expect(incident.length).toBeGreaterThanOrEqual(1);
    expect(incident.some((m) => m.html.includes('The destination rejected the credentials'))).toBe(
      true,
    );
    expect(incident[0]!.to).toEqual(['admin@acme.test']);
    mails.length = 0;
    await runAlerts(t.db, mailer, 'https://ff.example');
    expect(
      mails.filter(
        (m) => m.subject.includes(dest.slice(0, 4)) || m.subject.startsWith('Deliveries failing'),
      ),
    ).toHaveLength(0);

    // It works again: one recovery note.
    await t.db.transaction().execute((trx) => resendDeliveries(trx, deps.queue, [d.id]));
    expect(await runDelivery(deps, { deliveryId: d.id, generation: 2 })).toBe('delivered');
    mails.length = 0;
    await runAlerts(t.db, mailer, 'https://ff.example');
    expect(mails.filter((m) => m.subject.startsWith('Recovered'))).toHaveLength(1);
  });
});

describe('checks and test sends (run by the worker)', () => {
  it('checks a draft connection with secrets sealed to the test row', async () => {
    const id = randomUUID();
    await t.owner
      .insertInto('destination_tests')
      .values({
        id,
        kind: 'check',
        draft_kind: 'webhook',
        draft_config: '{}',
        draft_secrets: t.opener.seal({ url: 'https://x.example/hook' }, `test:${id}`),
        requested_by: t.fx.users.admin,
      })
      .execute();
    expect(await runTest(deps, id)).toBe('ok');
    const row = await t.owner
      .selectFrom('destination_tests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ok');
    expect(JSON.stringify(row.result)).not.toContain('x.example');
  });

  it('test-sends a sample without creating a delivery, marked as a test', async () => {
    const dest = await destination();
    const id = randomUUID();
    await t.owner
      .insertInto('destination_tests')
      .values({ id, kind: 'test_send', destination_id: dest, requested_by: t.fx.users.admin })
      .execute();
    const before = await t.owner
      .selectFrom('deliveries')
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow();
    expect(await runTest(deps, id)).toBe('ok');
    expect(calls.at(-1)!.ctx.test).toEqual({
      tester: { email: 'admin@acme.test', name: 'Ada Admin' },
    });
    expect(calls.at(-1)!.ctx.model.submission.sample).toBe(true);
    const after = await t.owner
      .selectFrom('deliveries')
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});

describe('other alerts', () => {
  it('warns once a week about connection secrets that expire within 30 days', async () => {
    const id = await connection();
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await t.owner
      .updateTable('connections')
      .set({ secret_expires_on: soon })
      .where('id', '=', id)
      .execute();
    mails.length = 0;
    await runAlerts(t.db, mailer, 'https://ff.example');
    expect(mails.filter((m) => m.subject.startsWith(`Credentials expire on ${soon}`))).toHaveLength(
      1,
    );
    mails.length = 0;
    await runAlerts(t.db, mailer, 'https://ff.example');
    expect(mails.filter((m) => m.subject.startsWith('Credentials expire'))).toHaveLength(0);
  });

  it('marks nothing when nobody can be told', async () => {
    await t.owner.updateTable('users').set({ active: false }).where('role', '=', 'admin').execute();
    const dest = await destination();
    await t.owner
      .updateTable('destinations')
      .set({ failing_since: new Date() })
      .where('id', '=', dest)
      .execute();
    expect(await runAlerts(t.db, mailer, 'https://ff.example')).toEqual({ sent: 0, recipients: 0 });
    const row = await t.owner
      .selectFrom('destinations')
      .select('incident_alerted_at')
      .where('id', '=', dest)
      .executeTakeFirstOrThrow();
    expect(row.incident_alerted_at).toBeNull();
    // Configured recipients take over from admins.
    await t.owner
      .insertInto('settings')
      .values({ key: 'deliveryAlertEmails', value: JSON.stringify(['ops@acme.test']) })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(['ops@acme.test']) }),
      )
      .execute();
    mails.length = 0;
    await runAlerts(t.db, mailer, 'https://ff.example');
    expect(mails.some((m) => m.to.includes('ops@acme.test'))).toBe(true);
  });
});

describe('error classification', () => {
  it('classes policy, secret, template and unknown errors', async () => {
    const { classify } = await import('../src/services/delivery-runner.js');
    const { NetworkPolicyError } = await import('../src/lib/netguard.js');
    const { SecretsError } = await import('../src/lib/secrets.js');
    const { RenderError } = await import('../src/outputs/types.js');
    expect(
      classify(new NetworkPolicyError('169.254.169.254 is a linkLocal address')),
    ).toMatchObject({
      permanent: true,
      errorClass: 'network_policy',
    });
    expect(classify(new SecretsError('A stored secret could not be opened'))).toMatchObject({
      permanent: true,
      errorClass: 'settings',
    });
    expect(classify(new RenderError('Unknown tag'))).toMatchObject({
      permanent: true,
      errorClass: 'template',
    });
    expect(classify(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toMatchObject({
      permanent: false,
      errorClass: 'unreachable',
    });
    expect(classify(new Error('boom'))).toMatchObject({
      permanent: false,
      errorClass: 'internal',
      message: 'Unexpected error',
    });
  });
});
