import type {
  DestinationInclude,
  DocumentModel,
  Format,
  FormDefinition,
  Option,
} from '@fieldforms/shared';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../lib/blobstore.js';
import type { PdfConverter, RenderedFile, TemplateRef } from '../outputs/types.js';

export interface DocumentDeps {
  db: Db;
  blobs: BlobStore;
  pdf: PdfConverter;
  publicUrl: string;
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

/**
 * Loads a stored submission and builds its document model with `include` applied: the version's
 * definition, option lists, site/region/company names, submitter, task title, the company's
 * branding (settings defaults without a site) and the in-app URL.
 */
export async function loadSubmission(
  _db: Db,
  _submissionId: string,
  _include: DestinationInclude,
  _publicUrl: string,
): Promise<LoadedSubmission | null> {
  throw new Error('loadSubmission is not built yet');
}

/** The latest version of a template, or a given version. */
export async function loadTemplate(
  _db: Db,
  _templateId: string,
  _versionId?: string,
): Promise<TemplateRef | null> {
  throw new Error('loadTemplate is not built yet');
}

/**
 * Renders one format, reusing a cached rendering (rendered_documents + blob store) keyed by the
 * submission, format, template version, include settings and RENDERER_VERSION. `stem` is the
 * safe file name without extension.
 */
export async function renderFormat(
  _deps: DocumentDeps,
  _input: {
    submissionId: string | null;
    model: DocumentModel;
    include: DestinationInclude;
    format: Format;
    template: TemplateRef | null;
    stem: string;
    signal: AbortSignal;
  },
): Promise<{ files: RenderedFile[]; cached: boolean }> {
  throw new Error('renderFormat is not built yet');
}

/** The canonical JSON body (schema "fieldforms.submission/1"), also served by /api/v1. */
export function submissionJson(_model: DocumentModel, _apiBase: string): Record<string, unknown> {
  throw new Error('submissionJson is not built yet');
}
