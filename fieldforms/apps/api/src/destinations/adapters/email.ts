import type { DestinationSettings, DocField } from '@fieldforms/shared';
import { z } from 'zod';
import {
  DeliveryError,
  redact,
  type AdapterEnv,
  type DeliveryContext,
  type DestinationAdapter,
} from '../types.js';

/**
 * Email destination: sends the submission (answers in the body, documents attached) through the
 * server's SMTP settings, so it needs no connection.
 *
 * Recipients come from fixed addresses, form fields and the people around the submission (the
 * site's report recipients, the submitter, the task's sender, managers covering the site); every
 * address is lower-cased, validated and sent to once. A test send goes only to the admin running
 * it. Everything a submission or template supplies is escaped for where it lands: one line for
 * the subject (a CR/LF in an answer cannot add a header) and HTML for the body.
 */
type Settings = DestinationSettings<'email'>;

const emailAddress = z.string().email().max(200);

/** A trimmed, lower-cased, valid address, or null. */
export function cleanAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const a = raw.trim().toLowerCase();
  return emailAddress.safeParse(a).success ? a : null;
}

/** A field may hold a few addresses separated by commas or semicolons; the rest is ignored. */
const MAX_PER_FIELD = 10;
function addressesIn(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : [];
  return parts
    .map(cleanAddress)
    .filter((a): a is string => a !== null)
    .slice(0, MAX_PER_FIELD);
}

/** Who a real (not test) send goes to, de-duplicated; cc never repeats a "to" address. */
export function resolveRecipients(
  ctx: DeliveryContext,
  s: Settings,
): { to: string[]; cc: string[] } {
  const r = s.recipients;
  const to = new Set<string>();
  const add = (values: Iterable<unknown>) => {
    for (const v of values) {
      const a = cleanAddress(v);
      if (a) to.add(a);
    }
  };
  add(r.addresses);
  for (const field of r.fields) add(addressesIn(ctx.value({ type: 'field', field })));
  if (r.siteRecipients) add(ctx.contacts.siteRecipients);
  if (r.submitter) add([ctx.contacts.submitterEmail]);
  if (r.taskSender) add([ctx.contacts.taskSenderEmail]);
  if (r.siteManagers) add(ctx.contacts.siteManagers);
  const cc = new Set<string>();
  for (const v of s.cc) {
    const a = cleanAddress(v);
    if (a && !to.has(a)) cc.add(a);
  }
  return { to: [...to], cc: [...cc] };
}

function replyTo(ctx: DeliveryContext, s: Settings): string | undefined {
  if (s.replyTo === 'none') return undefined;
  if (s.replyTo === 'submitter') return cleanAddress(ctx.contacts.submitterEmail) ?? undefined;
  return cleanAddress(s.replyTo) ?? undefined;
}

// ---------------------------------------------------------------- text helpers

// eslint-disable-next-line no-control-regex
const LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** One header line: no CR, LF or other control characters, whatever the template engine did. */
const oneLine = (s: string) => s.replace(LINE_BREAKERS, ' ').trim();
// eslint-disable-next-line no-control-regex
const noControl = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const escLines = (s: string) => esc(s).replace(/\r\n|\r|\n/g, '<br>');
const BRAND_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const isWebLink = (s: string) => /^https?:\/\//i.test(s);
const megabytes = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

const TH =
  'padding:6px 8px;text-align:left;vertical-align:top;background:#f7fafc;font-weight:600;width:35%;border-top:1px solid #edf2f7';
const TD = 'padding:6px 8px;vertical-align:top;border-top:1px solid #edf2f7';

function groupHtml(f: DocField): string {
  const rows = f.rows ?? [];
  if (!rows.length) return '';
  const heads = rows[0]!.map((c) => `<th style="${TH};width:auto">${esc(c.label)}</th>`).join('');
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells.map((c) => `<td style="${TD}">${escLines(c.text)}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The answers as a label/answer table (a nested table per repeat group); all text escaped. */
export function answersHtml(fields: DocField[]): string {
  const rows = fields.map((f) =>
    f.type === 'group'
      ? `<tr><th style="${TH}">${esc(f.label)}</th><td style="${TD}">${groupHtml(f)}</td></tr>`
      : `<tr><th style="${TH}">${esc(f.label)}</th><td style="${TD}">${escLines(f.text)}</td></tr>`,
  );
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows.join('')}</table>`;
}

export function answersText(fields: DocField[]): string {
  const lines: string[] = [];
  const indent = (s: string, pad: string) => s.replace(/\r\n|\r|\n/g, `\n${pad}`);
  for (const f of fields) {
    if (f.type === 'group') {
      lines.push(`${f.label}:`);
      (f.rows ?? []).forEach((cells, i) =>
        lines.push(
          `  ${i + 1}. ${cells.map((c) => `${c.label}: ${indent(c.text, '     ')}`).join('; ')}`,
        ),
      );
    } else {
      lines.push(`${f.label}: ${indent(f.text, '  ')}`);
    }
  }
  return noControl(lines.join('\n'));
}

// ---------------------------------------------------------------- SMTP errors

const CONNECTION_CODES = new Set(['ECONNECTION', 'ESOCKET', 'EDNS', 'EPROTOCOL', 'ESTREAM']);

/** The server's reply line, without control characters and capped (never a body). */
function replyLine(r: unknown): string | null {
  return typeof r === 'string' ? oneLine(r).slice(0, 200) || null : null;
}

/**
 * Classifies a mailer failure. SMTP 5xx (and a refused login) will not get better by retrying;
 * 4xx, timeouts and connection problems will. The detail holds the error code, the SMTP command
 * and the server's reply line, never the raw socket error (it names internal hosts).
 */
export function smtpError(err: unknown): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const e = (err ?? {}) as Record<string, unknown>;
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.responseCode === 'number' ? e.responseCode : 0;
  const command = typeof e.command === 'string' ? e.command : '';
  const detail =
    redact([code, command, replyLine(e.response)].filter(Boolean).join(' ')) || undefined;
  const fail = (message: string, permanent: boolean, errorClass: DeliveryError['errorClass']) =>
    new DeliveryError(message, { permanent, errorClass, detail, status: status || undefined });

  if (code === 'EAUTH') return fail('SMTP authentication failed', true, 'credentials');
  if (code === 'ETLS')
    return status >= 500
      ? fail('The mail server would not start TLS', true, 'unreachable')
      : fail('Could not start TLS with the mail server', false, 'unreachable');
  if (status === 552)
    return fail('The mail server refused the message as too large (SMTP 552)', true, 'too_large');
  if (status >= 500 && status < 600)
    return fail(`The mail server refused the message (SMTP ${status})`, true, 'rejected');
  if (status >= 400 && status < 500)
    return fail(`The mail server deferred the message (SMTP ${status})`, false, 'unreachable');
  // nodemailer refuses a message over the size the server announced, before sending it.
  if (code === 'EMESSAGE' && /size/i.test(String(e.message ?? '')))
    return fail('The message is larger than the mail server accepts', true, 'too_large');
  if (code === 'EENVELOPE' || code === 'EMESSAGE')
    return fail('The mail server refused the message', true, 'rejected');
  if (code === 'ETIMEDOUT' || e.name === 'TimeoutError' || e.name === 'AbortError')
    return fail('The mail server timed out', false, 'unreachable');
  if (CONNECTION_CODES.has(code))
    return fail('Could not reach the mail server', false, 'unreachable');
  return fail('Sending the email failed', false, 'unreachable');
}

/**
 * Runs the send, giving up when the attempt's deadline passes. The SMTP timeouts normally end a
 * stalled send first; if the deadline wins, the message may still go out, and a retry would send
 * it again (the X-FieldForms-Delivery header lets a reader tell the two apart).
 */
function beforeDeadline<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  const timedOut = () =>
    new DeliveryError('The mail server timed out', { permanent: false, errorClass: 'unreachable' });
  if (signal.aborted) return Promise.reject(timedOut());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    signal.addEventListener('abort', onAbort, { once: true });
    send()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// ---------------------------------------------------------------- the message

interface Body {
  subject: string;
  messageHtml: string;
  messageText: string;
  includeAnswers: boolean;
  tooLarge: number | null;
}

function htmlBody(ctx: DeliveryContext, b: Body): string {
  const m = ctx.model;
  const colour = BRAND_COLOUR.test(m.branding.colour) ? m.branding.colour : '#1B365D';
  const meta = [
    m.submission.site,
    m.submission.capturedLocal ? `${m.submission.capturedLocal} (SAST)` : '',
    m.submission.submittedBy ? `by ${m.submission.submittedBy}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const link = isWebLink(ctx.link) ? ctx.link : '';
  const banner = ctx.test
    ? `<div style="background:#fefcbf;color:#744210;padding:10px 20px"><b>Test send</b>: only you received this.${
        m.submission.sample ? ' The answers are a generated sample.' : ''
      }</div>`
    : '';
  const tooLarge =
    b.tooLarge === null
      ? ''
      : `<p style="margin:16px 0 0;color:#744210">The documents (${megabytes(b.tooLarge)}) are too large to attach.${
          link
            ? ` <a href="${esc(link)}">Open the submission in FieldForms</a> to download them.`
            : ''
        }</p>`;
  const button = link
    ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="background:${colour};color:#fff;padding:10px 16px;border-radius:4px;text-decoration:none;display:inline-block">Open in FieldForms</a></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(b.subject)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;color:#1a202c;margin:0">
<div style="max-width:720px;margin:0 auto;border:1px solid #e2e8f0">
${banner}<div style="background:${colour};color:#fff;padding:18px 20px">
<h2 style="margin:0">${esc(m.form.name)}</h2>${meta ? `<div>${esc(meta)}</div>` : ''}
</div>
<div style="padding:16px 20px">
${b.messageHtml ? `<div style="margin:0 0 16px">${b.messageHtml}</div>` : ''}${
    b.includeAnswers ? answersHtml(m.fields) : ''
  }${tooLarge}${button}
</div>
</div></body></html>`;
}

function textBody(ctx: DeliveryContext, b: Body): string {
  const m = ctx.model;
  const link = isWebLink(ctx.link) ? ctx.link : '';
  const parts = [
    ctx.test
      ? `TEST SEND: only you received this.${m.submission.sample ? ' The answers are a generated sample.' : ''}`
      : '',
    b.messageText.trim(),
    [
      m.form.name,
      [m.submission.site, m.submission.capturedLocal ? `${m.submission.capturedLocal} (SAST)` : '']
        .filter(Boolean)
        .join(' · '),
      m.submission.submittedBy ? `Submitted by ${m.submission.submittedBy}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    b.includeAnswers ? answersText(m.fields) : '',
    b.tooLarge === null
      ? ''
      : `The documents (${megabytes(b.tooLarge)}) are too large to attach.${
          link ? ` Open the submission in FieldForms to download them: ${link}` : ''
        }`,
    link && b.tooLarge === null ? `Open in FieldForms: ${link}` : '',
  ];
  return noControl(parts.filter(Boolean).join('\n\n'));
}

export const emailAdapter: DestinationAdapter<Settings> = {
  kind: 'email',

  async deliver(ctx, s, _conn, env: AdapterEnv) {
    let { to, cc } = resolveRecipients(ctx, s);
    if (ctx.test) {
      const tester = cleanAddress(ctx.test.tester.email);
      if (!tester)
        throw new DeliveryError('Your account has no email address to send the test to', {
          permanent: true,
          errorClass: 'settings',
        });
      to = [tester];
      cc = [];
    } else if (!to.length) {
      return { outcome: 'skipped', detail: 'No recipients', target: { to, cc }, evidence: {} };
    }

    const line = oneLine(await ctx.liquid(s.subject, 'line')).slice(0, 250);
    const subject = `${ctx.test ? '[TEST] ' : ''}${line || oneLine(ctx.model.form.name)}`;
    const message = s.message.trim();
    const bytes = ctx.files.reduce((n, f) => n + f.data.length, 0);
    const attached = ctx.files.length > 0 && bytes <= env.emailAttachmentLimit;
    const body: Body = {
      subject,
      messageHtml: message
        ? (await ctx.liquid(message, 'html')).trim().replace(/\r\n|\r|\n/g, '<br>\n')
        : '',
      messageText: message ? await ctx.liquid(message, 'text') : '',
      includeAnswers: s.includeAnswers,
      tooLarge: ctx.files.length > 0 && !attached ? bytes : null,
    };

    const headers: Record<string, string> = {
      'X-FieldForms-Delivery': ctx.delivery.idempotencyKey,
      // RFC 3834: out-of-office replies should not answer an automatic message.
      'Auto-Submitted': 'auto-generated',
    };
    if (ctx.test) headers['X-FieldForms-Test'] = '1';

    let info: { messageId?: string; response?: string };
    try {
      info = await beforeDeadline(env.signal, () =>
        env.mailer.send({
          to,
          cc: cc.length ? cc : undefined,
          replyTo: replyTo(ctx, s),
          subject,
          html: htmlBody(ctx, body),
          text: textBody(ctx, body),
          attachments: attached
            ? ctx.files.map((f) => ({
                filename: f.filename,
                content: f.data,
                contentType: f.contentType,
              }))
            : [],
          headers,
        }),
      );
    } catch (err) {
      throw smtpError(err);
    }
    return {
      outcome: 'delivered',
      target: { to, cc },
      evidence: {
        messageId: typeof info.messageId === 'string' ? info.messageId.slice(0, 300) : null,
        response: replyLine(info.response),
        attached,
        bytes,
      },
    };
  },

  /** Nothing to connect to (the server's SMTP settings): says where messages will go. */
  async check(s) {
    const r = s.recipients;
    const sources = [
      r.addresses.length
        ? `${r.addresses.length} fixed address${r.addresses.length === 1 ? '' : 'es'}`
        : '',
      r.fields.length ? `the field${r.fields.length === 1 ? '' : 's'} ${r.fields.join(', ')}` : '',
      r.siteRecipients ? "the site's report recipients" : '',
      r.submitter ? 'the submitter' : '',
      r.taskSender ? "the task's sender" : '',
      r.siteManagers ? 'managers covering the site' : '',
    ].filter(Boolean);
    const warnings =
      r.addresses.length === 0
        ? ['There is no fixed address: a submission whose sources give no address is skipped.']
        : [];
    return {
      ok: true,
      summary: "Email goes out through the server's mail settings",
      facts: { recipients: sources.join(', ') },
      warnings,
    };
  },
};
