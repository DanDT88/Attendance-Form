import type {
  ApiScope,
  AttemptOutcome,
  ConnectionKind,
  DeliveryStatus,
  DestinationInclude,
  DestinationKind,
  Format,
  FormDefinition,
  Option,
  Settings,
  TemplateKind,
} from '@fieldforms/shared';
import { CSRF_HEADER } from '../offline/transport';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's `details` on a 400: validation issues, or what to re-enter. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** True when the request never reached the server (offline, DNS, connection reset). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof ApiError && err.status === 0);
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string; details?: unknown } | null;
  return new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body?.details);
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? CSRF_HEADER : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * A raw-body upload (a template file, a logo): the body goes as it is, with its own content
 * type, never as JSON. The answer is JSON.
 */
export async function apiUpload<T>(
  path: string,
  body: Blob | string,
  contentType: string,
  method: 'PUT' | 'POST' = 'PUT',
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...CSRF_HEADER, 'content-type': contentType },
    body,
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/** A file the server rendered or stored: a document, a ZIP, a template. */
export interface FileResult {
  blob: Blob;
  filename: string;
  contentType: string;
}

/** The file name from a Content-Disposition header (RFC 6266), preferring `filename*`. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim();
  return name || fallback;
}

/**
 * Fetches a file (GET, or POST with a JSON body for previews). Errors come back as ApiError
 * with the server's message instead of the browser showing an error page.
 */
export async function fetchFile(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; fallbackName?: string } = {},
): Promise<FileResult> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? CSRF_HEADER : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw await failure(res);
  const blob = await res.blob();
  return {
    blob,
    filename: filenameFromDisposition(
      res.headers.get('content-disposition'),
      init.fallbackName ?? 'download',
    ),
    contentType: res.headers.get('content-type') ?? blob.type,
  };
}

/** Types the browser may show in a tab. Anything else (HTML above all) is only ever saved. */
const VIEWABLE = /^(application\/pdf|image\/(png|jpeg|webp))(;|$)/i;
export const isViewable = (contentType: string) => VIEWABLE.test(contentType);

/**
 * Saves a file, or opens it in a new tab when it is a PDF or an image. A blob URL has the app's
 * origin, so HTML (which could run script there) is never opened, only downloaded.
 */
export function deliverFile(f: FileResult, mode: 'save' | 'open' = 'save'): void {
  if (mode === 'open' && isViewable(f.contentType)) {
    // The tab renders the blob's own type, so pin it to the checked one.
    const viewUrl = URL.createObjectURL(new Blob([f.blob], { type: f.contentType.split(';')[0] }));
    const w = window.open(viewUrl, '_blank');
    if (w) {
      w.opener = null;
      setTimeout(() => URL.revokeObjectURL(viewUrl), 60_000);
      return;
    }
    URL.revokeObjectURL(viewUrl);
  }
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface Me {
  id: string;
  role: 'admin' | 'manager' | 'supervisor';
  displayName: string;
  siteIds: string[] | null;
  privacyNotice: { version: string; text: string };
  consentRequired: boolean;
}

export interface PublishedForm {
  formId: string;
  name: string;
  versionId: string;
  version: number;
  definition: FormDefinition;
}

export interface InboxItem {
  id: string;
  title: string;
  instructions: string | null;
  prefill: Record<string, unknown>;
  site_id: string | null;
  site_name: string | null;
  due_on: string | null;
  created_at: string;
  form_id: string;
  form_version_id: string;
  version: number;
  definition: FormDefinition;
  form_name: string;
  created_by_name: string | null;
  group_name: string | null;
}

export interface Bootstrap {
  generatedAt: string;
  forms: PublishedForm[];
  lists: Record<string, Option[]>;
  inbox: InboxItem[];
  settings: { shiftGraceMinutes: number };
  sites: {
    id: string;
    name: string;
    lat: number | null;
    lng: number | null;
    geofence_metres: number;
    region_id: string;
    region_name: string;
    company_id: string;
    company_name: string;
  }[];
  shifts: {
    id: string;
    site_id: string;
    name: string;
    kind: 'day' | 'night';
    start_time: string;
    end_time: string;
  }[];
  employees: {
    id: string;
    employee_no: string;
    first_name: string;
    last_name: string;
    title: string | null;
    site_id: string;
  }[];
  pool: {
    id: string;
    employee_no: string;
    first_name: string;
    last_name: string;
    pool_region_id: string;
  }[];
}

// ================================================================ Phase 3 (docs/phase3-api.md)
//
// One typed function per route, so a mismatch with the server shows up in one place. Bodies are
// camelCase; rows keep the shapes the routes document.

const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

/** A 202 answer: the worker runs the check or test; poll `testsApi.get`. */
export interface TestStarted {
  testId: string;
}

/** A check or test send run by the worker (`GET /api/admin/tests/:id`). */
export interface TestRun {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'ok' | 'failed';
  result: {
    summary: string;
    facts?: Record<string, string>;
    warnings?: string[];
    target?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
  } | null;
  createdAt: string;
  finishedAt: string | null;
}

export const testsApi = {
  get: (id: string) => api<TestRun>(`/admin/tests/${enc(id)}`),
};

// ---------------------------------------------------------------- connections (admin)

export interface ConnectionRow {
  id: string;
  name: string;
  kind: ConnectionKind;
  /** Non-secret settings, as `connectionConfigSchemas[kind]` describes them. */
  config: Record<string, unknown>;
  /** Names of the secrets that are set. Values never leave the server. */
  secretKeys: string[];
  secretExpiresOn: string | null;
  revision?: number;
  lastCheck: { at: string; ok: boolean | null; detail: string | null } | null;
  /** Destinations using it. */
  destinations: number;
  archivedAt: string | null;
}

export interface ConnectionDetail extends ConnectionRow {
  revisions: {
    revision: number;
    createdAt: string;
    createdBy: string | null;
    secretsReset: boolean;
    archived?: boolean;
  }[];
}

export interface ConnectionCreate {
  name: string;
  kind: ConnectionKind;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  secretExpiresOn?: string | null;
}

export interface ConnectionPatch {
  name?: string;
  config?: Record<string, unknown>;
  /** Left out: the stored secrets are kept. `""` clears a key. */
  secrets?: Record<string, string>;
  secretExpiresOn?: string | null;
  archived?: boolean;
}

export const connectionsApi = {
  list: (kind?: ConnectionKind) => api<ConnectionRow[]>(`/admin/connections${qs({ kind })}`),
  get: (id: string) => api<ConnectionDetail>(`/admin/connections/${enc(id)}`),
  /** A webhook signing secret left empty comes back once in `generated`. */
  create: (body: ConnectionCreate) =>
    api<{ id: string; generated?: { signingSecret: string } }>('/admin/connections', {
      method: 'POST',
      body,
    }),
  /** `secretsReset`: a binding field changed and every secret was cleared. */
  update: (id: string, body: ConnectionPatch) =>
    api<{ secretsReset: boolean; generated?: { signingSecret: string } }>(
      `/admin/connections/${enc(id)}`,
      { method: 'PATCH', body },
    ),
  check: (id: string) =>
    api<TestStarted>(`/admin/connections/${enc(id)}/check`, { method: 'POST', body: {} }),
  /** Checks unsaved settings; the secrets typed are sealed to the test row, never stored. */
  checkDraft: (body: {
    kind: ConnectionKind;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
  }) => api<TestStarted>('/admin/connection-checks', { method: 'POST', body }),
};

// ---------------------------------------------------------------- destinations (admin)

export interface DestinationHealth {
  failingSince: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  last24h: { delivered: number; failed: number; pending: number } | null;
}

export interface DestinationRow {
  id: string;
  formId?: string;
  name: string;
  kind: DestinationKind;
  connectionId: string | null;
  connectionName: string | null;
  formats: Format[];
  templates: Partial<Record<Format, string>>;
  condition: string | null;
  settings: Record<string, unknown>;
  include: Partial<DestinationInclude>;
  recipient: string | null;
  crossBorder: boolean;
  active: boolean;
  revision: number;
  health: DestinationHealth;
  archivedAt: string | null;
}

export interface DestinationDetail extends DestinationRow {
  revisions: { revision: number; createdAt: string; createdBy: string | null }[];
}

export interface DestinationBody {
  name: string;
  kind: DestinationKind;
  connectionId?: string | null;
  formats: Format[];
  templates: Partial<Record<Format, string>>;
  condition?: string | null;
  settings: Record<string, unknown>;
  include: DestinationInclude;
  recipient?: string | null;
  crossBorder: boolean;
  /** Needed (and audited) when personal fields go outside South Africa. */
  confirmCrossBorder?: boolean;
  active: boolean;
  /** Also send submissions received since this date (YYYY-MM-DD, SAST). */
  backfillSince?: string;
}

/** A destination's kind never changes, so a patch leaves it out. */
export type DestinationPatch = Partial<Omit<DestinationBody, 'kind'>>;

export interface Backfilled {
  created: number;
  skipped: number;
  existing: number;
}

export type BackfillBody = (
  | { submissionIds: string[] }
  | { from: string; to: string; siteId?: string }
) & { ignoreCondition?: boolean };

export const destinationsApi = {
  list: (formId: string) => api<DestinationRow[]>(`/admin/forms/${enc(formId)}/destinations`),
  get: (id: string) => api<DestinationDetail>(`/admin/destinations/${enc(id)}`),
  create: (formId: string, body: DestinationBody) =>
    api<{ id: string; warnings: string[]; backfilled?: Backfilled }>(
      `/admin/forms/${enc(formId)}/destinations`,
      { method: 'POST', body },
    ),
  update: (id: string, body: DestinationPatch) =>
    api<{ warnings: string[]; cancelled?: number; backfilled?: Backfilled }>(
      `/admin/destinations/${enc(id)}`,
      { method: 'PATCH', body },
    ),
  archive: (id: string) =>
    api<{ cancelled: number }>(`/admin/destinations/${enc(id)}/archive`, { method: 'POST' }),
  check: (id: string) =>
    api<TestStarted>(`/admin/destinations/${enc(id)}/check`, { method: 'POST', body: {} }),
  /** No submission: a generated sample. A real submission is personal data (audited). */
  testSend: (id: string, submissionId?: string) =>
    api<TestStarted>(`/admin/destinations/${enc(id)}/test`, {
      method: 'POST',
      body: submissionId ? { submissionId } : {},
    }),
  backfill: (id: string, body: BackfillBody) =>
    api<Backfilled>(`/admin/destinations/${enc(id)}/backfill`, { method: 'POST', body }),
  resendFailed: (id: string) =>
    api<{ resent: number }>(`/admin/destinations/${enc(id)}/resend-failed`, { method: 'POST' }),
};

// ---------------------------------------------------------------- templates (admin)

export const HTML_TYPE = 'text/html';
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** The server refuses template files above this. */
export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;

export interface TemplateRow {
  id: string;
  name: string;
  kind: TemplateKind;
  formIds: string[];
  latest: { version: number; createdAt: string; warnings: string[] } | null;
  archivedAt: string | null;
}

export interface TemplateVersion {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string | null;
  placeholders: string[];
  warnings: string[];
}

export interface TemplateDetail {
  id: string;
  name: string;
  kind: TemplateKind;
  formIds: string[];
  archivedAt?: string | null;
  versions: TemplateVersion[];
  usedBy: { destinationId: string; name: string; formId: string }[];
}

export interface Placeholder {
  name: string;
  label: string;
  kind: 'field' | 'group' | 'photo' | 'reserved';
  sample: string | null;
}

export const templatesApi = {
  list: (formId?: string) => api<TemplateRow[]>(`/admin/templates${qs({ formId })}`),
  create: (body: { name: string; kind: TemplateKind; formIds: string[] }) =>
    api<{ id: string }>('/admin/templates', { method: 'POST', body }),
  get: (id: string) => api<TemplateDetail>(`/admin/templates/${enc(id)}`),
  update: (id: string, body: { name?: string; formIds?: string[]; archived?: boolean }) =>
    api<{ ok: boolean }>(`/admin/templates/${enc(id)}`, { method: 'PATCH', body }),
  /** A raw body: the HTML text, or the Word file with its own content type. */
  saveContent: (id: string, body: Blob | string, contentType: string) =>
    apiUpload<{ version: number; warnings: string[] }>(
      `/admin/templates/${enc(id)}/content`,
      body,
      contentType,
    ),
  versionContent: (id: string, version: number) =>
    fetchFile(`/admin/templates/${enc(id)}/versions/${version}/content`, {
      fallbackName: `template-v${version}`,
    }),
  /** No submission: a sample. A real submission is audited. */
  preview: (id: string, body: { format: Format; version?: number; submissionId?: string }) =>
    fetchFile(`/admin/templates/${enc(id)}/preview`, {
      method: 'POST',
      body,
      fallbackName: `preview.${body.format}`,
    }),
  starter: (formId: string, kind: TemplateKind) =>
    fetchFile(`/admin/forms/${enc(formId)}/starter-template${qs({ kind })}`, {
      fallbackName: `starter.${kind}`,
    }),
  placeholders: (formId: string) => api<Placeholder[]>(`/admin/forms/${enc(formId)}/placeholders`),
  /** The templates in-app downloads use per format (null: the built-in layout). */
  setDocumentTemplates: (formId: string, body: { pdf?: string | null; docx?: string | null }) =>
    api<{ ok: boolean }>(`/admin/forms/${enc(formId)}/document-templates`, {
      method: 'PUT',
      body,
    }),
};

// ---------------------------------------------------------------- branding and settings (admin)

export interface CompanyRow {
  id: string;
  name: string;
  report_recipients: string[];
  deactivated_at: string | null;
  brand_colour?: string | null;
  logo_blob_id?: string | null;
  document_footer?: string | null;
}

export interface BrandingPatch {
  brandColour?: string | null;
  logoBlobId?: string | null;
  documentFooter?: string | null;
}

export const brandingApi = {
  setCompany: (id: string, body: BrandingPatch) =>
    api<CompanyRow>(`/admin/companies/${enc(id)}`, { method: 'PATCH', body }),
  /** Uploads a logo as a blob (raw bytes, its own type) and returns the new blob id. */
  uploadLogo: async (file: Blob): Promise<string> => {
    const id = crypto.randomUUID();
    await apiUpload(`/blobs/${id}`, file, file.type || 'application/octet-stream');
    return id;
  },
};

export const settingsApi = {
  get: () => api<Settings>('/admin/settings'),
  save: (body: Partial<Settings>) => api<Settings>('/admin/settings', { method: 'PUT', body }),
};

// ---------------------------------------------------------------- deliveries (admins, managers)

export interface DeliveryRow {
  id: string;
  submissionId: string;
  formName: string;
  siteName: string | null;
  destinationId: string;
  destinationName: string;
  kind: DestinationKind;
  status: DeliveryStatus;
  generation: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  /** Admins only: the redacted technical detail. */
  lastError?: string | null;
  errorClass: string | null;
  /** Plain language, for everyone. */
  errorText: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface DeliveryDocument {
  name?: string;
  filename?: string;
  format?: string;
  contentType?: string;
  size?: number;
  sha256?: string;
}

export interface DeliveryAttempt {
  generation: number;
  attemptNo: number;
  outcome: AttemptOutcome;
  /** The rest are admins only. */
  detail?: string | null;
  target?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
  documents?: DeliveryDocument[] | null;
  startedAt: string | null;
  finishedAt: string | null;
  triggeredBy: string | null;
}

export interface DeliveryDetail extends DeliveryRow {
  attempts: DeliveryAttempt[];
}

export interface DeliverySummary {
  byStatus: Partial<Record<DeliveryStatus, number>>;
  /** Admins only (empty for managers). */
  destinations: {
    id: string;
    name: string;
    formName: string;
    kind: DestinationKind;
    active: boolean;
    failingSince: string | null;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    last24h: { delivered: number; failed: number; pending: number } | null;
  }[];
  errors: { errorClass: string | null; errorText: string | null; count: number }[];
}

export interface DeliveryFilters {
  status?: DeliveryStatus | '';
  formId?: string;
  destinationId?: string;
  /** YYYY-MM-DD, SAST, inclusive. */
  from?: string;
  to?: string;
  errorClass?: string;
  limit?: number;
  cursor?: string | null;
}

export interface SubmissionDelivery {
  id: string;
  destinationName: string;
  kind: DestinationKind;
  status: DeliveryStatus;
  deliveredAt: string | null;
  errorText: string | null;
  generation?: number;
  attemptCount?: number;
}

/** A Phase 1 register email or Phase 2 task email that gave up (admins). */
export interface SystemEmail {
  kind: 'register' | 'task';
  subjectId: string;
  title: string | null;
  detail: string | null;
  failures?: number;
  lastAt?: string;
  createdAt?: string;
  id?: string;
}

export const deliveriesApi = {
  list: (f: DeliveryFilters = {}) =>
    api<{ rows: DeliveryRow[]; next: string | null }>(
      `/deliveries${qs({
        status: f.status,
        formId: f.formId,
        destinationId: f.destinationId,
        from: f.from,
        to: f.to,
        errorClass: f.errorClass,
        limit: f.limit,
        cursor: f.cursor,
      })}`,
    ),
  summary: () => api<DeliverySummary>('/deliveries/summary'),
  get: (id: string) => api<DeliveryDetail>(`/deliveries/${enc(id)}`),
  /** A new generation with the destination's current settings. */
  resend: (id: string) =>
    api<{ resent?: boolean; generation?: number; reason?: string }>(
      `/deliveries/${enc(id)}/resend`,
      { method: 'POST' },
    ),
  retryNow: (id: string) => api<{ ok: boolean }>(`/deliveries/${enc(id)}/retry-now`, { method: 'POST' }),
  resendMany: (ids: string[]) =>
    api<{ resent: number; skipped: unknown }>('/deliveries/resend', {
      method: 'POST',
      body: { ids },
    }),
  forSubmission: (submissionId: string) =>
    api<SubmissionDelivery[]>(`/form-submissions/${enc(submissionId)}/deliveries`),
  systemEmails: () => api<SystemEmail[]>('/system-emails?status=failed'),
  resendSystemEmail: (kind: SystemEmail['kind'], subjectId: string) =>
    api<{ ok: boolean }>(`/system-emails/${enc(kind)}/${enc(subjectId)}/resend`, {
      method: 'POST',
    }),
};

/** A submission as a document (audited as a view). `images` is a ZIP of photos and signatures. */
export const documentsApi = {
  download: (submissionId: string, format: Format, templateId?: string) =>
    fetchFile(`/form-submissions/${enc(submissionId)}/document${qs({ format, templateId })}`, {
      fallbackName: `submission-${submissionId.slice(0, 8)}.${format === 'images' ? 'zip' : format}`,
    }),
};

// ---------------------------------------------------------------- API keys (admin)

export type SiteScopeType = 'company' | 'region' | 'site';

export interface ApiKeyRow {
  id: string;
  name: string;
  /** The `ff_<prefix>_` part, shown so a key can be recognised. */
  prefix: string;
  scopes: ApiScope[];
  allSites: boolean;
  siteScopes: { type: SiteScopeType; id: string; name: string | null }[];
  /** Null or empty: every form. */
  formIds: string[] | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyBody {
  name: string;
  scopes: ApiScope[];
  allSites: boolean;
  siteScopes: { type: SiteScopeType; id: string }[];
  formIds?: string[] | null;
  /** An instant (end of the chosen day, SAST), or null for no expiry. */
  expiresAt?: string | null;
}

export const apiKeysApi = {
  list: () => api<ApiKeyRow[]>('/admin/api-keys'),
  /** The key comes back once and is never shown again. */
  create: (body: ApiKeyBody) =>
    api<{ id: string; key: string }>('/admin/api-keys', { method: 'POST', body }),
  update: (id: string, body: Partial<ApiKeyBody>) =>
    api<{ ok: boolean }>(`/admin/api-keys/${enc(id)}`, { method: 'PATCH', body }),
  revoke: (id: string) =>
    api<{ ok: boolean }>(`/admin/api-keys/${enc(id)}/revoke`, { method: 'POST' }),
};

export const OPENAPI_URL = '/api/v1/openapi.json';

// ---------------------------------------------------------------- forms (admin), as Phase 3 uses them

export interface AdminFormRow {
  id: string;
  name: string;
  archived_at: string | null;
  draft_updated_at: string;
  latest_version: number | null;
  published_at: string | null;
  submissions: number;
}

export interface AdminFormDetail {
  form: {
    id: string;
    name: string;
    archived_at: string | null;
    /** The form's default template per format, when the server includes it. */
    document_templates?: Partial<Record<Format, string>> | null;
  };
  draft: FormDefinition;
  issues: { path: string; message: string }[];
  versions: { id: string; version: number; published_at: string; published_by: string | null }[];
}

export const adminFormsApi = {
  list: () => api<AdminFormRow[]>('/admin/forms'),
  get: (id: string) => api<AdminFormDetail>(`/admin/forms/${enc(id)}`),
};

/** A recent submission of a form, to pick for a test send or a preview. */
export interface SubmissionPick {
  id: string;
  form_id: string;
  site_name: string | null;
  submitted_by_name: string | null;
  server_received_at: string;
}

export const submissionsApi = {
  recent: (formId: string, from: string, to: string) =>
    api<SubmissionPick[]>(`/form-submissions${qs({ formId, from, to })}`),
};
