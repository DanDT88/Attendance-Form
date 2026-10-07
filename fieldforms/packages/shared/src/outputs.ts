import { z } from 'zod';
import { FIELD_ID } from './forms/definition.js';

/**
 * Phase 3 contract shared by the API, the worker and the admin screens: document formats,
 * templates, connections (shared credentials), destination kinds and their per-form settings,
 * what a destination may include, delivery states and API key scopes.
 * See ARCHITECTURE.md, "Phase 3: outputs and destinations".
 */

// ---------------------------------------------------------------- formats and templates

export const FORMATS = ['pdf', 'docx', 'xlsx', 'json', 'xml', 'images'] as const;
export type Format = (typeof FORMATS)[number];

export const FORMAT_LABELS: Record<Format, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  xlsx: 'Excel (XLSX)',
  json: 'JSON',
  xml: 'XML',
  images: 'Photos and signatures',
};

export const FORMAT_EXTENSIONS: Record<Exclude<Format, 'images'>, string> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  json: 'json',
  xml: 'xml',
};

export const TEMPLATE_KINDS = ['html', 'docx'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
/** Formats each template kind can produce (Word becomes PDF through LibreOffice). */
export const TEMPLATE_FORMATS: Record<TemplateKind, readonly Format[]> = {
  html: ['pdf'],
  docx: ['docx', 'pdf'],
};

// ---------------------------------------------------------------- the vocabulary

/**
 * Names that templates, conditions, column mappings, file names and folders can use besides the
 * form's own field ids. Field ids start with a letter, so these can never clash. In a template a
 * field id gives its display text; in an expression it gives the raw value.
 */
export const RESERVED_VARIABLES = {
  _id: 'Submission id',
  _short_id: 'First 8 characters of the submission id (for unique file names)',
  _form: 'Form name',
  _version: 'Form version number',
  _site: 'Site name',
  _site_id: 'Site id (unchanged when the site is renamed)',
  _region: 'Region name',
  _company: 'Company name',
  _submitted_by: 'Who submitted it (blank unless the destination includes it)',
  _task: 'Task title, if it was a dispatched task',
  _captured: 'When it was filled in, SAST (the server time if the device clock was off)',
  _received: 'When the server received it, SAST',
  _url: 'Link to the submission in FieldForms (sign-in required)',
} as const;
export type ReservedVariable = keyof typeof RESERVED_VARIABLES;
export const RESERVED_NAMES = Object.keys(RESERVED_VARIABLES) as ReservedVariable[];
/** Template-only names: every field in order, and the branding. */
export const TEMPLATE_ONLY_VARIABLES = {
  _fields: 'Every included field in order: label, text, type, rows, photos',
  _branding: 'Company name, colour, logo and document footer',
} as const;

/** Unique per submission, filed by when the work was done. */
export const DEFAULT_FILENAME = '{{ _form }} - {{ _site }} - {{ _captured }} - {{ _short_id }}';

// ---------------------------------------------------------------- connections

export const CONNECTION_KINDS = [
  'webhook',
  'sftp',
  's3',
  'google',
  'microsoft',
  'slack',
  'sql',
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_LABELS: Record<ConnectionKind, string> = {
  webhook: 'Webhook endpoint',
  sftp: 'SFTP server',
  s3: 'Amazon S3 (or compatible)',
  google: 'Google service account (Drive and Sheets)',
  microsoft: 'Microsoft 365 app (OneDrive and SharePoint)',
  slack: 'Slack incoming webhook',
  sql: 'SQL database',
};

const text = (max: number) => z.string().trim().max(max);
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.\-:[\]]+$/, 'A host name or IP address');

export const connectionConfigSchemas = {
  /** The URL itself is a secret (it often carries a token); `urlOrigin` is for display. */
  webhook: z.object({ urlOrigin: text(300).default('') }),
  sftp: z.object({
    host,
    port: z.number().int().min(1).max(65535).default(22),
    username: text(100).min(1),
    /** SHA256 host-key fingerprint as OpenSSH prints it ("SHA256:..."); the check shows it. */
    hostKeySha256: z
      .string()
      .trim()
      .regex(/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/, 'Paste the SHA256 fingerprint'),
  }),
  s3: z.object({
    /** For S3-compatible services; empty for AWS. */
    endpoint: z.string().trim().url().max(500).optional(),
    region: text(40).min(1).default('af-south-1'),
    forcePathStyle: z.boolean().default(false),
  }),
  google: z.object({
    /** Optional user to act as (Google Workspace domain-wide delegation). */
    subject: z.string().trim().toLowerCase().email().max(200).optional(),
  }),
  microsoft: z.object({
    tenantId: z.string().trim().min(1).max(100),
    clientId: z.string().trim().uuid(),
  }),
  slack: z.object({ channelLabel: text(100).default('') }),
  sql: z.object({
    dialect: z.enum(['postgres', 'sqlserver']),
    host,
    port: z.number().int().min(1).max(65535).optional(),
    database: text(128).min(1),
    username: text(128).min(1),
    /** Verify the server certificate (off only for listed private networks). */
    tls: z.enum(['verify', 'off']).default('verify'),
  }),
} satisfies Record<ConnectionKind, z.ZodTypeAny>;

export type ConnectionConfig<K extends ConnectionKind = ConnectionKind> = z.infer<
  (typeof connectionConfigSchemas)[K]
>;

export interface SecretField {
  key: string;
  label: string;
  multiline?: boolean;
  optional?: boolean;
}

/** Secret fields per connection kind. Write-only: the API reports only whether each is set. */
export const CONNECTION_SECRETS: Record<ConnectionKind, SecretField[]> = {
  webhook: [
    { key: 'url', label: 'URL (https://…)' },
    { key: 'signingSecret', label: 'Signing secret (leave empty to generate one)', optional: true },
  ],
  sftp: [
    { key: 'password', label: 'Password', optional: true },
    { key: 'privateKey', label: 'Private key (OpenSSH)', multiline: true, optional: true },
    { key: 'passphrase', label: 'Key passphrase', optional: true },
  ],
  s3: [
    { key: 'accessKeyId', label: 'Access key id' },
    { key: 'secretAccessKey', label: 'Secret access key' },
  ],
  google: [{ key: 'serviceAccountJson', label: 'Service account key (JSON)', multiline: true }],
  microsoft: [{ key: 'clientSecret', label: 'Client secret' }],
  slack: [{ key: 'webhookUrl', label: 'Incoming webhook URL (https://hooks.slack.com/…)' }],
  sql: [{ key: 'password', label: 'Password' }],
};

/**
 * Settings that decide where a connection's secrets are sent. Changing any of them clears the
 * stored secrets, so a password can never be sent to a new server by editing the host.
 */
export const CONNECTION_BINDING_FIELDS: Record<ConnectionKind, string[]> = {
  webhook: [],
  sftp: ['host', 'port', 'username', 'hostKeySha256'],
  s3: ['endpoint', 'region'],
  google: ['subject'],
  microsoft: ['tenantId', 'clientId'],
  slack: [],
  sql: ['dialect', 'host', 'port', 'database', 'username', 'tls'],
};

// ---------------------------------------------------------------- destinations

export const DESTINATION_KINDS = [
  'email',
  'webhook',
  'sftp',
  's3',
  'google_drive',
  'onedrive',
  'slack',
  'sql',
  'google_sheets',
] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const DESTINATION_LABELS: Record<DestinationKind, string> = {
  email: 'Email',
  webhook: 'Webhook (HTTPS POST)',
  sftp: 'SFTP',
  s3: 'Amazon S3 (or compatible)',
  google_drive: 'Google Drive (Shared Drive)',
  onedrive: 'OneDrive / SharePoint',
  slack: 'Slack',
  sql: 'SQL table',
  google_sheets: 'Google Sheets',
};

/** The connection kind each destination kind needs (email uses the server's SMTP settings). */
export const DESTINATION_CONNECTION: Record<DestinationKind, ConnectionKind | null> = {
  email: null,
  webhook: 'webhook',
  sftp: 'sftp',
  s3: 's3',
  google_drive: 'google',
  onedrive: 'microsoft',
  slack: 'slack',
  sql: 'sql',
  google_sheets: 'google',
};

/** Formats a kind can carry, and whether it needs at least one. */
export const KIND_FORMATS: Record<
  DestinationKind,
  { formats: readonly Format[]; required: boolean }
> = {
  email: { formats: FORMATS, required: false },
  webhook: { formats: FORMATS, required: false },
  sftp: { formats: FORMATS, required: true },
  s3: { formats: FORMATS, required: true },
  google_drive: { formats: FORMATS, required: true },
  onedrive: { formats: FORMATS, required: true },
  slack: { formats: [], required: false },
  sql: { formats: [], required: false },
  google_sheets: { formats: [], required: false },
};

const email = z.string().trim().toLowerCase().email().max(200);
const fieldRef = z.string().regex(FIELD_ID, 'A field id');
/** A Liquid template for one line (a file name, a subject). */
const line = (dflt: string) => text(300).default(dflt);
/** A Liquid template for a folder: segments separated by '/', each cleaned when rendered. */
const folder = text(500).default('');
const sqlName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'Lower-case letters, digits and _');
const sqlTable = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/, 'Lower-case letters, digits and _');

/** Where a mapped column's value comes from: a field (its display text) or an expression. */
export const mappingSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('field'), field: z.string().min(1).max(100) }),
  z.object({ type: z.literal('expression'), expression: z.string().trim().min(1).max(2000) }),
]);
export type MappingSource = z.infer<typeof mappingSource>;

export const destinationSettingsSchemas = {
  email: z
    .object({
      recipients: z
        .object({
          addresses: z.array(email).max(50).default([]),
          /** Form fields holding email addresses. */
          fields: z.array(fieldRef).max(10).default([]),
          /** The site's report recipients, else the company's (as Phase 1 registers). */
          siteRecipients: z.boolean().default(false),
          submitter: z.boolean().default(false),
          taskSender: z.boolean().default(false),
          /** Managers whose scope covers the site, with an email. */
          siteManagers: z.boolean().default(false),
        })
        .default({}),
      cc: z.array(email).max(50).default([]),
      replyTo: z.union([z.literal('none'), z.literal('submitter'), email]).default('none'),
      subject: line('{{ _form }}: {{ _site }} {{ _captured }}'),
      /** Text above the answers (Liquid). */
      message: text(5000).default(''),
      /** Put the answers in the email body as well as any attachment. */
      includeAnswers: z.boolean().default(true),
      filename: line(DEFAULT_FILENAME),
    })
    .refine(
      (s) =>
        s.recipients.addresses.length > 0 ||
        s.recipients.fields.length > 0 ||
        s.recipients.siteRecipients ||
        s.recipients.submitter ||
        s.recipients.taskSender ||
        s.recipients.siteManagers,
      'Choose at least one source of recipients',
    ),
  webhook: z.object({
    /** Add the documents (base64) to the JSON body. */
    includeFiles: z.boolean().default(false),
    filename: line(DEFAULT_FILENAME),
  }),
  sftp: z.object({ folder: folder.default('.'), filename: line(DEFAULT_FILENAME) }),
  s3: z.object({
    bucket: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'A bucket name'),
    folder,
    filename: line(DEFAULT_FILENAME),
  }),
  google_drive: z.object({
    /** A folder on a Shared Drive (service accounts cannot store files in My Drive). */
    folderId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{10,100}$/, 'The folder id from its URL'),
    folder,
    filename: line(DEFAULT_FILENAME),
  }),
  onedrive: z.object({
    location: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('site'),
        siteUrl: z.string().trim().url().max(500),
        library: text(200).min(1).default('Documents'),
      }),
      z.object({ type: z.literal('user'), user: email }),
    ]),
    folder: folder.default('FieldForms'),
    filename: line(DEFAULT_FILENAME),
  }),
  slack: z.object({
    message: text(3000).default(
      '*{{ _form }}* from {{ _site }} ({{ _captured }}) <{{ _url }}|Open in FieldForms>',
    ),
  }),
  sql: z.object({
    table: sqlTable,
    columns: z
      .array(z.object({ column: sqlName, source: mappingSource }))
      .min(1)
      .max(100),
    /** The column mapped from `_id` (or `_id` plus the row number with rowsFrom); needs a unique index. */
    keyColumn: sqlName,
    /** `insert` leaves an existing row alone (a resend changes nothing); `upsert` updates it. */
    mode: z.enum(['insert', 'upsert']).default('insert'),
    /** One row per row of this repeat group instead of one per submission. */
    rowsFrom: fieldRef.optional(),
  }),
  google_sheets: z.object({
    spreadsheetId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{20,100}$/, 'The id from its URL'),
    sheetName: text(100).min(1).default('Sheet1'),
    columns: z
      .array(z.object({ header: text(100).min(1), source: mappingSource }))
      .min(1)
      .max(100),
    rowsFrom: fieldRef.optional(),
    /** Append test rows only when asked (a test send otherwise skips the write). */
    testWrites: z.boolean().default(false),
  }),
} satisfies Record<DestinationKind, z.ZodTypeAny>;

export type DestinationSettings<K extends DestinationKind = DestinationKind> = z.infer<
  (typeof destinationSettingsSchemas)[K]
>;

/**
 * POPIA: what a destination may carry. The document model is filtered before rendering, so a
 * template cannot reach anything excluded here.
 */
export const destinationInclude = z.object({
  /** Field ids to include, or 'all' for every field that is not a photo, signature or location. */
  fields: z.union([z.literal('all'), z.array(z.string().regex(FIELD_ID)).max(500)]).default('all'),
  /** Photos: none, with their markup only, or also the untouched original. */
  photos: z.enum(['none', 'marked_up', 'with_originals']).default('marked_up'),
  signatures: z.boolean().default(true),
  /** Geotag fields: none, rounded to about 1 km, or exact. */
  location: z.enum(['none', 'rounded', 'exact']).default('none'),
  /** The name of the person who submitted it. */
  submitter: z.boolean().default(true),
});
export type DestinationInclude = z.infer<typeof destinationInclude>;
/** Everything: in-app downloads by people who may view the submission anyway. */
export const INCLUDE_ALL: DestinationInclude = {
  fields: 'all',
  photos: 'with_originals',
  signatures: true,
  location: 'exact',
  submitter: true,
};

// ---------------------------------------------------------------- deliveries and the API

export const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'delivered',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ATTEMPT_OUTCOMES = [
  'delivered',
  'already_present',
  'retry',
  'failed',
  'skipped',
  'cancelled',
  'abandoned',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Plain-language error classes, what managers see instead of technical detail. */
export const ERROR_CLASSES = {
  credentials: 'The destination rejected the credentials',
  not_found: 'The folder, table or sheet was not found',
  rejected: 'The destination refused the delivery',
  too_large: 'The documents were too large',
  unreachable: 'The destination could not be reached',
  network_policy: 'The destination address is not allowed',
  template: 'A document template has an error',
  settings: 'The destination settings are incomplete or invalid',
  condition: 'The destination condition could not be evaluated',
  conflict: 'A file with that name belongs to another submission',
  internal: 'Something went wrong in FieldForms',
} as const;
export type ErrorClass = keyof typeof ERROR_CLASSES;

export const API_SCOPES = {
  'forms:read': 'Read published forms',
  'submissions:read': 'Read submissions and their documents',
  'files:read': 'Download photos and signatures',
  'attendance:read': 'Read the daily attendance report',
} as const;
export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_KEYS = Object.keys(API_SCOPES) as ApiScope[];
