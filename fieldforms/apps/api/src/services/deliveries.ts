import {
  buildDocumentModel,
  evaluateExpression,
  fieldKeysOf,
  INCLUDE_ALL,
  reservedValues,
  expr,
  type Answers,
  type FormDefinition,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { JobQueue } from './registers.js';

/**
 * The delivery pipeline (ARCHITECTURE.md, "Delivery pipeline"). The `deliveries` row is the
 * state machine and the lock; jobs only wake workers up. Everything that creates or changes a
 * delivery enqueues its job in the same transaction (JobQueue takes the transaction).
 */

// ---------------------------------------------------------------- conditions

interface SubmissionFacts {
  id: string;
  formId: string;
  definition: FormDefinition;
  answers: Answers;
  receivedAt: Date;
  capturedAt: Date | null;
  clockSkewFlag: boolean;
  siteId: string | null;
  site: string;
  region: string;
  company: string;
  submittedBy: string;
  taskTitle: string;
}

/** What a condition needs about each submission (one query, any number of submissions). */
export async function submissionFacts(
  db: Db,
  ids: string[],
): Promise<Map<string, SubmissionFacts>> {
  const out = new Map<string, SubmissionFacts>();
  if (!ids.length) return out;
  const rows = await db
    .selectFrom('form_submissions as s')
    .innerJoin('form_versions as v', 'v.id', 's.form_version_id')
    .leftJoin('sites as st', 'st.id', 's.site_id')
    .leftJoin('regions as r', 'r.id', 'st.region_id')
    .leftJoin('companies as c', 'c.id', 'r.company_id')
    .leftJoin('users as u', 'u.id', 's.submitted_by')
    .leftJoin('dispatches as d', 'd.id', 's.dispatch_id')
    .select([
      's.id',
      's.form_id',
      's.data',
      's.server_received_at',
      's.device_captured_at',
      's.clock_skew_flag',
      's.site_id',
      'v.definition',
      'st.name as site',
      'r.name as region',
      'c.name as company',
      'u.display_name as submitted_by',
      'd.title as task_title',
    ])
    .where('s.id', 'in', ids)
    .execute();
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      formId: r.form_id,
      definition: r.definition as FormDefinition,
      answers: r.data as Answers,
      receivedAt: r.server_received_at,
      capturedAt: r.device_captured_at,
      clockSkewFlag: r.clock_skew_flag,
      siteId: r.site_id,
      site: r.site ?? '',
      region: r.region ?? '',
      company: r.company ?? '',
      submittedBy: r.submitted_by ?? '',
      taskTitle: r.task_title ?? '',
    });
  }
  return out;
}

/** Every published definition of a form, for reading fields other versions have as blank. */
export async function formVersions(db: Db, formId: string) {
  const rows = await db
    .selectFrom('form_versions')
    .select(['version', 'definition'])
    .where('form_id', '=', formId)
    .orderBy('version')
    .execute();
  return rows.map((r) => ({ version: r.version, definition: r.definition as FormDefinition }));
}

/**
 * Evaluates a destination's condition on a stored submission, with the submission's own version
 * and `now` as when it was filled in (if the device clock was plausible).
 */
export function evaluateCondition(
  condition: string | null,
  facts: SubmissionFacts,
  knownIds: ReadonlySet<string>,
  formName: string,
): { use: boolean; error: string | null } {
  if (!condition?.trim()) return { use: true, error: null };
  const model = buildDocumentModel(
    facts.definition,
    facts.answers,
    {
      form: { id: facts.formId, name: formName, version: 0, versionId: '' },
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
        url: '',
      },
      branding: { name: '', colour: '#000000', logoBlobId: null, footer: '' },
    },
    { include: INCLUDE_ALL },
  );
  const now = facts.capturedAt && !facts.clockSkewFlag ? facts.capturedAt : facts.receivedAt;
  const r = evaluateExpression(facts.definition, facts.answers, condition, {
    extras: reservedValues(model),
    knownIds,
    now,
  });
  if (r.error) return { use: false, error: r.error };
  return { use: expr.truthy(r.value), error: null };
}

// ---------------------------------------------------------------- creating deliveries

/**
 * Inserts deliveries for one destination and enqueues the new ones, in the caller's transaction.
 * A false condition makes a `skipped` delivery; an error a `failed` one (both with an attempt row
 * saying why). Existing deliveries are left alone (UNIQUE (submission_id, destination_id)).
 */
async function insertDeliveries(
  trx: Db,
  queue: JobQueue,
  destination: { id: string; condition: string | null; formId: string; formName: string },
  facts: SubmissionFacts[],
  opts: { ignoreCondition: boolean; triggeredBy: string | null },
): Promise<{ created: number; skipped: number; existing: number }> {
  const knownIds = fieldKeysOf(
    (await formVersions(trx, destination.formId)).map((v) => v.definition),
  );
  let created = 0;
  let skipped = 0;
  let existing = 0;
  for (const f of facts) {
    const c = opts.ignoreCondition
      ? { use: true, error: null }
      : evaluateCondition(destination.condition, f, knownIds, destination.formName);
    const status = c.error ? 'failed' : c.use ? 'pending' : 'skipped';
    const row = await trx
      .insertInto('deliveries')
      .values({
        submission_id: f.id,
        destination_id: destination.id,
        status,
        last_error: c.error ? `Condition could not be evaluated: ${c.error}`.slice(0, 300) : null,
        last_error_class: c.error ? 'condition' : null,
      })
      .onConflict((oc) => oc.columns(['submission_id', 'destination_id']).doNothing())
      .returning(['id', 'generation'])
      .executeTakeFirst();
    if (!row) {
      existing++;
      continue;
    }
    if (status === 'pending') {
      created++;
      await queue.enqueueDelivery({ deliveryId: row.id, generation: row.generation }, trx);
    } else {
      skipped++;
      await trx
        .insertInto('delivery_attempts')
        .values({
          delivery_id: row.id,
          generation: row.generation,
          attempt_no: 0,
          outcome: status === 'failed' ? 'failed' : 'skipped',
          detail: c.error
            ? `Condition could not be evaluated: ${c.error}`.slice(0, 300)
            : 'The condition was false',
          started_at: new Date(),
          triggered_by: opts.triggeredBy,
        })
        .execute();
    }
  }
  return { created, skipped, existing };
}

/**
 * Creates missing deliveries of a destination for the given submissions (backfill, or "also
 * send submissions since …" when a destination is created or re-activated) and enqueues them in
 * the caller's transaction. Only submissions of the destination's form count. Existing
 * deliveries are left alone. Conditions are evaluated unless `ignoreCondition`.
 */
export async function backfillDeliveries(
  trx: Db,
  queue: JobQueue,
  input: {
    destinationId: string;
    submissionIds: string[];
    triggeredBy: string;
    ignoreCondition: boolean;
  },
): Promise<{ created: number; skipped: number; existing: number }> {
  const d = await trx
    .selectFrom('destinations as d')
    .innerJoin('forms as f', 'f.id', 'd.form_id')
    .select(['d.id', 'd.condition', 'd.form_id', 'f.name as form_name'])
    .where('d.id', '=', input.destinationId)
    .executeTakeFirstOrThrow();
  const facts = [
    ...(await submissionFacts(trx, [...new Set(input.submissionIds)])).values(),
  ].filter((f) => f.formId === d.form_id);
  return insertDeliveries(
    trx,
    queue,
    { id: d.id, condition: d.condition, formId: d.form_id, formName: d.form_name },
    facts,
    { ignoreCondition: input.ignoreCondition, triggeredBy: input.triggeredBy },
  );
}

/**
 * Cancels a destination's pending deliveries (it was deactivated or archived), with a
 * `cancelled` attempt each. Runs in the caller's transaction. Returns how many.
 */
export async function cancelPendingDeliveries(
  trx: Db,
  destinationId: string,
  by: string | null,
  reason: string,
): Promise<number> {
  const rows = await trx
    .updateTable('deliveries')
    .set({
      status: 'cancelled',
      last_error: reason.slice(0, 300),
      last_error_class: null,
      updated_at: sql`now()`,
    })
    .where('destination_id', '=', destinationId)
    .where('status', '=', 'pending')
    .returning(['id', 'generation', 'attempt_count'])
    .execute();
  if (rows.length) {
    await trx
      .insertInto('delivery_attempts')
      .values(
        rows.map((r) => ({
          delivery_id: r.id,
          generation: r.generation,
          attempt_no: r.attempt_count,
          outcome: 'cancelled' as const,
          detail: reason.slice(0, 300),
          started_at: new Date(),
          triggered_by: by,
        })),
      )
      .execute();
  }
  return rows.length;
}
