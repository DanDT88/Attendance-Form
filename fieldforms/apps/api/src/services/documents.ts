import { createHash } from 'node:crypto';
import {
  buildDocumentModel,
  DEFAULT_SETTINGS,
  type Answers,
  type DestinationInclude,
  type DocumentMeta,
  type DocumentModel,
  type Format,
  type FormDefinition,
  type Option,
} from '@fieldforms/shared';
import { zipSync, type ZipOptions } from 'fflate';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../lib/blobstore.js';
import { createMediaLoader } from '../outputs/media.js';
import { RENDERERS } from '../outputs/renderers/index.js';
import { sampleAnswers } from '../outputs/sample.js';
import {
  RENDERER_VERSION,
  type MediaLoader,
  type PdfConverter,
  type RenderedFile,
  type TemplateRef,
} from '../outputs/types.js';
import { formVersions } from './deliveries.js';
import { listItems, listsUsed } from './forms.js';
import { getSettings } from './settings.js';

/** The canonical JSON body (schema "fieldforms.submission/1"), also served by /api/v1. */
export { submissionJson } from '../outputs/renderers/json.js';

export interface DocumentDeps {
  db: Db;
  blobs: BlobStore;
  pdf: PdfConverter;
  publicUrl: string;
  /**
   * A media loader shared by the formats of one delivery or download, so each photo is
   * composited once. A new one is made per call when it is not given.
   */
  media?: MediaLoader;
}

export interface LoadedSubmission {
  model: DocumentModel;
  /** The submission's own version. */
  definition: FormDefinition;
  /** Every published version of the form (for `knownIds` and checks). */
  versions: { version: number; definition: FormDefinition }[];
  lists: Record<string, Option[]>;
  /** The stored answers before filtering, for expressions. */
  answers: Record<string, unknown>;
  /** As stored, for scope checks. */
  siteId: string | null;
  submittedBy: string | null;
  dispatchId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Where JSON and XML point for files: the public API under the app's own address. */
export const apiBaseFor = (publicUrl: string) => `${trimSlash(publicUrl)}/api/v1`;

/** The branding of documents without a site (and the colour of companies that set none). */
export async function defaultBranding(db: Db): Promise<DocumentMeta['branding']> {
  const s = await getSettings(db);
  return { name: s.brandName, colour: s.brandColour, logoBlobId: null, footer: '' };
}

/**
 * Loads a stored submission and builds its document model with `include` applied: the version's
 * definition, option lists, site/region/company names, submitter, task title, the company's
 * branding (settings defaults without a site) and the in-app URL.
 */
export async function loadSubmission(
  db: Db,
  submissionId: string,
  include: DestinationInclude,
  publicUrl: string,
): Promise<LoadedSubmission | null> {
  if (!UUID.test(submissionId)) return null;
  const row = await db
    .selectFrom('form_submissions as s')
    .innerJoin('form_versions as v', 'v.id', 's.form_version_id')
    .innerJoin('forms as f', 'f.id', 's.form_id')
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
      's.submitted_by',
      's.dispatch_id',
      'v.id as version_id',
      'v.version',
      'v.definition',
      'f.name as form_name',
      'st.name as site',
      'r.name as region',
      'c.name as company',
      'c.brand_colour',
      'c.logo_blob_id',
      'c.document_footer',
      'u.display_name as submitter_name',
      'd.title as task_title',
    ])
    .where('s.id', '=', submissionId)
    .executeTakeFirst();
  if (!row) return null;

  const definition = row.definition as FormDefinition;
  const answers = row.data as Answers;
  const [versions, lists] = await Promise.all([
    formVersions(db, row.form_id),
    listItems(db, listsUsed([definition])),
  ]);
  // A company's own colour, logo and footer; settings fill in what it does not set.
  const fallback = row.company && row.brand_colour ? null : await defaultBranding(db);
  const branding: DocumentMeta['branding'] = row.company
    ? {
        name: row.company,
        colour: row.brand_colour ?? fallback!.colour,
        logoBlobId: row.logo_blob_id,
        footer: row.document_footer ?? '',
      }
    : fallback!;

  const model = buildDocumentModel(
    definition,
    answers,
    {
      form: {
        id: row.form_id,
        name: row.form_name,
        version: row.version,
        versionId: row.version_id,
      },
      submission: {
        id: row.id,
        receivedAt: row.server_received_at,
        capturedAt: row.device_captured_at,
        clockSkewFlag: row.clock_skew_flag,
        siteId: row.site_id,
        site: row.site ?? '',
        region: row.region ?? '',
        company: row.company ?? '',
        submittedBy: row.submitter_name ?? '',
        taskTitle: row.task_title ?? '',
        url: `${trimSlash(publicUrl)}/submissions/${row.id}`,
      },
      branding,
    },
    { include, lists },
  );
  return {
    model,
    definition,
    versions,
    lists,
    answers,
    siteId: row.site_id,
    submittedBy: row.submitted_by,
    dispatchId: row.dispatch_id,
  };
}

/**
 * The latest version of a template, or a given version. Null when the template is archived or
 * missing, or has no such version.
 */
export async function loadTemplate(
  db: Db,
  templateId: string,
  versionId?: string,
): Promise<TemplateRef | null> {
  if (!UUID.test(templateId) || (versionId !== undefined && !UUID.test(versionId))) return null;
  const t = await db
    .selectFrom('output_templates')
    .select(['id', 'kind', 'archived_at'])
    .where('id', '=', templateId)
    .executeTakeFirst();
  if (!t || t.archived_at) return null;
  let q = db
    .selectFrom('output_template_versions')
    .select(['id', 'version', 'content_text', 'content_bytes'])
    .where('template_id', '=', templateId);
  q = versionId ? q.where('id', '=', versionId) : q.orderBy('version', 'desc').limit(1);
  const v = await q.executeTakeFirst();
  if (!v) return null;
  const content = t.kind === 'html' ? v.content_text : v.content_bytes;
  if (content === null) return null;
  return { templateId: t.id, versionId: v.id, version: v.version, kind: t.kind, content };
}

/**
 * The cache key of a rendering: the submission, format, template version, what is included and
 * the renderers' version. The field list is sorted, since its order does not change the output.
 */
export function renderCacheKey(input: {
  submissionId: string;
  format: Format;
  templateVersionId: string | null;
  include: DestinationInclude;
}): string {
  const i = input.include;
  return sha256(
    JSON.stringify({
      submissionId: input.submissionId,
      format: input.format,
      templateVersionId: input.templateVersionId,
      include: {
        fields: i.fields === 'all' ? 'all' : [...i.fields].sort(),
        photos: i.photos,
        signatures: i.signatures,
        location: i.location,
        submitter: i.submitter,
      },
      RENDERER_VERSION,
    }),
  );
}

/** One file of a cached rendering, as `rendered_documents.files` holds it. */
interface CachedFile {
  filename: string;
  /** The name after the stem, so a destination with another file-name template reuses it. */
  suffix: string | null;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
}

const STORAGE_KEY = /^rendered\/[0-9a-f]{64}$/;

async function fromCache(deps: DocumentDeps, key: string, stem: string) {
  const row = await deps.db
    .selectFrom('rendered_documents')
    .select('files')
    .where('cache_key', '=', key)
    .executeTakeFirst();
  if (!row || !Array.isArray(row.files)) return null;
  const files: RenderedFile[] = [];
  for (const e of row.files as CachedFile[]) {
    if (!STORAGE_KEY.test(e.storageKey)) return null;
    const data = await deps.blobs.get(e.storageKey).catch(() => null);
    // A missing or damaged copy is rendered again rather than sent.
    if (!data || sha256(data) !== e.sha256) return null;
    files.push({
      filename: e.suffix !== null ? `${stem}${e.suffix}` : e.filename,
      contentType: e.contentType,
      data,
    });
  }
  return files;
}

async function toCache(
  deps: DocumentDeps,
  key: string,
  input: { submissionId: string; format: Format; template: TemplateRef | null; stem: string },
  files: RenderedFile[],
): Promise<void> {
  const entries: CachedFile[] = [];
  for (const f of files) {
    const hash = sha256(f.data);
    const storageKey = `rendered/${hash}`;
    await deps.blobs.put(storageKey, f.data, f.contentType);
    entries.push({
      filename: f.filename,
      suffix: f.filename.startsWith(input.stem) ? f.filename.slice(input.stem.length) : null,
      contentType: f.contentType,
      size: f.data.length,
      sha256: hash,
      storageKey,
    });
  }
  await deps.db
    .insertInto('rendered_documents')
    .values({
      cache_key: key,
      submission_id: input.submissionId,
      format: input.format,
      template_version_id: input.template?.versionId ?? null,
      files: JSON.stringify(entries),
    })
    .onConflict((oc) => oc.column('cache_key').doNothing())
    .execute();
}

/**
 * Renders one format, reusing a cached rendering (rendered_documents + blob store) keyed by the
 * submission, format, template version, include settings and RENDERER_VERSION. `stem` is the
 * safe file name without extension. Samples (no submission id) are never cached.
 */
export async function renderFormat(
  deps: DocumentDeps,
  input: {
    submissionId: string | null;
    model: DocumentModel;
    include: DestinationInclude;
    format: Format;
    template: TemplateRef | null;
    stem: string;
    signal: AbortSignal;
  },
): Promise<{ files: RenderedFile[]; cached: boolean }> {
  const key = input.submissionId
    ? renderCacheKey({
        submissionId: input.submissionId,
        format: input.format,
        templateVersionId: input.template?.versionId ?? null,
        include: input.include,
      })
    : null;
  if (key) {
    const hit = await fromCache(deps, key, input.stem);
    if (hit) return { files: hit, cached: true };
  }
  const files = await RENDERERS[input.format].render(input.model, input.template, input.stem, {
    media: deps.media ?? createMediaLoader(deps.db, deps.blobs),
    pdf: deps.pdf,
    signal: input.signal,
    apiBase: apiBaseFor(deps.publicUrl),
  });
  if (key && input.submissionId) {
    try {
      await toCache(deps, key, { ...input, submissionId: input.submissionId }, files);
    } catch {
      // The documents are good; without a cached copy the next use renders them again.
    }
  }
  return { files, cached: false };
}

/** Already compressed: stored as they are. */
const STORED = /^(image\/(jpeg|png|webp)|application\/(pdf|zip)|application\/vnd\.openxmlformats)/;

/** Several files as one ZIP (the `images` format downloads this way). Duplicate names get " (2)". */
export function zipFiles(files: RenderedFile[], name: string): RenderedFile {
  const entries: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const f of files) {
    let filename = f.filename;
    for (let n = 2; filename in entries; n++)
      filename = f.filename.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    entries[filename] = [
      new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength),
      { level: STORED.test(f.contentType) ? 0 : 6 },
    ];
  }
  return {
    filename: name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`,
    contentType: 'application/zip',
    data: Buffer.from(zipSync(entries)),
  };
}

/** The id samples carry; its short id (00000000) marks sample file names. */
export const SAMPLE_SUBMISSION_ID = '00000000-0000-4000-8000-000000000000';

/**
 * A generated submission for test sends and template previews: plausible answers with
 * placeholder photos, "Sample site", no personal data, `submission.sample` set. Branding is the
 * settings default unless given.
 */
export function sampleSubmission(
  def: FormDefinition,
  form: { id: string; name: string; version?: number; versionId?: string },
  include: DestinationInclude,
  now: Date,
  opts: {
    lists?: Record<string, Option[]>;
    branding?: DocumentMeta['branding'];
    publicUrl?: string;
  } = {},
): DocumentModel {
  return buildDocumentModel(
    def,
    sampleAnswers(def, now, opts.lists),
    {
      form: {
        id: form.id,
        name: form.name,
        version: form.version ?? 0,
        versionId: form.versionId ?? '',
      },
      submission: {
        id: SAMPLE_SUBMISSION_ID,
        receivedAt: now,
        capturedAt: now,
        clockSkewFlag: false,
        siteId: null,
        site: 'Sample site',
        region: 'Sample region',
        company: 'Sample company',
        submittedBy: 'Sample person',
        taskTitle: '',
        url: opts.publicUrl
          ? `${trimSlash(opts.publicUrl)}/submissions/${SAMPLE_SUBMISSION_ID}`
          : '',
        sample: true,
      },
      branding: opts.branding ?? {
        name: DEFAULT_SETTINGS.brandName,
        colour: DEFAULT_SETTINGS.brandColour,
        logoBlobId: null,
        footer: '',
      },
    },
    { include, lists: opts.lists },
  );
}
