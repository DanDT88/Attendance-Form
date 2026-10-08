import type {
  ConnectionKind,
  DestinationKind,
  DocumentModel,
  ErrorClass,
} from '@fieldforms/shared';
import type { ZodType } from 'zod';
import type { NetworkPolicy } from '../lib/netguard.js';
import type { RenderedFile } from '../outputs/types.js';

/**
 * Adapters deliver one submission to one destination; connection drivers check credentials.
 * Neither touches the database: the pipeline (services/deliveries.ts) loads everything, opens
 * the secrets, renders the documents and records the outcome.
 */

/** People an email destination can send to, looked up by the pipeline. */
export interface Contacts {
  submitterEmail: string | null;
  taskSenderEmail: string | null;
  /** The site's report recipients, else the company's (as Phase 1 registers). */
  siteRecipients: string[];
  /** Managers whose scope covers the site, with an email. */
  siteManagers: string[];
}

export interface DeliveryContext {
  delivery: {
    id: string;
    generation: number;
    /** 1-based attempt within the generation. */
    attempt: number;
    /** `<delivery id>.<generation>`: the idempotency key for this generation. */
    idempotencyKey: string;
    /** A later generation (a manual resend). */
    resend: boolean;
  };
  /**
   * A test send: email goes only to `tester`, files get a "TEST " prefix, webhooks carry
   * `X-FieldForms-Test: 1`, SQL rolls back, Sheets writes only if the settings allow test writes.
   */
  test: { tester: { email: string | null; name: string } } | null;
  model: DocumentModel;
  /** Documents in the destination's formats (already rendered), in format order. */
  files: RenderedFile[];
  /** The canonical submission JSON (filtered), as the JSON format holds it. */
  json: Record<string, unknown>;
  /**
   * Evaluates a column-mapping source for this submission (a field's display text, or an
   * expression on the submission's own version), optionally inside one repeat-group row.
   */
  value(
    source: { type: 'field'; field: string } | { type: 'expression'; expression: string },
    row?: { group: string; index: number },
  ): unknown;
  /** Renders a Liquid template with the submission's vocabulary (see `templateData`). */
  liquid(template: string, context: 'html' | 'slack' | 'line' | 'text'): Promise<string>;
  contacts: Contacts;
  /**
   * The target fixed for this generation by an earlier attempt (object key, remote path,
   * pre-generated file id), or null on the first attempt. Retries must reuse it.
   */
  target: Record<string, unknown> | null;
  /**
   * The evidence of this delivery's earlier attempts, every generation, oldest first (including
   * what a failed attempt had already written). An adapter that cannot tag what it writes (SFTP)
   * uses it to tell its own earlier files from anyone else's. Empty for test sends.
   */
  earlierEvidence: Record<string, unknown>[];
  /** In-app link to the submission (sign-in required). */
  link: string;
}

export interface Mailer {
  send(msg: {
    to: string[];
    cc?: string[];
    replyTo?: string;
    subject: string;
    html: string;
    text?: string;
    attachments: { filename: string; content: Buffer; contentType: string }[];
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string; response?: string }>;
}

/** Vendor endpoints. Tests point them at local fakes; destination settings cannot change them. */
export interface Endpoints {
  googleToken: string;
  googleDrive: string;
  googleUpload: string;
  googleSheets: string;
  microsoftLogin: string;
  microsoftGraph: string;
  /** Slack incoming-webhook URLs must match this. */
  slackHooks: RegExp;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  googleToken: 'https://oauth2.googleapis.com/token',
  googleDrive: 'https://www.googleapis.com/drive/v3',
  googleUpload: 'https://www.googleapis.com/upload/drive/v3',
  googleSheets: 'https://sheets.googleapis.com/v4',
  microsoftLogin: 'https://login.microsoftonline.com',
  microsoftGraph: 'https://graph.microsoft.com/v1.0',
  slackHooks: /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\//,
};

export interface AdapterEnv {
  /** Applies to admin-configured hosts (webhooks, SFTP, SQL, S3 endpoints). */
  policy: NetworkPolicy;
  /**
   * Applies to vendor endpoints. Production uses the same policy (vendors are public); tests
   * allow loopback so fakes can stand in.
   */
  vendorPolicy: NetworkPolicy;
  mailer: Mailer;
  endpoints: Endpoints;
  /** Aborts at the attempt's deadline. Pass it to every network call. */
  signal: AbortSignal;
  now(): Date;
  /** Emails larger than this (attachments, in bytes) send a link instead. */
  emailAttachmentLimit: number;
}

/** A connection's settings and its opened secrets. */
export interface OpenConnection<Config = Record<string, unknown>> {
  id: string;
  kind: ConnectionKind;
  config: Config;
  secrets: Record<string, string>;
}

export interface AdapterResult {
  /**
   * `already_present`: the destination already had it (a retry after a lost reply).
   * `skipped`: there was nothing to send (an email with no recipient); say why in `detail`.
   */
  outcome: 'delivered' | 'already_present' | 'skipped';
  detail?: string;
  /** Where it went, without secrets: recipients, URL origin and path, bucket/key, remote path. */
  target: Record<string, unknown>;
  /** What the destination said: SMTP message id, HTTP status, ETag, file id. No bodies. */
  evidence: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  /** A short, safe summary for the admin ("Connected as …", "Folder 'Reports' on 'Ops' drive"). */
  summary: string;
  /** Facts the admin needs: the SFTP host key, the service account's email, column names. */
  facts?: Record<string, string>;
  /** Problems found, e.g. a missing unique index or a header row that does not match. */
  warnings?: string[];
}

export interface DestinationAdapter<Settings = unknown, ConnConfig = Record<string, unknown>> {
  kind: DestinationKind;
  /**
   * Fixes the target for a generation before the first attempt (e.g. object keys from the
   * file-name template, a pre-generated Drive file id). Stored on the delivery and passed back
   * as `ctx.target` on every retry. Optional: adapters without one get `{}`.
   */
  resolveTarget?(
    ctx: DeliveryContext,
    settings: Settings,
    conn: OpenConnection<ConnConfig> | null,
    env: AdapterEnv,
  ): Promise<Record<string, unknown>>;
  deliver(
    ctx: DeliveryContext,
    settings: Settings,
    conn: OpenConnection<ConnConfig> | null,
    env: AdapterEnv,
  ): Promise<AdapterResult>;
  /** Read-only check of the destination's own settings (folder, table, sheet) on its connection. */
  check?(
    settings: Settings,
    conn: OpenConnection<ConnConfig> | null,
    env: AdapterEnv,
  ): Promise<CheckResult>;
}

export interface ConnectionDriver<Config = Record<string, unknown>> {
  kind: ConnectionKind;
  /** Validates the secrets an admin enters (the API checks them before sealing). */
  secretSchema: ZodType<Record<string, string>>;
  /** Read-only where possible: credentials work, the server is reachable, facts to pin. */
  check(conn: OpenConnection<Config>, env: AdapterEnv): Promise<CheckResult>;
}

/**
 * The only error adapters and drivers should throw. `message` is safe to store, show and email;
 * `detail` is redacted before it is stored and shown only to admins. `permanent` stops retries.
 */
export class DeliveryError extends Error {
  readonly permanent: boolean;
  readonly errorClass: ErrorClass;
  readonly detail?: string;
  readonly status?: number;
  /** What the attempt had already done when it failed (kept on the attempt row). */
  readonly evidence?: Record<string, unknown>;
  constructor(
    safeMessage: string,
    opts: {
      permanent: boolean;
      errorClass: ErrorClass;
      detail?: string;
      status?: number;
      evidence?: Record<string, unknown>;
    },
  ) {
    super(safeMessage);
    this.permanent = opts.permanent;
    this.errorClass = opts.errorClass;
    this.detail = opts.detail;
    this.status = opts.status;
    this.evidence = opts.evidence;
  }
}

/** An HTTP status from a destination: 408, 429 and 5xx are worth retrying, other 4xx are not. */
export function httpError(service: string, status: number, detail?: string): DeliveryError {
  const transient = status === 408 || status === 429 || status >= 500;
  const errorClass: ErrorClass =
    status === 401 || status === 403
      ? 'credentials'
      : status === 404
        ? 'not_found'
        : status === 413
          ? 'too_large'
          : transient
            ? 'unreachable'
            : 'rejected';
  return new DeliveryError(`${service} returned HTTP ${status}`, {
    permanent: !transient,
    errorClass,
    detail,
    status,
  });
}

/**
 * Removes secrets from text before it is stored: every secret value (and its URL-encoded and
 * base64 forms) and every longer fragment of one (a token in a URL's query, a path segment, a
 * key's lines), URL credentials and query strings, bearer tokens. Capped at 300 characters.
 */
export function redact(text: string, secrets: Record<string, string> = {}): string {
  let out = text;
  const parts = new Set<string>();
  for (const v of Object.values(secrets)) {
    if (!v || v.length < 4) continue;
    parts.add(v);
    parts.add(encodeURIComponent(v));
    parts.add(Buffer.from(v).toString('base64'));
    for (const fragment of v.split(/[^A-Za-z0-9._~+-]+/))
      if (fragment.length >= 8) parts.add(fragment);
  }
  // Longest first, so a whole value is replaced before its fragments.
  for (const p of [...parts].sort((a, b) => b.length - a.length))
    out = out.split(p).join('[secret]');
  out = out
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1[credentials]@')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, '$1?[query]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [secret]');
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}
