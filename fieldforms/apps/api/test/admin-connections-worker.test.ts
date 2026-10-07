import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINTS } from '../src/destinations/types.js';
import { runTest, type PipelineDeps } from '../src/services/delivery-runner.js';
import * as documents from '../src/services/documents.js';
import { LOOPBACK } from './fakes/context.js';
import { FakeServer } from './fakes/server.js';
import { startSftpServer, type FakeSftp } from './fakes/sftp-server.js';
import { createTestContext, H, login, type TestContext } from './helpers.js';

/**
 * Checks queued through the admin API, run by the worker's own code (runTest) against local
 * receivers: the secrets the API seals open where the worker expects them, and results come
 * back through GET /api/admin/tests/:id without secrets.
 */

let t: TestContext;
let admin: string;
let deps: PipelineDeps;
let receiver: FakeServer;
let sftp: FakeSftp;
const PASSWORD = 'worker-check-password-5d1c';

function req(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url,
    headers: { ...H, cookie: admin },
    ...(payload !== undefined && { payload: payload as object }),
  });
}

/** Runs the queued test the way the worker's job handler does, and reads the result back. */
async function run(testId: string) {
  expect(t.jobs.some((j) => j.name === 'test' && j.data.testId === testId)).toBe(true);
  const outcome = await runTest(deps, testId);
  const polled = await req('GET', `/api/admin/tests/${testId}`);
  return { outcome, body: polled.body, test: polled.json() };
}

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  receiver = await new FakeServer(() => ({ status: 204 })).start();
  sftp = await startSftpServer({ username: 'fieldforms', password: PASSWORD, home: '/home/ff' });
  deps = {
    db: t.db,
    queue: {
      enqueueRegisterNotify: async () => {},
      enqueueDispatchNotify: async () => {},
      enqueuePlanDeliveries: async () => {},
      enqueueDelivery: async () => {},
      enqueueTest: async () => {},
    },
    blobs: { put: async () => {}, get: async () => null, ensureReady: async () => {} },
    opener: t.opener,
    pdf: t.pdf,
    mailer: {
      send: async () => {
        throw new Error('no mail here');
      },
    },
    publicUrl: 'https://ff.example',
    policy: LOOPBACK,
    vendorPolicy: LOOPBACK,
    endpoints: DEFAULT_ENDPOINTS,
    emailAttachmentLimit: 10 * 1024 * 1024,
    worker: 'test',
    documents,
  };
});
afterAll(async () => {
  await receiver?.close();
  await sftp?.close();
  await t?.close();
});

describe('checks run by the worker', () => {
  it('pings a saved webhook signed with the generated secret, and records the result', async () => {
    const created = await req('POST', '/api/admin/connections', {
      name: 'Local receiver',
      kind: 'webhook',
      secrets: { url: `${receiver.url}/hooks/in?token=tok-9e2b7c41` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, generated } = created.json();
    const check = await req('POST', `/api/admin/connections/${id}/check`, {});
    const { outcome, body, test } = await run(check.json().testId);
    expect(outcome).toBe('ok');
    expect(test).toMatchObject({
      status: 'ok',
      result: { summary: 'The receiver answered HTTP 204', warnings: [] },
    });
    expect(body).not.toContain('tok-9e2b7c41');
    expect(body).not.toContain(generated.signingSecret);

    const ping = receiver.log.at(-1)!;
    expect(ping.path).toBe('/hooks/in');
    const [ts, sig] = String(ping.headers['x-fieldforms-signature'])
      .split(',')
      .map((p) => p.split('=')[1]);
    const expected = createHmac('sha256', generated.signingSecret)
      .update(`${ts}.${ping.body.toString()}`)
      .digest('hex');
    expect(sig).toBe(expected);

    const conn = (await req('GET', `/api/admin/connections/${id}`)).json();
    expect(conn.lastCheck).toMatchObject({ ok: true, detail: 'The receiver answered HTTP 204' });
  });

  it('checks unsaved webhook settings with the secrets sealed to the test row', async () => {
    const r = await req('POST', '/api/admin/connection-checks', {
      kind: 'webhook',
      secrets: { url: `${receiver.url}/draft` },
    });
    const { outcome, test } = await run(r.json().testId);
    expect(outcome).toBe('ok');
    expect(test.result.warnings).toEqual([
      'There is no signing secret, so the receiver cannot check that requests come from FieldForms.',
    ]);
    expect(receiver.log.at(-1)!.path).toBe('/draft');
  });

  it('learns an SFTP host key from an unsaved check, then logs in once it is pinned', async () => {
    const config = { host: '127.0.0.1', port: sftp.port, username: 'fieldforms' };
    const draft = await req('POST', '/api/admin/connection-checks', {
      kind: 'sftp',
      config,
      secrets: { password: PASSWORD },
    });
    expect(draft.statusCode, draft.body).toBe(202);
    const learned = await run(draft.json().testId);
    expect(learned.outcome).toBe('failed');
    expect(learned.test.result.facts).toEqual({ hostKeySha256: sftp.hostKeySha256 });
    expect(learned.body).not.toContain(PASSWORD);
    expect(sftp.sessions).toBe(0);

    const saved = await req('POST', '/api/admin/connections', {
      name: 'Local SFTP',
      kind: 'sftp',
      config: { ...config, hostKeySha256: sftp.hostKeySha256 },
      secrets: { password: PASSWORD },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    const ok = await run(
      (await req('POST', `/api/admin/connections/${id}/check`, {})).json().testId,
    );
    expect(ok.outcome).toBe('ok');
    expect(ok.body).not.toContain(PASSWORD);

    // Pointed elsewhere: the password was cleared, so nothing can be sent to the new place.
    const moved = await req('PATCH', `/api/admin/connections/${id}`, {
      config: { ...config, username: 'someone-else', hostKeySha256: sftp.hostKeySha256 },
    });
    expect(moved.json()).toEqual({ secretsReset: true });
    const sessions = sftp.sessions;
    const after = await run(
      (await req('POST', `/api/admin/connections/${id}/check`, {})).json().testId,
    );
    expect(after.outcome).toBe('failed');
    expect(after.body).not.toContain(PASSWORD);
    expect(sftp.sessions).toBe(sessions);
  });

  it('test-sends a destination saved through the API, marked as a test', async () => {
    const conn = (
      await req('POST', '/api/admin/connections', {
        name: 'Test-send receiver',
        kind: 'webhook',
        secrets: { url: `${receiver.url}/submissions` },
      })
    ).json().id;
    const formId = (await req('POST', '/api/admin/forms', { name: 'Gate log' })).json().id;
    await req('POST', `/api/admin/forms/${formId}/publish`, {});
    const d = await req('POST', `/api/admin/forms/${formId}/destinations`, {
      name: 'Gate hook',
      kind: 'webhook',
      connectionId: conn,
      formats: ['json'],
      condition: 'notes != "skip"',
      settings: { includeFiles: true },
    });
    expect(d.statusCode, d.body).toBe(201);
    const sent = await req('POST', `/api/admin/destinations/${d.json().id}/test`, {});
    const { outcome, test } = await run(sent.json().testId);
    expect(outcome, JSON.stringify(test.result)).toBe('ok');
    expect(test.result.summary).toBe('Test sent');
    const hit = receiver.log.at(-1)!;
    expect(hit.path).toBe('/submissions');
    expect(hit.headers['x-fieldforms-test']).toBe('1');
    expect(JSON.parse(hit.body.toString())).toMatchObject({ files: [expect.anything()] });
  });
});
