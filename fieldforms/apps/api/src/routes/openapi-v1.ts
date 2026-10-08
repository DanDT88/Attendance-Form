import { API_SCOPES, FORMATS } from '@fieldforms/shared';
import { DEFAULT_PAGE, MAX_PAGE, SETTLE_SECONDS } from '../services/public-api.js';

/**
 * The OpenAPI 3.1 document of the public REST API, served at /api/v1/openapi.json. Written by
 * hand next to the routes; a test checks that it lists exactly the routes registered and that
 * real responses match its schemas.
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra });
const str = (description?: string, extra: Schema = {}): Schema => ({
  type: 'string',
  ...(description && { description }),
  ...extra,
});
const id = (description: string): Schema => str(description, { format: 'uuid' });

const errors = (...codes: (401 | 403 | 404 | 429 | 400)[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description: {
          400: 'Invalid parameters',
          401: 'Missing, malformed, unknown, revoked or expired key, or its creator was deactivated',
          403: 'The key lacks the scope, or the form or site is outside the key',
          404: 'Not found, or outside the key (existence is not revealed)',
          429: "Over the key's rate limit, or too many failed key attempts from this address",
        }[c],
        content: { 'application/json': { schema: ref('Error') } },
      },
    ]),
  );

const json = (schema: Schema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const pathId = (description: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', format: 'uuid' },
});

const query = (name: string, schema: Schema, description: string) => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

const scoped = (scope: keyof typeof API_SCOPES) => ({
  security: [{ apiKey: [] }],
  'x-required-scope': scope,
});

const schemas: Record<string, Schema> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: { error: str('A safe, human-readable message') },
  },
  Form: {
    type: 'object',
    required: ['id', 'name', 'version', 'versionId', 'publishedAt', 'archivedAt'],
    additionalProperties: false,
    properties: {
      id: id('Form id'),
      name: str(),
      version: { type: 'integer', minimum: 1, description: 'Latest published version' },
      versionId: id('Id of that version'),
      publishedAt: str('When that version was published', { format: 'date-time' }),
      archivedAt: nullable('string', {
        format: 'date-time',
        description: 'Set when the form is no longer filled in; its submissions remain readable',
      }),
    },
  },
  FormVersion: {
    type: 'object',
    required: ['id', 'name', 'version', 'versionId', 'publishedAt', 'definition'],
    additionalProperties: false,
    properties: {
      id: id('Form id'),
      name: str(),
      version: { type: 'integer', minimum: 1 },
      versionId: id('Version id'),
      publishedAt: str(undefined, { format: 'date-time' }),
      definition: {
        type: 'object',
        description:
          'The form definition (schemaVersion, title, settings, fields). Published versions never change.',
      },
    },
  },
  SubmissionFile: {
    type: 'object',
    required: ['name', 'kind', 'path', 'blobId', 'url'],
    additionalProperties: false,
    properties: {
      name: str('File-friendly name: <field>-<n>, or <group>-<row>-<field>-<n> in repeat groups'),
      kind: { type: 'string', enum: ['photo', 'signature'] },
      path: str('Where it sits in the answers, e.g. "items[0].photo[1]"'),
      blobId: nullable('string', { format: 'uuid' }),
      url: nullable('string', {
        format: 'uri',
        description: 'Download with GET /files/{id} (scope files:read)',
      }),
    },
  },
  Submission: {
    type: 'object',
    description:
      'A submission (schema fieldforms.submission/1): every answer and its metadata. Never the device payload or clock evidence.',
    required: ['schema', 'form', 'submission', 'answers', 'labels', 'files'],
    additionalProperties: false,
    properties: {
      schema: { const: 'fieldforms.submission/1' },
      form: {
        type: 'object',
        required: ['id', 'name', 'version'],
        additionalProperties: false,
        properties: {
          id: id('Form id'),
          name: str(),
          version: { type: 'integer', minimum: 1, description: 'The version it was filled in on' },
        },
      },
      submission: {
        type: 'object',
        required: [
          'id',
          'receivedAt',
          'capturedAt',
          'site',
          'siteId',
          'region',
          'company',
          'submittedBy',
          'task',
          'url',
        ],
        additionalProperties: false,
        properties: {
          id: id('Submission id (generated on the device)'),
          receivedAt: str('When the server received it', { format: 'date-time' }),
          capturedAt: nullable('string', {
            format: 'date-time',
            description: "When it was filled in (device time); null if the device didn't say",
          }),
          site: str('Site name; empty when the submission has no site'),
          siteId: nullable('string', { format: 'uuid' }),
          region: str(),
          company: str(),
          submittedBy: str('Display name of the person who submitted it'),
          task: str('Title of the task it answered, or empty'),
          url: str('Link to the submission in FieldForms (sign-in required)', { format: 'uri' }),
          sample: { type: 'boolean', description: 'Only on generated samples' },
        },
      },
      answers: {
        type: 'object',
        description:
          'Answers by field id: numbers, text, option values, dates (YYYY-MM-DD), locations {lat, lng, accuracy}, photos [{name, blobId, annotationBlobId?}], signatures {blobId}, repeat groups as lists of rows. Blank fields are left out.',
        additionalProperties: true,
      },
      labels: {
        type: 'object',
        description: 'Field labels by id ("group.field" for fields in repeat groups)',
        additionalProperties: { type: 'string' },
      },
      files: { type: 'array', items: ref('SubmissionFile') },
    },
  },
  SubmissionPage: {
    type: 'object',
    required: ['data', 'next', 'resume'],
    additionalProperties: false,
    properties: {
      data: { type: 'array', items: ref('Submission') },
      next: nullable('string', {
        description: 'Pass as cursor to get the next page now; null once you have caught up',
      }),
      resume: nullable('string', {
        description:
          'Store this and pass it as cursor on your next poll: it points after the last submission returned (or repeats the cursor you sent when nothing new arrived)',
      }),
    },
  },
  DailyRow: {
    type: 'object',
    required: [
      'workDate',
      'employeeId',
      'employeeNo',
      'employeeName',
      'company',
      'region',
      'site',
      'siteId',
      'shift',
      'firstIn',
      'lastOut',
      'hoursWorked',
      'status',
      'minutesLate',
      'minutesEarly',
      'reasons',
      'replacement',
      'entryIds',
      'submissionIds',
      'flags',
    ],
    additionalProperties: false,
    properties: {
      workDate: str('Work date (a night shift belongs to the date it starts)', { format: 'date' }),
      employeeId: id('Employee id'),
      employeeNo: str(),
      employeeName: str(),
      company: str(),
      region: str(),
      site: str(),
      siteId: id('Site id'),
      shift: nullable('string'),
      firstIn: nullable('string', { format: 'date-time' }),
      lastOut: nullable('string', { format: 'date-time' }),
      hoursWorked: nullable('number'),
      status: {
        type: 'string',
        enum: ['present', 'late', 'absent', 'left_early', 'late_left_early', 'unknown'],
      },
      minutesLate: nullable('number'),
      minutesEarly: nullable('number'),
      reasons: { type: 'array', items: { type: 'string' } },
      replacement: nullable('string', { description: 'Who stood in for an absent employee' }),
      entryIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      submissionIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Attendance registers the row was built from',
      },
      flags: {
        type: 'object',
        additionalProperties: false,
        required: [
          'missingIn',
          'missingOut',
          'absent',
          'late',
          'leftEarly',
          'clockSkew',
          'syncDelay',
          'outsideGeofence',
          'outsideShiftTime',
          'corrected',
          'legacy',
        ],
        properties: Object.fromEntries(
          [
            'missingIn',
            'missingOut',
            'absent',
            'late',
            'leftEarly',
            'clockSkew',
            'syncDelay',
            'outsideGeofence',
            'outsideShiftTime',
            'corrected',
            'legacy',
          ].map((k) => [k, { type: 'boolean' }]),
        ),
      },
    },
  },
  DailyReport: {
    type: 'object',
    required: ['filter', 'rows'],
    additionalProperties: false,
    properties: {
      filter: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: str(undefined, { format: 'date' }),
          to: str(undefined, { format: 'date' }),
          siteId: id('Site id'),
        },
      },
      rows: { type: 'array', items: ref('DailyRow') },
    },
  },
};

const scopeList = Object.entries(API_SCOPES)
  .map(([k, v]) => `\`${k}\` (${v.toLowerCase()})`)
  .join(', ');

/** The document, with the server URL taken from the app's public address. */
export function openApiV1(publicUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'FieldForms API',
      version: '1',
      description: [
        'Read-only access to published forms, submissions (with their documents, photos and signatures) and the daily attendance report.',
        '',
        `Authenticate with \`Authorization: Bearer ff_…\`. An administrator creates keys in FieldForms with a name, scopes (${scopeList}), the companies, regions or sites it covers (or all sites), optionally a list of forms, and optionally an expiry. A key sees what a manager with the same site scope would see; submissions without a site are visible only to all-sites keys. Every call is recorded in the audit log against the key.`,
        '',
        'Requests are rate limited per key and endpoint (429 with Retry-After). Too many failed key attempts from one address are refused for a minute.',
        '',
        `To keep another system in sync, poll GET /submissions with the \`resume\` cursor of your last call; it needs no inbound firewall rule. Submissions are listed in the order the server received them, and the newest ${SETTLE_SECONDS} seconds are held back so a cursor never skips one that is still being saved.`,
      ].join('\n'),
    },
    servers: [{ url: `${publicUrl.replace(/\/+$/, '')}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'forms', description: 'Scope forms:read' },
      { name: 'submissions', description: 'Scope submissions:read' },
      { name: 'files', description: 'Scope files:read' },
      { name: 'attendance', description: 'Scope attendance:read' },
    ],
    paths: {
      '/forms': {
        get: {
          operationId: 'listForms',
          tags: ['forms'],
          summary: 'Published forms (latest version of each)',
          ...scoped('forms:read'),
          responses: {
            200: json({ type: 'array', items: ref('Form') }, 'Forms the key may read, by name'),
            ...errors(401, 403, 429),
          },
        },
      },
      '/forms/{id}/versions/{version}': {
        get: {
          operationId: 'getFormVersion',
          tags: ['forms'],
          summary: "A published version's definition",
          ...scoped('forms:read'),
          parameters: [
            pathId('Form id'),
            {
              name: 'version',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 1 },
            },
          ],
          responses: {
            200: json(ref('FormVersion'), 'The version'),
            ...errors(400, 401, 403, 404, 429),
          },
        },
      },
      '/submissions': {
        get: {
          operationId: 'listSubmissions',
          tags: ['submissions'],
          summary: 'Submissions in received order, a page at a time',
          ...scoped('submissions:read'),
          parameters: [
            query('formId', { type: 'string', format: 'uuid' }, 'Only this form'),
            query('siteId', { type: 'string', format: 'uuid' }, 'Only this site'),
            query(
              'since',
              { type: 'string', format: 'date-time' },
              'Received at or after this instant',
            ),
            query('until', { type: 'string', format: 'date-time' }, 'Received before this instant'),
            query('cursor', { type: 'string' }, 'The next or resume value of an earlier page'),
            query(
              'limit',
              { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE },
              'Page size',
            ),
          ],
          responses: {
            200: json(ref('SubmissionPage'), 'A page'),
            ...errors(400, 401, 403, 429),
          },
        },
      },
      '/submissions/{id}': {
        get: {
          operationId: 'getSubmission',
          tags: ['submissions'],
          summary: 'One submission',
          ...scoped('submissions:read'),
          parameters: [pathId('Submission id')],
          responses: {
            200: json(ref('Submission'), 'The submission'),
            ...errors(400, 401, 403, 404, 429),
          },
        },
      },
      '/submissions/{id}/document': {
        get: {
          operationId: 'getSubmissionDocument',
          tags: ['submissions'],
          summary: 'A submission as a document',
          description:
            "Uses the form's default template for the format when it has one, else the built-in layout. `images` is a ZIP of every photo (with its markup drawn in, plus the original) and signature.",
          ...scoped('submissions:read'),
          parameters: [
            pathId('Submission id'),
            {
              name: 'format',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: [...FORMATS] },
            },
          ],
          responses: {
            200: {
              description: 'The file, as an attachment',
              content: Object.fromEntries(
                [
                  'application/pdf',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/json',
                  'application/xml',
                  'application/zip',
                ].map((t) => [t, { schema: { type: 'string', format: 'binary' } }]),
              ),
            },
            ...errors(400, 401, 403, 404, 429),
          },
        },
      },
      '/files/{id}': {
        get: {
          operationId: 'getFile',
          tags: ['files'],
          summary: 'A photo, markup layer or signature of a submission the key can see',
          ...scoped('files:read'),
          parameters: [pathId('The blobId from a submission')],
          responses: {
            200: {
              description: 'The image',
              content: Object.fromEntries(
                ['image/jpeg', 'image/png', 'image/webp'].map((t) => [
                  t,
                  { schema: { type: 'string', format: 'binary' } },
                ]),
              ),
            },
            ...errors(400, 401, 403, 404, 429),
          },
        },
      },
      '/attendance/daily': {
        get: {
          operationId: 'getDailyAttendance',
          tags: ['attendance'],
          summary: 'The daily attendance report: one row per employee per work date',
          ...scoped('attendance:read'),
          parameters: [
            {
              name: 'from',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'date' },
            },
            {
              name: 'to',
              in: 'query',
              required: true,
              description: 'At most 366 days after from',
              schema: { type: 'string', format: 'date' },
            },
            query('siteId', { type: 'string', format: 'uuid' }, 'Only this site'),
          ],
          responses: {
            200: json(ref('DailyReport'), "Rows for the key's sites, newest date first"),
            ...errors(400, 401, 403, 429),
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          summary: 'This document',
          security: [],
          responses: { 200: json({ type: 'object' }, 'The OpenAPI document') },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'ff_<prefix>_<secret>',
          description: 'An API key created by a FieldForms administrator, shown once.',
        },
      },
      schemas,
    },
  };
}
