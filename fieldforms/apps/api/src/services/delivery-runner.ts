import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_FILENAME,
  destinationInclude,
  destinationSettingsSchemas,
  evaluateExpression,
  fieldKeysOf,
  reservedValues,
  templateData,
  type DestinationInclude,
  type DestinationKind,
  type DocField,
  type DocumentModel,
  type ErrorClass,
  type Format,
  type FormDefinition,
  type MappingSource,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import { resolveSiteIds } from '../auth/scope.js';
import type { Db } from '../db/index.js';
import { ADAPTERS, DRIVERS } from '../destinations/index.js';
import { fileStem } from '../destinations/naming.js';
import {
  DeliveryError,
  redact,
  type AdapterEnv,
  type AdapterResult,
  type Contacts,
  type DeliveryContext,
  type Endpoints,
  type Mailer,
  type OpenConnection,
} from '../destinations/types.js';
import type { BlobStore } from '../lib/blobstore.js';
import { renderLiquid } from '../lib/liquid.js';
import { NetworkPolicyError, type NetworkPolicy } from '../lib/netguard.js';
import { SecretsError, type SecretOpener } from '../lib/secrets.js';
import type { PdfConverter, RenderedFile, TemplateRef } from '../outputs/types.js';
import type * as documents from './documents.js';
import type { JobQueue } from './registers.js';

/**
 * Runs one delivery attempt in the worker (ARCHITECTURE.md, "Delivery pipeline"):
 *
 *   claim the row (pending → sending, with a lease token) → check the destination is still on →
 *   open the connection's secrets → build the filtered model → fix templates and target for the
 *   generation → render (cached) → call the adapter with a deadline → finish in one transaction
 *   guarded by the lease token (attempt row + new state, next job for a retry).
 *
 * pg-boss only wakes us up: a job that finds nothing to claim does nothing, so duplicate jobs
 * are harmless. Errors never reach pg-boss; they become attempt rows with safe messages.
 */

/** A worker holds a claimed delivery for this long; the adapter deadline is well inside it. */
export const LEASE_SECONDS = 480;
export const ADAPTER_DEADLINE_MS = 240_000;
export const RENDER_DEADLINE_MS = 120_000;
/** About a day of retries: 30 s doubling, each wait capped at an hour. */
export const MAX_ATTEMPTS = 30;

export function backoffSeconds(attempt: number, random = Math.random()): number {
  const base = Math.min(30 * 2 ** Math.max(0, attempt - 1), 3600);
  return Math.round(base * (0.8 + 0.4 * random));
}

export type DocumentsApi = Pick<
  typeof documents,
  'loadSubmission' | 'loadTemplate' | 'renderFormat' | 'submissionJson'
> & {
  /** A model of generated answers for test sends (no real personal data). */
  sampleSubmission: (
    def: FormDefinition,
    form: { id: string; name: string; version: number; versionId: string },
    include: DestinationInclude,
    now: Date,
  ) => DocumentModel;
};

export interface PipelineDeps {
  db: Db;
  queue: JobQueue;
  blobs: BlobStore;
  opener: SecretOpener;
  pdf: PdfConverter;
  mailer: Mailer;
  publicUrl: string;
  policy: NetworkPolicy;
  vendorPolicy: NetworkPolicy;
  endpoints: Endpoints;
  emailAttachmentLimit: number;
  /** Shown in attempt rows: host and process. */
  worker: string;
  documents: DocumentsApi;
  adapters?: typeof ADAPTERS;
  drivers?: typeof DRIVERS;
}

interface Classified {
  permanent: boolean;
  errorClass: ErrorClass;
  message: string;
  detail: string | null;
}

/** Turns anything thrown into a safe message, a class and whether retrying can help. */
export function classify(err: unknown, secrets: Record<string, string> = {}): Classified {
  if (err instanceof DeliveryError) {
    return {
      permanent: err.permanent,
      errorClass: err.errorClass,
      message: err.message,
      detail: err.detail ? redact(err.detail, secrets) : null,
    };
  }
  const e = err as { name?: string; message?: string; permanent?: boolean };
  const detail = e?.message ? redact(String(e.message), secrets) : null;
  if (err instanceof ZodError)
    return {
      permanent: true,
      errorClass: 'settings',
      message: 'The destination settings are invalid',
      detail,
    };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return { permanent: false, errorClass: 'unreachable', message: 'Timed out', detail };
  if (e?.permanent === true) {
    const errorClass: ErrorClass =
      err instanceof NetworkPolicyError
        ? 'network_policy'
        : err instanceof SecretsError
          ? 'settings'
          : 'template';
    // These messages are written to be safe (policy, template and secret errors).
    return {
      permanent: true,
      errorClass,
      message: redact(String(e.message ?? 'Failed'), secrets),
      detail,
    };
  }
  return { permanent: false, errorClass: 'internal', message: 'Unexpected error', detail };
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const docSummary = (files: RenderedFile[]) =>
  files.map((f) => ({
    filename: f.filename,
    contentType: f.contentType,
    size: f.data.length,
    sha256: sha256(f.data),
  }));

/** A mapping value: a field's display text (in a row when given), or an expression's result. */
function mappingValue(
  model: DocumentModel,
  loaded: { definition: FormDefinition; knownIds: ReadonlySet<string>; now: Date },
  source: MappingSource,
  row?: { group: string; index: number },
): unknown {
  if (source.type === 'field') {
    const [a, b] = source.field.split('.');
    const top = (id: string) => model.fields.find((f) => f.id === id);
    const cell = (cells: DocField[] | undefined, id: string) =>
      cells?.find((c) => c.id === id)?.text ?? null;
    if (row) {
      const group = top(row.group);
      if (b && a === row.group) return cell(group?.rows?.[row.index], b);
      if (!b) {
        const sibling = cell(group?.rows?.[row.index], a!);
        if (sibling !== null) return sibling;
      }
    }
    if (b) {
      const group = top(a!);
      return group?.rows?.map((cells) => cell(cells, b) ?? '').join(', ') ?? null;
    }
    return top(a!)?.text ?? null;
  }
  const r = evaluateExpression(loaded.definition, model.raw, source.expression, {
    extras: reservedValues(model),
    knownIds: loaded.knownIds,
    now: loaded.now,
    row,
  });
  if (r.error)
    throw new DeliveryError('A column mapping could not be evaluated', {
      permanent: true,
      errorClass: 'settings',
      detail: `${source.expression}: ${r.error}`,
    });
  return r.value;
}

async function contactsFor(
  db: Db,
  loaded: { siteId: string | null; submittedBy: string | null; dispatchId: string | null },
): Promise<Contacts> {
  const email = async (userId: string | null | undefined) =>
    userId
      ? ((
          await db
            .selectFrom('users')
            .select(['email', 'active'])
            .where('id', '=', userId)
            .executeTakeFirst()
        )?.email ?? null)
      : null;
  const task = loaded.dispatchId
    ? await db
        .selectFrom('dispatches')
        .select('created_by')
        .where('id', '=', loaded.dispatchId)
        .executeTakeFirst()
    : undefined;
  let siteRecipients: string[] = [];
  const siteManagers: string[] = [];
  if (loaded.siteId) {
    const s = await db
      .selectFrom('sites as s')
      .innerJoin('regions as r', 'r.id', 's.region_id')
      .innerJoin('companies as c', 'c.id', 'r.company_id')
      .select(['s.report_recipients as site', 'c.report_recipients as company'])
      .where('s.id', '=', loaded.siteId)
      .executeTakeFirst();
    siteRecipients = (s?.site?.length ? s.site : s?.company) ?? [];
    const managers = await db
      .selectFrom('users')
      .select(['id', 'role', 'email'])
      .where('role', '=', 'manager')
      .where('active', '=', true)
      .where('email', 'is not', null)
      .execute();
    for (const m of managers) {
      const sites = await resolveSiteIds(db, m.id, m.role);
      if (sites === null || sites.includes(loaded.siteId)) siteManagers.push(m.email!);
    }
  }
  return {
    submitterEmail: await email(loaded.submittedBy),
    taskSenderEmail: await email(task?.created_by),
    siteRecipients,
    siteManagers,
  };
}

interface Prepared {
  kind: DestinationKind;
  settings: unknown;
  conn: OpenConnection | null;
  ctx: DeliveryContext;
  files: RenderedFile[];
  templateVersionIds: Record<string, string>;
  destinationRevisionId: string | null;
  connectionRevisionId: string | null;
  secrets: Record<string, string>;
}

/**
 * Loads everything an attempt needs. Throws for anything that stops it (classified by the
 * caller). `fixed` holds what the generation already fixed (templates, target).
 */
async function prepare(
  deps: PipelineDeps,
  input: {
    destinationId: string;
    submissionId: string | null;
    delivery: DeliveryContext['delivery'];
    test: DeliveryContext['test'];
    fixedTemplates: Record<string, string> | null;
    target: Record<string, unknown> | null;
    earlierEvidence: Record<string, unknown>[];
    signal: AbortSignal;
  },
): Promise<Prepared> {
  const { db } = deps;
  const d = await db
    .selectFrom('destinations as d')
    .innerJoin('forms as f', 'f.id', 'd.form_id')
    .selectAll('d')
    .select(['f.name as form_name'])
    .where('d.id', '=', input.destinationId)
    .executeTakeFirstOrThrow();
  const settings = destinationSettingsSchemas[d.kind].parse(d.settings);
  const include = destinationInclude.parse(d.include);

  let conn: OpenConnection | null = null;
  let secrets: Record<string, string> = {};
  let connectionRevisionId: string | null = null;
  if (d.connection_id) {
    const c = await db
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', d.connection_id)
      .executeTakeFirstOrThrow();
    if (c.archived_at)
      throw new DeliveryError('The connection has been archived', {
        permanent: true,
        errorClass: 'settings',
      });
    secrets = c.secrets ? deps.opener.open(c.secrets, `connection:${c.id}`) : {};
    conn = { id: c.id, kind: c.kind, config: c.config as Record<string, unknown>, secrets };
    connectionRevisionId =
      (
        await db
          .selectFrom('connection_revisions')
          .select('id')
          .where('connection_id', '=', c.id)
          .where('revision', '=', c.revision)
          .executeTakeFirst()
      )?.id ?? null;
  }
  const destinationRevisionId =
    (
      await db
        .selectFrom('destination_revisions')
        .select('id')
        .where('destination_id', '=', d.id)
        .where('revision', '=', d.revision)
        .executeTakeFirst()
    )?.id ?? null;

  // The model: a real submission, or a sample for a test send.
  let model: DocumentModel;
  let definition: FormDefinition;
  let versions: { version: number; definition: FormDefinition }[];
  let who = {
    siteId: null as string | null,
    submittedBy: null as string | null,
    dispatchId: null as string | null,
  };
  if (input.submissionId) {
    const loaded = await deps.documents.loadSubmission(
      db,
      input.submissionId,
      include,
      deps.publicUrl,
    );
    if (!loaded)
      throw new DeliveryError('The submission no longer exists', {
        permanent: true,
        errorClass: 'internal',
      });
    model = loaded.model;
    definition = loaded.definition;
    versions = loaded.versions;
    who = { siteId: loaded.siteId, submittedBy: loaded.submittedBy, dispatchId: loaded.dispatchId };
  } else {
    const v = await db
      .selectFrom('form_versions')
      .select(['id', 'version', 'definition'])
      .where('form_id', '=', d.form_id)
      .orderBy('version', 'desc')
      .executeTakeFirstOrThrow();
    definition = v.definition as typeof definition;
    versions = [{ version: v.version, definition }];
    model = deps.documents.sampleSubmission(
      definition,
      { id: d.form_id, name: d.form_name, version: v.version, versionId: v.id },
      include,
      new Date(),
    );
  }

  // Templates: fixed for the generation on its first attempt.
  const templateVersionIds: Record<string, string> = { ...(input.fixedTemplates ?? {}) };
  const templates = (d.templates ?? {}) as Record<string, string>;
  const refs: Partial<Record<Format, TemplateRef>> = {};
  for (const format of d.formats) {
    const templateId = templates[format];
    if (!templateId) continue;
    const ref = await deps.documents.loadTemplate(db, templateId, templateVersionIds[format]);
    if (!ref)
      throw new DeliveryError('A document template is missing or archived', {
        permanent: true,
        errorClass: 'template',
      });
    refs[format] = ref;
    templateVersionIds[format] = ref.versionId;
  }

  const data = templateData(model);
  const liquid = (t: string, c: 'html' | 'slack' | 'line' | 'text') => renderLiquid(t, data, c);
  const filenameTemplate = (settings as { filename?: string }).filename ?? DEFAULT_FILENAME;
  const stem = fileStem(model, await liquid(filenameTemplate, 'line'));

  const files: RenderedFile[] = [];
  const renderSignal = AbortSignal.any([input.signal, AbortSignal.timeout(RENDER_DEADLINE_MS)]);
  for (const format of d.formats) {
    const r = await deps.documents.renderFormat(
      { db, blobs: deps.blobs, pdf: deps.pdf, publicUrl: deps.publicUrl },
      {
        submissionId: input.submissionId,
        model,
        include,
        format,
        template: refs[format] ?? null,
        stem,
        signal: renderSignal,
      },
    );
    files.push(...r.files);
  }

  const knownIds = fieldKeysOf(versions.map((v) => v.definition));
  // Expressions see "today" as when the form was filled in, if the device clock was plausible,
  // exactly as when the submission was stored.
  const received = new Date(model.submission.receivedAt);
  const captured = model.submission.capturedAt ? new Date(model.submission.capturedAt) : null;
  const now =
    captured &&
    captured.getTime() <= received.getTime() + 5 * 60_000 &&
    captured.getTime() >= received.getTime() - 60 * 86_400_000
      ? captured
      : received;
  const ctx: DeliveryContext = {
    delivery: input.delivery,
    test: input.test,
    model,
    files,
    json: deps.documents.submissionJson(model, `${deps.publicUrl}/api/v1`),
    value: (source, row) => mappingValue(model, { definition, knownIds, now }, source, row),
    liquid,
    contacts:
      d.kind === 'email'
        ? await contactsFor(db, who)
        : { submitterEmail: null, taskSenderEmail: null, siteRecipients: [], siteManagers: [] },
    target: input.target,
    earlierEvidence: input.earlierEvidence,
    link: model.submission.url,
  };
  return {
    kind: d.kind,
    settings,
    conn,
    ctx,
    files,
    templateVersionIds,
    destinationRevisionId,
    connectionRevisionId,
    secrets,
  };
}

function adapterEnv(deps: PipelineDeps, signal: AbortSignal): AdapterEnv {
  return {
    policy: deps.policy,
    vendorPolicy: deps.vendorPolicy,
    mailer: deps.mailer,
    endpoints: deps.endpoints,
    signal,
    now: () => new Date(),
    emailAttachmentLimit: deps.emailAttachmentLimit,
  };
}

/** The outcome of one job, for logs and tests. */
export type RunOutcome =
  | 'not-claimed'
  | 'delivered'
  | 'already_present'
  | 'skipped'
  | 'retry'
  | 'failed'
  | 'cancelled'
  | 'lease-lost';

/** Runs one attempt of a delivery. Never throws for delivery problems. */
export async function runDelivery(
  deps: PipelineDeps,
  job: { deliveryId: string; generation: number; jobId?: string },
): Promise<RunOutcome> {
  const { db } = deps;
  const token = randomUUID();
  const claimed = await db
    .updateTable('deliveries')
    .set({
      status: 'sending',
      lease_token: token,
      lease_until: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
      attempt_count: sql`attempt_count + 1`,
      updated_at: sql`now()`,
    })
    .where('id', '=', job.deliveryId)
    .where('generation', '=', job.generation)
    .where('status', '=', 'pending')
    .where('next_attempt_at', '<=', sql<Date>`now() + interval '5 seconds'`)
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return 'not-claimed';

  const started = new Date();
  const attemptNo = claimed.attempt_count;
  const dest = await db
    .selectFrom('destinations')
    .select(['id', 'kind', 'active', 'archived_at'])
    .where('id', '=', claimed.destination_id)
    .executeTakeFirstOrThrow();

  const base = {
    delivery_id: claimed.id,
    generation: claimed.generation,
    attempt_no: attemptNo,
    job_id: job.jobId ?? null,
    worker: deps.worker,
    started_at: started,
  };

  if (!dest.active || dest.archived_at) {
    return finish(deps, claimed.id, token, {
      status: 'cancelled',
      attempt: { ...base, outcome: 'cancelled', detail: 'The destination is switched off' },
    });
  }

  const deadline = AbortSignal.timeout(ADAPTER_DEADLINE_MS + RENDER_DEADLINE_MS);
  let secrets: Record<string, string> = {};
  let prepared: Prepared | null = null;
  try {
    // What this delivery's earlier attempts wrote, so an adapter can recognise its own files.
    const earlier = await db
      .selectFrom('delivery_attempts')
      .select('evidence')
      .where('delivery_id', '=', claimed.id)
      .where('evidence', 'is not', null)
      .orderBy('generation')
      .orderBy('attempt_no')
      .execute();
    prepared = await prepare(deps, {
      destinationId: dest.id,
      submissionId: claimed.submission_id,
      delivery: {
        id: claimed.id,
        generation: claimed.generation,
        attempt: attemptNo,
        idempotencyKey: `${claimed.id}.${claimed.generation}`,
        resend: claimed.generation > 1,
      },
      test: null,
      fixedTemplates: (claimed.template_version_ids as Record<string, string> | null) ?? null,
      target: (claimed.target as Record<string, unknown> | null) ?? null,
      earlierEvidence: earlier.map((r) => r.evidence as Record<string, unknown>),
      signal: deadline,
    });
    secrets = prepared.secrets;
    const adapter = (deps.adapters ?? ADAPTERS)[prepared.kind];
    const adapterSignal = AbortSignal.any([deadline, AbortSignal.timeout(ADAPTER_DEADLINE_MS)]);
    const env = adapterEnv(deps, adapterSignal);

    // Fix the template versions and the target for this generation before sending anything.
    let target = prepared.ctx.target;
    if (!target) {
      target = adapter.resolveTarget
        ? await adapter.resolveTarget(prepared.ctx, prepared.settings, prepared.conn, env)
        : {};
      prepared.ctx.target = target;
    }
    const fixed = await db
      .updateTable('deliveries')
      .set({
        target: JSON.stringify(target),
        template_version_ids: JSON.stringify(prepared.templateVersionIds),
      })
      .where('id', '=', claimed.id)
      .where('lease_token', '=', token)
      .executeTakeFirst();
    if (!fixed.numUpdatedRows) return 'lease-lost';

    const result: AdapterResult = await adapter.deliver(
      prepared.ctx,
      prepared.settings,
      prepared.conn,
      env,
    );
    const outcome = result.outcome;
    return finish(deps, claimed.id, token, {
      status: outcome === 'skipped' ? 'skipped' : 'delivered',
      attempt: {
        ...base,
        outcome,
        detail: result.detail ? redact(result.detail, secrets) : null,
        destination_revision_id: prepared.destinationRevisionId,
        connection_revision_id: prepared.connectionRevisionId,
        template_version_ids: JSON.stringify(prepared.templateVersionIds),
        documents: JSON.stringify(docSummary(prepared.files)),
        target: JSON.stringify(result.target),
        evidence: JSON.stringify(result.evidence),
      },
      destinationId: dest.id,
      success: outcome !== 'skipped',
    });
  } catch (err) {
    const c = classify(err, secrets);
    const exhausted = attemptNo >= MAX_ATTEMPTS;
    const fail = c.permanent || exhausted;
    const detail = [c.message, c.detail].filter(Boolean).join(': ').slice(0, 300);
    const attempt = {
      ...base,
      outcome: fail ? ('failed' as const) : ('retry' as const),
      detail:
        exhausted && !c.permanent
          ? `Gave up after ${attemptNo} attempts: ${detail}`.slice(0, 300)
          : detail,
      destination_revision_id: prepared?.destinationRevisionId ?? null,
      connection_revision_id: prepared?.connectionRevisionId ?? null,
      template_version_ids: prepared ? JSON.stringify(prepared.templateVersionIds) : null,
      documents: prepared ? JSON.stringify(docSummary(prepared.files)) : null,
      target: prepared?.ctx.target ? JSON.stringify(prepared.ctx.target) : null,
      // What a failed attempt had already written (an SFTP file), for the next one to replace.
      evidence: err instanceof DeliveryError && err.evidence ? JSON.stringify(err.evidence) : null,
    };
    if (fail) {
      return finish(deps, claimed.id, token, {
        status: 'failed',
        attempt,
        error: { text: c.message, class: c.errorClass },
        destinationId: dest.id,
        success: false,
      });
    }
    const next = new Date(Date.now() + backoffSeconds(attemptNo) * 1000);
    return finish(deps, claimed.id, token, {
      status: 'pending',
      attempt,
      error: { text: c.message, class: c.errorClass },
      next: { at: next, generation: claimed.generation },
    });
  }
}

/** A delivery_attempts row (its columns are written as Kysely insert values). */
type AttemptRow = Record<string, unknown> & { outcome: string };

/**
 * Ends an attempt in one transaction guarded by the lease token: the attempt row, the new state,
 * the destination's incident counters, and the next job for a retry.
 */
async function finish(
  deps: PipelineDeps,
  deliveryId: string,
  token: string,
  r: {
    status: 'delivered' | 'skipped' | 'failed' | 'pending' | 'cancelled';
    attempt: AttemptRow;
    error?: { text: string; class: ErrorClass };
    next?: { at: Date; generation: number };
    destinationId?: string;
    success?: boolean;
  },
): Promise<RunOutcome> {
  let lost = false;
  await deps.db.transaction().execute(async (trx) => {
    const done = await trx
      .updateTable('deliveries')
      .set({
        status: r.status,
        lease_token: null,
        lease_until: null,
        updated_at: sql`now()`,
        last_error: r.error ? r.error.text.slice(0, 300) : null,
        last_error_class: r.error?.class ?? null,
        ...(r.status === 'delivered' ? { delivered_at: sql`now()` } : {}),
        ...(r.next ? { next_attempt_at: r.next.at } : {}),
      })
      .where('id', '=', deliveryId)
      .where('lease_token', '=', token)
      .executeTakeFirst();
    if (!done.numUpdatedRows) {
      lost = true;
      return;
    }
    await trx
      .insertInto('delivery_attempts')
      .values(r.attempt as never)
      .execute();
    if (r.destinationId && r.success === true) {
      await trx
        .updateTable('destinations')
        .set({ consecutive_failures: 0, last_success_at: sql`now()`, failing_since: null })
        .where('id', '=', r.destinationId)
        .execute();
    } else if (r.destinationId && r.status === 'failed') {
      await trx
        .updateTable('destinations')
        .set({
          consecutive_failures: sql`consecutive_failures + 1`,
          last_failure_at: sql`now()`,
          failing_since: sql`coalesce(failing_since, now())`,
        })
        .where('id', '=', r.destinationId)
        .execute();
    }
    if (r.next)
      await deps.queue.enqueueDelivery(
        { deliveryId, generation: r.next.generation },
        trx,
        r.next.at,
      );
  });
  if (lost) return 'lease-lost';
  return r.attempt.outcome as RunOutcome;
}

/**
 * Runs a connection check or a test send (a destination_tests row) and stores a safe result.
 * Only the worker can open secrets, so this runs here, not in the API.
 */
export async function runTest(
  deps: PipelineDeps,
  testId: string,
): Promise<'ok' | 'failed' | 'missing'> {
  const { db } = deps;
  const t = await db
    .updateTable('destination_tests')
    .set({ status: 'running' })
    .where('id', '=', testId)
    .where('status', '=', 'queued')
    .returningAll()
    .executeTakeFirst();
  if (!t) return 'missing';
  const signal = AbortSignal.timeout(ADAPTER_DEADLINE_MS);
  const env = adapterEnv(deps, signal);
  let secrets: Record<string, string> = {};
  let result: Record<string, unknown>;
  let ok = false;
  try {
    if (t.kind === 'check') {
      // A saved connection, a destination (its connection plus its own settings), or a draft.
      let conn: OpenConnection | null = null;
      let destination: { kind: DestinationKind; settings: unknown } | null = null;
      if (t.destination_id) {
        const d = await db
          .selectFrom('destinations')
          .selectAll()
          .where('id', '=', t.destination_id)
          .executeTakeFirstOrThrow();
        destination = {
          kind: d.kind,
          settings: destinationSettingsSchemas[d.kind].parse(d.settings),
        };
        if (d.connection_id) conn = await openConnection(deps, d.connection_id);
      } else if (t.connection_id) {
        conn = await openConnection(deps, t.connection_id);
      } else if (t.draft_kind) {
        secrets = t.draft_secrets ? deps.opener.open(t.draft_secrets, `test:${t.id}`) : {};
        conn = {
          id: 'draft',
          kind: t.draft_kind,
          config: (t.draft_config ?? {}) as Record<string, unknown>,
          secrets,
        };
      }
      if (conn) secrets = conn.secrets;
      const checks = [];
      if (conn) checks.push(await (deps.drivers ?? DRIVERS)[conn.kind].check(conn, env));
      const adapter = destination ? (deps.adapters ?? ADAPTERS)[destination.kind] : null;
      if (destination && adapter?.check)
        checks.push(await adapter.check(destination.settings, conn, env));
      ok = checks.length > 0 && checks.every((c) => c.ok);
      result = {
        summary: checks.map((c) => c.summary).join(' · ') || 'Nothing to check',
        facts: Object.assign({}, ...checks.map((c) => c.facts ?? {})),
        warnings: checks.flatMap((c) => c.warnings ?? []),
      };
      if (t.connection_id && !t.draft_kind) {
        await db
          .updateTable('connections')
          .set({
            last_check_at: sql`now()`,
            last_check_ok: ok,
            last_check_detail: String(result.summary).slice(0, 1000),
          })
          .where('id', '=', t.connection_id)
          .execute();
      }
    } else {
      const tester = await db
        .selectFrom('users')
        .select(['email', 'display_name'])
        .where('id', '=', t.requested_by)
        .executeTakeFirstOrThrow();
      const prepared = await prepare(deps, {
        destinationId: t.destination_id!,
        submissionId: t.submission_id,
        delivery: {
          id: t.id,
          generation: 1,
          attempt: 1,
          idempotencyKey: `test.${t.id}`,
          resend: false,
        },
        test: { tester: { email: tester.email, name: tester.display_name } },
        fixedTemplates: null,
        target: null,
        earlierEvidence: [],
        signal,
      });
      secrets = prepared.secrets;
      const adapter = (deps.adapters ?? ADAPTERS)[prepared.kind];
      if (adapter.resolveTarget)
        prepared.ctx.target = await adapter.resolveTarget(
          prepared.ctx,
          prepared.settings,
          prepared.conn,
          env,
        );
      const r = await adapter.deliver(prepared.ctx, prepared.settings, prepared.conn, env);
      ok = true;
      result = {
        summary: r.outcome === 'skipped' ? `Nothing sent: ${r.detail ?? ''}` : 'Test sent',
        target: r.target,
        evidence: r.evidence,
        documents: docSummary(prepared.files),
      };
    }
  } catch (err) {
    const c = classify(err, secrets);
    ok = false;
    result = { summary: c.message, errorClass: c.errorClass, detail: c.detail };
  }
  await db
    .updateTable('destination_tests')
    .set({ status: ok ? 'ok' : 'failed', result: JSON.stringify(result), finished_at: sql`now()` })
    .where('id', '=', t.id)
    .execute();
  return ok ? 'ok' : 'failed';
}

async function openConnection(deps: PipelineDeps, id: string): Promise<OpenConnection> {
  const c = await deps.db
    .selectFrom('connections')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return {
    id: c.id,
    kind: c.kind,
    config: c.config as Record<string, unknown>,
    secrets: c.secrets ? deps.opener.open(c.secrets, `connection:${c.id}`) : {},
  };
}
