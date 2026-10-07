import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import {
  buildDocumentModel,
  destinationSettingsSchemas,
  evaluateExpression,
  INCLUDE_ALL,
  reservedValues,
  templateData,
  type Answers,
  type FormDefinition,
} from '@fieldforms/shared';
import { describe, expect, it } from 'vitest';
import { emailAdapter, smtpError } from '../src/destinations/adapters/email.js';
import { createSmtpMailer } from '../src/destinations/mailer.js';
import {
  DEFAULT_ENDPOINTS,
  DeliveryError,
  type AdapterEnv,
  type Contacts,
  type DeliveryContext,
  type Mailer,
} from '../src/destinations/types.js';
import { renderLiquid } from '../src/lib/liquid.js';
import { parseNetworkPolicy } from '../src/lib/netguard.js';
import type { RenderedFile } from '../src/outputs/types.js';
import { classify } from '../src/services/delivery-runner.js';

const def: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  settings: { siteRequired: false },
  fields: [
    { id: 'where', type: 'text', label: 'Where' },
    { id: 'client_email', type: 'text', label: 'Client email' },
    { id: 'other_email', type: 'text', label: 'Other email' },
    { id: 'notes', type: 'text', label: 'Notes', multiline: true },
    {
      id: 'items',
      type: 'group',
      label: 'Items',
      fields: [
        { id: 'name', type: 'text', label: 'Name' },
        { id: 'qty', type: 'number', label: 'Qty' },
      ],
    },
  ],
};

const baseAnswers: Answers = {
  where: 'Bay 3',
  client_email: 'Client@Example.com',
  notes: 'All fine\nsecond line',
  items: [{ name: 'Valve', qty: 2 }],
};

const allContacts: Contacts = {
  submitterEmail: 'sam@acme.test',
  taskSenderEmail: 'tasker@acme.test',
  siteRecipients: ['site@acme.test'],
  siteManagers: ['mgr@acme.test'],
};

interface CtxOptions {
  answers?: Answers;
  contacts?: Partial<Contacts>;
  test?: DeliveryContext['test'];
  files?: RenderedFile[];
  url?: string;
  site?: string;
  liquid?: DeliveryContext['liquid'];
}

function makeCtx(o: CtxOptions = {}): DeliveryContext {
  const id = randomUUID();
  const deliveryId = randomUUID();
  const model = buildDocumentModel(
    def,
    o.answers ?? baseAnswers,
    {
      form: { id: randomUUID(), name: 'Site inspection', version: 2, versionId: randomUUID() },
      submission: {
        id,
        receivedAt: '2026-10-07T08:00:00Z',
        capturedAt: '2026-10-07T07:58:00Z',
        clockSkewFlag: false,
        siteId: randomUUID(),
        site: o.site ?? 'Bay 3',
        region: 'North',
        company: 'Acme',
        submittedBy: 'Sam Supervisor',
        taskTitle: '',
        url: o.url ?? `https://ff.example/submissions/${id}`,
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
    test: o.test ?? null,
    model,
    files: o.files ?? [],
    json: {},
    value: (source) =>
      source.type === 'field'
        ? (model.fields.find((f) => f.id === source.field)?.text ?? null)
        : evaluateExpression(def, model.raw, source.expression, { extras: reservedValues(model) })
            .value,
    liquid: o.liquid ?? ((t, c) => renderLiquid(t, data, c)),
    contacts: {
      submitterEmail: null,
      taskSenderEmail: null,
      siteRecipients: [],
      siteManagers: [],
      ...o.contacts,
    },
    target: null,
    link: model.submission.url,
  };
}

type Sent = Parameters<Mailer['send']>[0];

function recorder(
  reply: () => Promise<{ messageId?: string; response?: string }> = async () => ({
    messageId: '<abc@ff.test>',
    response: '250 2.0.0 Ok: queued as 4F2A1',
  }),
) {
  const sent: Sent[] = [];
  const mailer: Mailer = {
    async send(m) {
      sent.push(m);
      return reply();
    },
  };
  return { sent, mailer };
}

const strict = parseNetworkPolicy({});
function envWith(mailer: Mailer, over: Partial<AdapterEnv> = {}): AdapterEnv {
  return {
    policy: strict,
    vendorPolicy: strict,
    mailer,
    endpoints: DEFAULT_ENDPOINTS,
    signal: new AbortController().signal,
    now: () => new Date(),
    emailAttachmentLimit: 1024 * 1024,
    ...over,
  };
}

const settings = (s: Record<string, unknown>) => destinationSettingsSchemas.email.parse(s);

const file = (name: string, bytes: number): RenderedFile => ({
  filename: name,
  contentType: 'application/pdf',
  data: Buffer.alloc(bytes, 7),
});

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

describe('email recipients', () => {
  it('sends to every source, lower-cased and once each; cc never repeats a recipient', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx({
      answers: {
        ...baseAnswers,
        client_email: 'Client@Example.com; second@example.com',
        other_email: 'FIXED@acme.test',
      },
      contacts: {
        ...allContacts,
        siteRecipients: ['site@acme.test', 'SITE@acme.test'],
        siteManagers: ['mgr@acme.test', 'Sam@Acme.test'],
      },
    });
    const s = settings({
      recipients: {
        addresses: ['Fixed@Acme.test'],
        fields: ['client_email', 'other_email'],
        siteRecipients: true,
        submitter: true,
        taskSender: true,
        siteManagers: true,
      },
      cc: ['boss@acme.test', 'fixed@acme.test', 'Boss@Acme.test'],
    });
    const r = await emailAdapter.deliver(ctx, s, null, envWith(mailer));
    const to = [
      'fixed@acme.test',
      'client@example.com',
      'second@example.com',
      'site@acme.test',
      'sam@acme.test',
      'tasker@acme.test',
      'mgr@acme.test',
    ];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(to);
    expect(sent[0]!.cc).toEqual(['boss@acme.test']);
    expect(r).toMatchObject({
      outcome: 'delivered',
      target: { to, cc: ['boss@acme.test'] },
      evidence: {
        messageId: '<abc@ff.test>',
        response: '250 2.0.0 Ok: queued as 4F2A1',
        attached: false,
        bytes: 0,
      },
    });
  });

  it.each([
    ['fixed addresses', { addresses: ['a@x.test'] }, ['a@x.test']],
    ['form fields', { fields: ['client_email'] }, ['client@example.com']],
    ["the site's report recipients", { siteRecipients: true }, ['site@acme.test']],
    ['the submitter', { submitter: true }, ['sam@acme.test']],
    ["the task's sender", { taskSender: true }, ['tasker@acme.test']],
    ['managers covering the site', { siteManagers: true }, ['mgr@acme.test']],
  ])('uses %s only when switched on', async (_name, recipients, expected) => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(
      makeCtx({ contacts: allContacts }),
      settings({ recipients }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.to).toEqual(expected);
  });

  it('ignores field values and contacts that are not valid addresses', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx({
      answers: {
        ...baseAnswers,
        client_email: 'not an email',
        other_email: 'a@b.test\r\nBcc: evil@x.test, <script>@x.test, ok2@acme.test',
      },
      contacts: { submitterEmail: 'nobody', siteRecipients: ['', 'also wrong'] },
    });
    await emailAdapter.deliver(
      ctx,
      settings({
        recipients: {
          addresses: ['ok@acme.test'],
          fields: ['client_email', 'other_email'],
          submitter: true,
          siteRecipients: true,
        },
      }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.to).toEqual(['ok@acme.test', 'ok2@acme.test']);
    expect(sent[0]!.cc).toBeUndefined();
    expect(sent[0]!.replyTo).toBeUndefined();
  });

  it('skips, without sending, when no source gives an address', async () => {
    const { sent, mailer } = recorder();
    const r = await emailAdapter.deliver(
      makeCtx({ answers: { ...baseAnswers, client_email: '' } }),
      settings({
        recipients: { fields: ['client_email'], submitter: true },
        cc: ['boss@acme.test'],
      }),
      null,
      envWith(mailer),
    );
    expect(r).toMatchObject({ outcome: 'skipped', detail: 'No recipients' });
    expect(sent).toHaveLength(0);
  });
});

describe('email test sends', () => {
  it('go only to the admin running them, with [TEST] in the subject', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx({
      contacts: allContacts,
      test: { tester: { email: 'Admin@Acme.test', name: 'Ada Admin' } },
    });
    const r = await emailAdapter.deliver(
      ctx,
      settings({
        recipients: { addresses: ['ops@acme.test'], siteManagers: true, submitter: true },
        cc: ['boss@acme.test'],
        subject: '{{ _form }} at {{ _site }}',
      }),
      null,
      envWith(mailer),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['admin@acme.test']);
    expect(sent[0]!.cc).toBeUndefined();
    expect(sent[0]!.subject).toBe('[TEST] Site inspection at Bay 3');
    expect(sent[0]!.headers).toMatchObject({ 'X-FieldForms-Test': '1' });
    expect(sent[0]!.html).toContain('Test send');
    expect(r.target).toEqual({ to: ['admin@acme.test'], cc: [] });
  });

  it('are sent even when the real recipients would be none', async () => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(
      makeCtx({
        answers: { ...baseAnswers, client_email: '' },
        test: { tester: { email: 'admin@acme.test', name: 'Ada' } },
      }),
      settings({ recipients: { fields: ['client_email'] } }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.to).toEqual(['admin@acme.test']);
  });

  it('fail permanently when the admin has no email address', async () => {
    const { sent, mailer } = recorder();
    const err = await failure(
      emailAdapter.deliver(
        makeCtx({ test: { tester: { email: null, name: 'Ada' } } }),
        settings({ recipients: { addresses: ['ops@acme.test'] } }),
        null,
        envWith(mailer),
      ),
    );
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
    expect(sent).toHaveLength(0);
  });
});

describe('email content', () => {
  const s = settings({ recipients: { addresses: ['ops@acme.test'] } });

  it('attaches the documents within the size limit', async () => {
    const { sent, mailer } = recorder();
    const files = [file('a.pdf', 300_000), file('b.pdf', 300_000)];
    const r = await emailAdapter.deliver(makeCtx({ files }), s, null, envWith(mailer));
    expect(sent[0]!.attachments.map((a) => a.filename)).toEqual(['a.pdf', 'b.pdf']);
    expect(sent[0]!.attachments[0]!.content).toBe(files[0]!.data);
    expect(sent[0]!.html).not.toContain('too large');
    expect(r.evidence).toMatchObject({ attached: true, bytes: 600_000 });
  });

  it('sends a link instead of documents over the size limit', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx({ files: [file('a.pdf', 700_000), file('b.pdf', 700_000)] });
    const r = await emailAdapter.deliver(ctx, s, null, envWith(mailer));
    expect(sent[0]!.attachments).toEqual([]);
    expect(sent[0]!.html).toContain('too large to attach');
    expect(sent[0]!.html).toContain(`href="${ctx.link}"`);
    expect(sent[0]!.text).toContain('too large to attach');
    expect(sent[0]!.text).toContain(ctx.link);
    expect(r.evidence).toMatchObject({ attached: false, bytes: 1_400_000 });
  });

  it.each([
    ['none', undefined],
    ['submitter', 'sam@acme.test'],
    ['office@acme.test', 'office@acme.test'],
  ])('sets Reply-To for %s', async (replyTo, expected) => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(
      makeCtx({ contacts: allContacts }),
      settings({ recipients: { addresses: ['ops@acme.test'] }, replyTo }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.replyTo).toBe(expected);
  });

  it('leaves Reply-To out when the submitter has no address', async () => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(
      makeCtx({ contacts: { submitterEmail: null } }),
      settings({ recipients: { addresses: ['ops@acme.test'] }, replyTo: 'submitter' }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.replyTo).toBeUndefined();
  });

  it('marks the message with its idempotency key and as automatic', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx();
    await emailAdapter.deliver(ctx, s, null, envWith(mailer));
    expect(sent[0]!.headers).toEqual({
      'X-FieldForms-Delivery': ctx.delivery.idempotencyKey,
      'Auto-Submitted': 'auto-generated',
    });
  });

  it('keeps a CR/LF in an answer out of the subject header', async () => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(
      makeCtx({ answers: { ...baseAnswers, where: 'Bay 3\r\nBcc: evil@x.test' } }),
      settings({ recipients: { addresses: ['ops@acme.test'] }, subject: 'Report {{ where }}' }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.subject).not.toMatch(/[\r\n]/);
    expect(sent[0]!.subject).toBe('Report Bay 3 Bcc: evil@x.test');
    expect(sent[0]!.to).toEqual(['ops@acme.test']);
  });

  it('strips line breaks from the subject even if the template engine leaves them', async () => {
    const { sent, mailer } = recorder();
    const liquid: DeliveryContext['liquid'] = async (_t, c) =>
      c === 'line' ? 'Hello\r\nBcc: evil@x.test X' : 'body';
    await emailAdapter.deliver(makeCtx({ liquid }), s, null, envWith(mailer));
    expect(sent[0]!.subject).toBe('Hello Bcc: evil@x.test X');
  });

  it('escapes hostile answers, site names and rows in the HTML body', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx({
      site: 'Bay <b>3</b>',
      answers: {
        ...baseAnswers,
        where: '"><img src=x onerror=alert(1)>',
        notes: '<script>alert(1)</script>',
        items: [{ name: '<iframe src="https://evil.test">', qty: 1 }],
      },
    });
    await emailAdapter.deliver(
      ctx,
      settings({
        recipients: { addresses: ['ops@acme.test'] },
        message: '<p>Notes: {{ notes }}</p>\nWhere: {{ where }}',
      }),
      null,
      envWith(mailer),
    );
    const html = sent[0]!.html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<b>3</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;iframe src=&quot;https://evil.test&quot;&gt;');
    // The admin's own template markup is kept; its line breaks become <br>.
    expect(html).toContain('<p>Notes: &lt;script&gt;');
    expect(html).toContain('</p><br>\nWhere:');
    // The plain-text alternative carries the same answers, as text.
    expect(sent[0]!.text).toContain('Notes: <script>alert(1)</script>');
    expect(sent[0]!.text).toContain('Items:\n  1. Name: <iframe');
  });

  it('includes the answers table, the link and a text alternative', async () => {
    const { sent, mailer } = recorder();
    const ctx = makeCtx();
    await emailAdapter.deliver(ctx, s, null, envWith(mailer));
    const m = sent[0]!;
    expect(m.subject).toMatch(/^Site inspection: Bay 3 2026-10-07 09:58$/);
    expect(m.html).toContain('Client email');
    expect(m.html).toContain('Client@Example.com');
    expect(m.html).toContain('All fine<br>second line');
    expect(m.html).toContain('>Valve<');
    expect(m.html).toContain(`href="${ctx.link}"`);
    expect(m.text).toContain('Where: Bay 3');
    expect(m.text).toContain('Items:\n  1. Name: Valve; Qty: 2');
    expect(m.text).toContain(`Open in FieldForms: ${ctx.link}`);
  });

  it('leaves the answers out when asked', async () => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(
      makeCtx(),
      settings({ recipients: { addresses: ['ops@acme.test'] }, includeAnswers: false }),
      null,
      envWith(mailer),
    );
    expect(sent[0]!.html).not.toContain('Client email');
    expect(sent[0]!.text).not.toContain('Client email');
  });

  it('does not link to anything but the app', async () => {
    const { sent, mailer } = recorder();
    await emailAdapter.deliver(makeCtx({ url: 'javascript:alert(1)' }), s, null, envWith(mailer));
    expect(sent[0]!.html).not.toContain('javascript:');
  });
});

describe('SMTP failures', () => {
  const s = settings({ recipients: { addresses: ['ops@acme.test'] } });
  const smtp = (props: Record<string, unknown>) =>
    Object.assign(new Error(String(props.message ?? 'SMTP error')), props);

  it.each([
    [
      'a refused recipient',
      {
        code: 'EENVELOPE',
        responseCode: 550,
        response: '550 5.1.1 <ops@acme.test>: Recipient address rejected',
        command: 'RCPT TO',
      },
      { permanent: true, errorClass: 'rejected', status: 550 },
    ],
    [
      'a message too large',
      {
        code: 'EMESSAGE',
        responseCode: 552,
        response: '552 5.3.4 Message too big',
        command: 'DATA',
      },
      { permanent: true, errorClass: 'too_large', status: 552 },
    ],
    [
      'a deferral',
      { code: 'EENVELOPE', responseCode: 451, response: '451 4.7.1 Try again later' },
      { permanent: false, errorClass: 'unreachable', status: 451 },
    ],
    [
      'a refused login',
      { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' },
      { permanent: true, errorClass: 'credentials' },
    ],
    [
      'a refused connection',
      { code: 'ESOCKET', message: 'connect ECONNREFUSED 10.1.2.3:25', command: 'CONN' },
      { permanent: false, errorClass: 'unreachable' },
    ],
    [
      'a closed connection',
      { code: 'ECONNECTION', message: 'Connection closed unexpectedly' },
      { permanent: false, errorClass: 'unreachable' },
    ],
    [
      'a timeout',
      { code: 'ETIMEDOUT', message: 'Greeting never received' },
      { permanent: false, errorClass: 'unreachable' },
    ],
    [
      'a server that will not start TLS',
      { code: 'ETLS', responseCode: 502, response: '502 5.5.1 STARTTLS not supported' },
      { permanent: true, errorClass: 'unreachable' },
    ],
    [
      'a size refused before sending',
      { code: 'EMESSAGE', message: 'Message size larger than allowed 1000' },
      { permanent: true, errorClass: 'too_large' },
    ],
    [
      'anything else',
      { message: 'boom at 10.9.9.9' },
      { permanent: false, errorClass: 'unreachable' },
    ],
  ])('classifies %s', async (_name, props, expected) => {
    const mailer: Mailer = {
      async send() {
        throw smtp(props);
      },
    };
    const err = await failure(emailAdapter.deliver(makeCtx(), s, null, envWith(mailer)));
    expect(err).toMatchObject(expected);
    // What would be stored: never the raw socket message.
    const stored = classify(err);
    expect(`${stored.message} ${stored.detail ?? ''}`).not.toMatch(/10\.\d+\.\d+\.\d+/);
  });

  it('keeps the SMTP reply line in the detail, not the error text', () => {
    const err = smtpError(
      Object.assign(new Error('Message failed: 550 no such user (at 10.0.0.9:25)'), {
        code: 'EENVELOPE',
        responseCode: 550,
        response: '550 5.1.1 no such user\r\nX-Injected: 1',
        command: 'RCPT TO',
      }),
    );
    expect(err.message).toBe('The mail server refused the message (SMTP 550)');
    expect(err.detail).toBe('EENVELOPE RCPT TO 550 5.1.1 no such user X-Injected: 1');
  });

  it('gives up at the deadline without waiting for the mail server', async () => {
    const mailer: Mailer = { send: () => new Promise(() => undefined) };
    const err = await failure(
      emailAdapter.deliver(
        makeCtx(),
        s,
        null,
        envWith(mailer, { signal: AbortSignal.timeout(50) }),
      ),
    );
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
  });

  it('does not start sending after the deadline', async () => {
    const { sent, mailer } = recorder();
    const c = new AbortController();
    c.abort();
    await failure(emailAdapter.deliver(makeCtx(), s, null, envWith(mailer, { signal: c.signal })));
    expect(sent).toHaveLength(0);
  });
});

describe('email check', () => {
  it('says where messages go without sending anything', async () => {
    const r = await emailAdapter.check!(
      settings({ recipients: { fields: ['client_email'], siteManagers: true } }),
      null,
      envWith(recorder().mailer),
    );
    expect(r.ok).toBe(true);
    expect(r.facts?.recipients).toBe('the field client_email, managers covering the site');
    expect(r.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- a real SMTP server

const MAILPIT_SMTP_HOST = process.env.MAILPIT_SMTP_HOST ?? 'localhost';
const MAILPIT_SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);
const MAILPIT_API = process.env.MAILPIT_API ?? 'http://localhost:8025';

async function mailpitUp(): Promise<boolean> {
  const smtpOpen = await new Promise<boolean>((resolve) => {
    const s = connect(MAILPIT_SMTP_PORT, MAILPIT_SMTP_HOST);
    s.setTimeout(1000);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
  if (!smtpOpen) return false;
  try {
    return (await fetch(`${MAILPIT_API}/api/v1/info`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
const mailpit = await mailpitUp();

interface MailpitAddress {
  Address: string;
}
interface MailpitMessage {
  ID: string;
  Subject: string;
  To: MailpitAddress[];
  Cc: MailpitAddress[] | null;
  Bcc: MailpitAddress[] | null;
  ReplyTo: MailpitAddress[] | null;
  HTML: string;
  Text: string;
  Attachments: { FileName: string; ContentType: string; Size: number }[];
}

describe.skipIf(!mailpit)('createSmtpMailer against Mailpit', () => {
  it('sends a real message that arrives as built', async () => {
    const token = randomUUID().replace(/-/g, '');
    const mailer = createSmtpMailer({
      host: MAILPIT_SMTP_HOST,
      port: MAILPIT_SMTP_PORT,
      secure: false,
      requireTLS: false,
      from: 'FieldForms <fieldforms@ff.test>',
    });
    const ctx = makeCtx({
      answers: { ...baseAnswers, where: 'Bay 3\r\nBcc: evil@x.test', notes: '<script>x</script>' },
      files: [file('report.pdf', 2048)],
    });
    const r = await emailAdapter.deliver(
      ctx,
      settings({
        recipients: { addresses: ['ops@acme.test'] },
        cc: ['boss@acme.test'],
        replyTo: 'office@acme.test',
        subject: `Inspection ${token} {{ where }}`,
      }),
      null,
      envWith(mailer),
    );
    expect(r.outcome).toBe('delivered');
    expect(r.evidence.messageId).toMatch(/^<.+>$/);
    expect(r.evidence.response).toMatch(/^250 /);

    let found: { ID: string } | undefined;
    for (let i = 0; i < 50 && !found; i++) {
      const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${token}`);
      found = ((await res.json()) as { messages: { ID: string }[] }).messages[0];
      if (!found) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(found).toBeDefined();
    try {
      const msg = (await (
        await fetch(`${MAILPIT_API}/api/v1/message/${found!.ID}`)
      ).json()) as MailpitMessage;
      expect(msg.Subject).toBe(`Inspection ${token} Bay 3 Bcc: evil@x.test`);
      expect(msg.To.map((a) => a.Address)).toEqual(['ops@acme.test']);
      expect((msg.Cc ?? []).map((a) => a.Address)).toEqual(['boss@acme.test']);
      expect(msg.Bcc ?? []).toEqual([]);
      expect((msg.ReplyTo ?? []).map((a) => a.Address)).toEqual(['office@acme.test']);
      expect(msg.Attachments.map((a) => [a.FileName, a.ContentType])).toEqual([
        ['report.pdf', 'application/pdf'],
      ]);
      expect(msg.HTML).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(msg.Text).toContain('Notes: <script>x</script>');

      const headers = (await (
        await fetch(`${MAILPIT_API}/api/v1/message/${found!.ID}/headers`)
      ).json()) as Record<string, string[]>;
      const header = (name: string) =>
        Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      expect(header('X-FieldForms-Delivery')).toEqual([ctx.delivery.idempotencyKey]);
      expect(header('Bcc')).toBeUndefined();
    } finally {
      await fetch(`${MAILPIT_API}/api/v1/messages`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ IDs: [found!.ID] }),
      });
    }
  });

  it('refuses to send in the clear when STARTTLS is required', async () => {
    const token = randomUUID().replace(/-/g, '');
    const mailer = createSmtpMailer({
      host: MAILPIT_SMTP_HOST,
      port: MAILPIT_SMTP_PORT,
      secure: false,
      requireTLS: true,
      from: 'FieldForms <fieldforms@ff.test>',
    });
    const err = await failure(
      emailAdapter.deliver(
        makeCtx(),
        settings({ recipients: { addresses: ['ops@acme.test'] }, subject: `Plain ${token}` }),
        null,
        envWith(mailer),
      ),
    );
    expect(err.message).toMatch(/TLS/);
    const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${token}`);
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([]);
  });
});
