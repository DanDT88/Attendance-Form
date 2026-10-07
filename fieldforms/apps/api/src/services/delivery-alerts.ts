import { ERROR_CLASSES, type ErrorClass } from '@fieldforms/shared';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { Mailer } from '../destinations/types.js';
import { MAX_SWEEP_FAILURES } from './notify.js';
import { getSettings } from './settings.js';

/**
 * Failure alerts, sent as one email per incident rather than one per delivery (ARCHITECTURE.md,
 * "Incidents and alerts"): the first failure of a destination's run of failures, a reminder each
 * day while it lasts, a note when it recovers, Phase 1/2 system emails that gave up, and
 * connection secrets about to expire. Each alert is recorded in delivery_alerts. If the mail
 * server is down the job throws and runs again next time, with nothing marked as sent.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

async function alertRecipients(db: Db): Promise<string[]> {
  const settings = await getSettings(db);
  if (settings.deliveryAlertEmails.length) return settings.deliveryAlertEmails;
  const admins = await db
    .selectFrom('users')
    .select('email')
    .where('role', '=', 'admin')
    .where('active', '=', true)
    .where('email', 'is not', null)
    .execute();
  return [...new Set(admins.map((a) => a.email!.toLowerCase()))];
}

function page(title: string, body: string, link: string): string {
  return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1a202c">
<h2 style="margin:0 0 12px">${esc(title)}</h2>${body}
<p><a href="${esc(link)}">Open the deliveries page</a></p>
<p style="color:#718096;font-size:12px">FieldForms sends one alert per incident, a reminder each day while it lasts, and a note when it recovers.</p>
</body></html>`;
}

export async function runAlerts(
  db: Db,
  mailer: Mailer,
  publicUrl: string,
): Promise<{ sent: number; recipients: number }> {
  const recipients = await alertRecipients(db);
  // Nobody to tell: leave everything unmarked, so alerts go out once someone is configured.
  if (!recipients.length) return { sent: 0, recipients: 0 };
  let sent = 0;
  const send = async (
    kind: 'incident' | 'reminder' | 'recovered' | 'system_email' | 'secret_expiry',
    subject: string,
    html: string,
    ref: { destinationId?: string; connectionId?: string; items: Record<string, unknown> },
  ) => {
    await mailer.send({ to: recipients, subject, html, attachments: [] });
    await db
      .insertInto('delivery_alerts')
      .values({
        kind,
        destination_id: ref.destinationId ?? null,
        connection_id: ref.connectionId ?? null,
        recipients,
        items: JSON.stringify(ref.items),
      })
      .execute();
    sent++;
  };

  // Destinations failing now, recovered, or still failing a day after the last alert.
  const destinations = await db
    .selectFrom('destinations as d')
    .innerJoin('forms as f', 'f.id', 'd.form_id')
    .select([
      'd.id',
      'd.name',
      'd.kind',
      'd.failing_since',
      'd.consecutive_failures',
      'd.incident_alerted_at',
      'f.name as form_name',
      sql<Date | null>`(SELECT max(a.sent_at) FROM delivery_alerts a WHERE a.destination_id = d.id
        AND a.kind IN ('incident', 'reminder'))`.as('last_alert_at'),
      sql<{ last_error: string | null; last_error_class: string | null } | null>`(
        SELECT json_build_object('last_error', dl.last_error, 'last_error_class', dl.last_error_class)
        FROM deliveries dl WHERE dl.destination_id = d.id AND dl.status = 'failed'
        ORDER BY dl.updated_at DESC LIMIT 1)`.as('last_failure'),
      sql<number>`(SELECT count(*)::int FROM deliveries dl WHERE dl.destination_id = d.id
        AND dl.status = 'failed')`.as('failed_count'),
    ])
    .where((eb) =>
      eb.or([eb('d.failing_since', 'is not', null), eb('d.incident_alerted_at', 'is not', null)]),
    )
    .execute();
  const link = `${publicUrl}/deliveries`;
  for (const d of destinations) {
    const errorText = d.last_failure?.last_error_class
      ? (ERROR_CLASSES[d.last_failure.last_error_class as ErrorClass] ?? d.last_failure.last_error)
      : (d.last_failure?.last_error ?? 'Unknown error');
    const facts = `<p><b>${esc(d.form_name)}</b> → <b>${esc(d.name)}</b> (${esc(d.kind)})</p>
<p>${esc(d.failed_count)} failed deliver${d.failed_count === 1 ? 'y' : 'ies'} waiting; last error: ${esc(errorText)}</p>`;
    if (d.failing_since && !d.incident_alerted_at) {
      await send(
        'incident',
        `Deliveries failing: ${d.form_name} → ${d.name}`,
        page('Deliveries are failing', facts, link),
        {
          destinationId: d.id,
          items: { failingSince: d.failing_since, failed: d.failed_count },
        },
      );
      await db
        .updateTable('destinations')
        .set({ incident_alerted_at: sql`now()` })
        .where('id', '=', d.id)
        .execute();
    } else if (
      d.failing_since &&
      d.incident_alerted_at &&
      (!d.last_alert_at || d.last_alert_at.getTime() < Date.now() - 24 * 3_600_000)
    ) {
      await send(
        'reminder',
        `Still failing: ${d.form_name} → ${d.name}`,
        page('Deliveries are still failing', facts, link),
        {
          destinationId: d.id,
          items: { failingSince: d.failing_since, failed: d.failed_count },
        },
      );
    } else if (!d.failing_since && d.incident_alerted_at) {
      await send(
        'recovered',
        `Recovered: ${d.form_name} → ${d.name}`,
        page(
          'Deliveries are working again',
          `<p><b>${esc(d.form_name)}</b> → <b>${esc(d.name)}</b> delivered successfully again. Failed deliveries from the incident can be resent from the deliveries page.</p>`,
          link,
        ),
        { destinationId: d.id, items: {} },
      );
      await db
        .updateTable('destinations')
        .set({ incident_alerted_at: null })
        .where('id', '=', d.id)
        .execute();
    }
  }

  // Phase 1/2 emails (register summaries, task emails) that gave up since the last such alert.
  const lastSystem = await db
    .selectFrom('delivery_alerts')
    .select(sql<Date | null>`max(sent_at)`.as('at'))
    .where('kind', '=', 'system_email')
    .executeTakeFirst();
  const since = lastSystem?.at ?? new Date(0);
  const gaveUp = await sql<{ kind: string; id: string; failures: number }>`
    WITH failed AS (
      SELECT n.submission_id, n.dispatch_id, count(*)::int AS failures, max(n.created_at) AS last
      FROM notification_log n
      WHERE n.status = 'failed'
      GROUP BY n.submission_id, n.dispatch_id
    )
    SELECT CASE WHEN f.submission_id IS NOT NULL THEN 'register' ELSE 'task' END AS kind,
           coalesce(f.submission_id, f.dispatch_id)::text AS id, f.failures
    FROM failed f
    WHERE f.failures >= ${MAX_SWEEP_FAILURES} AND f.last > ${since}
      AND NOT EXISTS (SELECT 1 FROM notification_log s WHERE s.status IN ('sent', 'skipped')
            AND (s.submission_id = f.submission_id OR s.dispatch_id = f.dispatch_id))
    LIMIT 200
  `.execute(db);
  if (gaveUp.rows.length) {
    await send(
      'system_email',
      `${gaveUp.rows.length} FieldForms email${gaveUp.rows.length === 1 ? '' : 's'} could not be sent`,
      page(
        'Emails that could not be sent',
        `<p>These register summaries or task emails failed ${MAX_SWEEP_FAILURES} times and were given up. Check the mail settings, then resend them from the deliveries page (System emails).</p>
<ul>${gaveUp.rows.map((r) => `<li>${esc(r.kind)} ${esc(r.id)}</li>`).join('')}</ul>`,
        link,
      ),
      { items: { ids: gaveUp.rows.map((r) => r.id) } },
    );
  }

  // Connection secrets that expire within 30 days, at most once a week per connection.
  const expiring = await db
    .selectFrom('connections as c')
    .select(['c.id', 'c.name', 'c.kind', 'c.secret_expires_on'])
    .where('c.archived_at', 'is', null)
    .where('c.secret_expires_on', 'is not', null)
    .where('c.secret_expires_on', '<=', sql<string>`current_date + 30`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('delivery_alerts as a')
            .select('a.id')
            .whereRef('a.connection_id', '=', 'c.id')
            .where('a.kind', '=', 'secret_expiry')
            .where('a.sent_at', '>', sql<Date>`now() - interval '7 days'`),
        ),
      ),
    )
    .execute();
  for (const c of expiring) {
    await send(
      'secret_expiry',
      `Credentials expire on ${c.secret_expires_on}: ${c.name}`,
      page(
        'Credentials are about to expire',
        `<p>The secret of the connection <b>${esc(c.name)}</b> (${esc(c.kind)}) expires on ${esc(c.secret_expires_on)}. Create a new one with the provider and enter it under Admin → Connections; every destination using it picks it up.</p>`,
        `${publicUrl}/admin/connections`,
      ),
      { connectionId: c.id, items: { expiresOn: c.secret_expires_on } },
    );
  }
  return { sent, recipients: recipients.length };
}
