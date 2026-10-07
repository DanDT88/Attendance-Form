import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalBlobStore } from '../src/lib/blobstore.js';
import { deliverRegisterSummary, findUndelivered, type Mailer } from '../src/services/notify.js';
import { createTestContext, H, login, startRegister, type TestContext } from './helpers.js';

let t: TestContext;
let sup: string;
const blobs = new LocalBlobStore('/nonexistent-not-used');
const noPdf = { htmlToPdf: async () => null };

beforeAll(async () => {
  t = await createTestContext();
  sup = await login(t.app, 'S001');
});
afterAll(async () => t?.close());

async function submit(over: Record<string, unknown> = {}) {
  const body = startRegister(t.fx, { id: randomUUID(), ...over });
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/registers',
    headers: { ...H, cookie: sup },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return body.id;
}

function recordingMailer(fail = false) {
  const sent: Parameters<Mailer['send']>[0][] = [];
  const mailer: Mailer = {
    async send(msg) {
      if (fail) throw new Error('SMTP down');
      sent.push(msg);
    },
  };
  return { sent, mailer };
}

describe('register summary email', () => {
  it('emails the company recipients once, with escaped content', async () => {
    const id = await submit({ signOffName: '<script>x</script>' });
    const m = recordingMailer();
    expect(await deliverRegisterSummary(t.db, blobs, m.mailer, noPdf, id)).toBe('sent');
    expect(await deliverRegisterSummary(t.db, blobs, m.mailer, noPdf, id)).toBe('already-sent');
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.to).toEqual(['ops@acme.test']);
    expect(m.sent[0]!.subject).toBe('Attendance register: Site A (2026-10-05)');
    expect(m.sent[0]!.html).toContain('&lt;script&gt;');
    expect(m.sent[0]!.html).not.toContain('<script>x');
    expect(m.sent[0]!.html).toContain('Thandi Mokoena');
  });

  it('records a failure and rethrows so the queue retries; the sweeper finds it again', async () => {
    const id = await submit();
    await expect(
      deliverRegisterSummary(t.db, blobs, recordingMailer(true).mailer, noPdf, id),
    ).rejects.toThrow('SMTP down');
    const log = await t.owner
      .selectFrom('notification_log')
      .selectAll()
      .where('submission_id', '=', id)
      .execute();
    expect(log).toEqual([expect.objectContaining({ status: 'failed', detail: 'SMTP down' })]);
    expect(await findUndelivered(t.db)).toContain(id);

    const ok = recordingMailer();
    expect(await deliverRegisterSummary(t.db, blobs, ok.mailer, noPdf, id)).toBe('sent');
    expect(await findUndelivered(t.db)).not.toContain(id);
  });

  it('still sends when the PDF renderer fails, and says so in the log', async () => {
    const id = await submit();
    const m = recordingMailer();
    const broken = {
      htmlToPdf: async () => {
        throw new Error('renderer down');
      },
    };
    expect(await deliverRegisterSummary(t.db, blobs, m.mailer, broken, id)).toBe('sent');
    expect(m.sent[0]!.attachments).toEqual([]);
    const log = await t.owner
      .selectFrom('notification_log')
      .select('detail')
      .where('submission_id', '=', id)
      .where('status', '=', 'sent')
      .executeTakeFirstOrThrow();
    expect(log.detail).toMatch(/renderer down/);
  });

  it('attaches the PDF when one is rendered', async () => {
    const id = await submit();
    const m = recordingMailer();
    const pdf = { htmlToPdf: async () => Buffer.from('%PDF-1.4 fake') };
    await deliverRegisterSummary(t.db, blobs, m.mailer, pdf, id);
    expect(m.sent[0]!.attachments[0]).toMatchObject({
      contentType: 'application/pdf',
      filename: 'Attendance_register_Site_A_2026-10-05.pdf',
    });
  });

  it('skips and records registers with no recipients', async () => {
    await t.owner.updateTable('companies').set({ report_recipients: [] }).execute();
    const id = await submit();
    const m = recordingMailer();
    expect(await deliverRegisterSummary(t.db, blobs, m.mailer, noPdf, id)).toBe('skipped');
    expect(m.sent).toHaveLength(0);
    expect(await findUndelivered(t.db)).not.toContain(id);
  });
});
