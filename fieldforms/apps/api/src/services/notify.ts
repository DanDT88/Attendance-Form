import { formatLocal } from '@fieldforms/shared';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../lib/blobstore.js';

export interface Mailer {
  send(msg: { to: string[]; subject: string; html: string; attachments: { filename: string; content: Buffer; contentType: string }[] }): Promise<void>;
}

export interface PdfRenderer {
  /** Returns null when no renderer is configured or it is unavailable. */
  htmlToPdf(html: string): Promise<Buffer | null>;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATUS_COLOUR: Record<string, string> = { present: '#2f855a', late: '#c05621', absent: '#c53030', left_early: '#2b6cb0' };

/** The summary email and PDF for a start or end register, as the legacy app sent them. */
export async function renderRegisterSummary(db: Db, blobs: BlobStore, submissionId: string, embedPhotos: boolean) {
  const r = await db
    .selectFrom('register_submissions as r')
    .innerJoin('sites as s', 's.id', 'r.site_id')
    .innerJoin('regions as rg', 'rg.id', 's.region_id')
    .innerJoin('companies as c', 'c.id', 'rg.company_id')
    .leftJoin('shifts as sh', 'sh.id', 'r.shift_id')
    .leftJoin('users as u', 'u.id', 'r.submitted_by')
    .select([
      'r.id',
      'r.kind',
      'r.work_date',
      'r.sign_off_name',
      'r.device_captured_at',
      'r.server_received_at',
      'r.geo_ok',
      'r.time_ok',
      'r.clock_skew_flag',
      'r.supervisor_photo_id',
      'r.staff_photo_id',
      's.name as site',
      's.report_recipients as site_recipients',
      'rg.name as region',
      'c.name as company',
      'c.report_recipients as company_recipients',
      'sh.name as shift',
      'u.display_name as supervisor',
    ])
    .where('r.id', '=', submissionId)
    .executeTakeFirst();
  if (!r) return null;

  const entries = await db
    .selectFrom('attendance_entries as e')
    .innerJoin('employees as emp', 'emp.id', 'e.employee_id')
    .leftJoin('employees as rep', 'rep.id', 'e.replacement_employee_id')
    .select([
      'e.status',
      'e.event_at',
      'e.minutes',
      'e.reason',
      sql<string>`emp.first_name || ' ' || emp.last_name`.as('name'),
      sql<string | null>`rep.first_name || ' ' || rep.last_name`.as('replacement'),
    ])
    .where('e.submission_id', '=', submissionId)
    .orderBy('emp.last_name')
    .execute();

  const recipients = (r.site_recipients?.length ? r.site_recipients : r.company_recipients) ?? [];
  const title = r.kind === 'end' ? 'End of shift' : 'Attendance register';

  const detail = (e: (typeof entries)[number]) => {
    const parts: string[] = [];
    if (e.status === 'late' && e.minutes !== null) parts.push(`${e.minutes} min late`);
    if (e.status === 'left_early' && e.event_at) parts.push(`left ${formatLocal(e.event_at, 'HH:mm')}${e.minutes ? ` (${e.minutes} min early)` : ''}`);
    if (e.reason) parts.push(e.reason);
    return parts.join(' · ');
  };

  const photos: string[] = [];
  if (embedPhotos) {
    for (const id of [r.supervisor_photo_id, r.staff_photo_id]) {
      if (!id) continue;
      const meta = await db.selectFrom('blobs').select(['storage_key', 'content_type']).where('id', '=', id).executeTakeFirst();
      const data = meta && (await blobs.get(meta.storage_key));
      if (meta && data) photos.push(`<img src="data:${meta.content_type};base64,${data.toString('base64')}" style="width:260px;border-radius:6px;margin:6px">`);
    }
  }

  const flags = [
    r.geo_ok === false ? 'Captured away from the site' : null,
    r.time_ok === false ? 'Captured outside the shift time window' : null,
    r.clock_skew_flag ? 'Device clock differed from server time' : null,
  ].filter(Boolean);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;color:#1a202c;margin:0">
<div style="max-width:720px;margin:0 auto;border:1px solid #e2e8f0">
  <div style="background:#1B365D;color:#fff;padding:18px 20px">
    <h2 style="margin:0">${esc(title)}</h2>
    <div>${esc(r.company)} · ${esc(r.region)} · ${esc(r.site)} · ${esc(r.work_date)}${r.shift ? ` · ${esc(r.shift)} shift` : ''}</div>
  </div>
  <div style="padding:16px 20px">
    <p>Supervisor: <b>${esc(r.supervisor)}</b>${r.sign_off_name ? ` · Sign-off: ${esc(r.sign_off_name)}` : ''}<br>
    Captured ${r.device_captured_at ? esc(formatLocal(r.device_captured_at)) : '—'} · Received ${esc(formatLocal(r.server_received_at))} (SAST)</p>
    ${flags.length ? `<p style="color:#c05621"><b>Flags:</b> ${flags.map(esc).join('; ')}</p>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f7fafc;text-align:left"><th style="padding:8px">Employee</th><th style="padding:8px">Status</th><th style="padding:8px">Detail</th><th style="padding:8px">Replacement</th></tr></thead>
      <tbody>${entries
        .map(
          (e) => `<tr style="border-top:1px solid #edf2f7"><td style="padding:8px">${esc(e.name)}</td>
          <td style="padding:8px;color:${STATUS_COLOUR[e.status] ?? '#1a202c'}"><b>${esc(e.status.replace('_', ' ').toUpperCase())}</b></td>
          <td style="padding:8px">${esc(detail(e))}</td><td style="padding:8px">${esc(e.replacement ?? '')}</td></tr>`,
        )
        .join('')}</tbody>
    </table>
    ${photos.length ? `<div style="text-align:center;margin-top:16px">${photos.join('')}</div>` : ''}
  </div>
</div></body></html>`;

  return {
    recipients,
    subject: `${title}: ${r.site} (${r.work_date})`,
    filename: `${title.replace(/\s+/g, '_')}_${r.site}_${r.work_date}`.replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf',
    html,
  };
}

/**
 * Sends the summary for one register exactly once. Throwing makes pg-boss retry with backoff and,
 * after the last retry, move the job to the dead-letter queue.
 */
export async function deliverRegisterSummary(
  db: Db,
  blobs: BlobStore,
  mailer: Mailer,
  pdf: PdfRenderer,
  submissionId: string,
): Promise<'sent' | 'skipped' | 'already-sent'> {
  const done = await db
    .selectFrom('notification_log')
    .select('status')
    .where('submission_id', '=', submissionId)
    .where('status', 'in', ['sent', 'skipped'])
    .executeTakeFirst();
  if (done) return 'already-sent';

  const email = await renderRegisterSummary(db, blobs, submissionId, false);
  if (!email) return 'skipped';
  if (!email.recipients.length) {
    await db.insertInto('notification_log').values({ submission_id: submissionId, status: 'skipped', detail: 'No report recipients configured' }).execute();
    return 'skipped';
  }

  const withPhotos = await renderRegisterSummary(db, blobs, submissionId, true);
  let attachment: Buffer | null = null;
  let detail: string | null = null;
  try {
    attachment = await pdf.htmlToPdf(withPhotos!.html);
    if (!attachment) detail = 'PDF renderer not configured; sent without PDF';
  } catch (err) {
    detail = `PDF failed (${(err as Error).message}); sent without PDF`;
  }

  try {
    await mailer.send({
      to: email.recipients,
      subject: email.subject,
      html: email.html,
      attachments: attachment ? [{ filename: email.filename, content: attachment, contentType: 'application/pdf' }] : [],
    });
  } catch (err) {
    await db
      .insertInto('notification_log')
      .values({ submission_id: submissionId, status: 'failed', recipients: email.recipients, detail: (err as Error).message.slice(0, 500) })
      .execute();
    throw err;
  }
  await db
    .insertInto('notification_log')
    .values({ submission_id: submissionId, status: 'sent', recipients: email.recipients, detail })
    // A concurrent delivery already recorded it; the unique index keeps one 'sent' row.
    .onConflict((oc) => oc.doNothing())
    .execute();
  return 'sent';
}

/** Start and end registers from the app in the last week that have no delivery outcome yet. */
export async function findUndelivered(db: Db): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT r.id FROM register_submissions r
    WHERE r.kind IN ('start', 'end') AND r.source = 'app'
      AND r.server_received_at > now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.submission_id = r.id AND n.status IN ('sent', 'skipped'))
    LIMIT 500
  `.execute(db);
  return rows.rows.map((r) => r.id);
}

export function gotenbergRenderer(baseUrl: string | undefined): PdfRenderer {
  return {
    async htmlToPdf(html) {
      if (!baseUrl) return null;
      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/forms/chromium/convert/html`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Gotenberg ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
