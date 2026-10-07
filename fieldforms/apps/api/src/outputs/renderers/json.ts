import type { AnswerValue, DocField, DocumentModel, MediaRef } from '@fieldforms/shared';
import type { Renderer } from '../types.js';

export const SUBMISSION_SCHEMA = 'fieldforms.submission/1';

/** A photo or signature as JSON and XML list it. */
export interface FileEntry {
  name: string;
  kind: MediaRef['kind'];
  /** Where it sits in the answers, as `form_submission_files.path` has it ("items[0].photo[1]"). */
  path: string;
  /** Null for a photo whose original the destination does not include. */
  blobId: string | null;
  url: string | null;
}

/**
 * Whether a file may be pointed at. A photo's stored blob is the untouched original, so it is
 * named only when the destination includes originals; a signature is the file itself.
 */
export const shareable = (ref: MediaRef) => ref.kind === 'signature' || ref.includeOriginal;

/** Every photo and signature with its path, in document order (the order of `mediaRefs`). */
export function fileEntries(model: DocumentModel, apiBase: string): FileEntry[] {
  const base = apiBase.replace(/\/+$/, '');
  const out: FileEntry[] = [];
  const add = (f: DocField, path: string) => {
    for (const [i, ref] of (f.media ?? []).entries()) {
      const ok = shareable(ref);
      out.push({
        name: ref.name,
        kind: ref.kind,
        path: ref.kind === 'photo' ? `${path}[${i}]` : path,
        blobId: ok ? ref.blobId : null,
        url: ok ? `${base}/files/${ref.blobId}` : null,
      });
    }
  };
  for (const f of model.fields) {
    add(f, f.id);
    (f.rows ?? []).forEach((row, i) => row.forEach((c) => add(c, `${f.id}[${i}].${c.id}`)));
  }
  return out;
}

/**
 * A field's answer for JSON: the stored value, except that photos carry their media name (the
 * name the `images` format files them under) and their blob ids only when originals are
 * included. Undefined when the field has no answer.
 */
export function exportValue(f: DocField): AnswerValue | undefined {
  if (f.type === 'group') {
    return (f.rows ?? []).map((cells) => {
      const row: Record<string, AnswerValue> = {};
      for (const c of cells) {
        const v = exportValue(c);
        if (v !== undefined) row[c.id] = v;
      }
      return row;
    }) as AnswerValue;
  }
  if (f.type === 'image' && f.media) {
    return f.media.map((ref) =>
      shareable(ref)
        ? {
            name: ref.name,
            blobId: ref.blobId,
            ...(ref.annotationBlobId ? { annotationBlobId: ref.annotationBlobId } : {}),
          }
        : { name: ref.name },
    ) as unknown as AnswerValue;
  }
  return f.value;
}

/**
 * The canonical JSON body (schema "fieldforms.submission/1"), also served by /api/v1: the
 * answers after the destination's include filter and the submission's metadata. Never the
 * device payload or the clock evidence.
 */
export function submissionJson(model: DocumentModel, apiBase: string): Record<string, unknown> {
  const s = model.submission;
  const answers: Record<string, AnswerValue> = {};
  const labels: Record<string, string> = {};
  for (const f of model.fields) {
    const v = exportValue(f);
    if (v !== undefined) answers[f.id] = v;
    labels[f.id] = f.label;
    for (const c of f.rows?.[0] ?? []) labels[`${f.id}.${c.id}`] = c.label;
  }
  return {
    schema: SUBMISSION_SCHEMA,
    form: { id: model.form.id, name: model.form.name, version: model.form.version },
    submission: {
      id: s.id,
      receivedAt: s.receivedAt,
      capturedAt: s.capturedAt,
      site: s.site,
      siteId: s.siteId,
      region: s.region,
      company: s.company,
      submittedBy: s.submittedBy,
      task: s.task,
      url: s.url,
      ...(s.sample ? { sample: true } : {}),
    },
    answers,
    labels,
    files: fileEntries(model, apiBase),
  };
}

/** JSON: the canonical submission document (schema fieldforms.submission/1). */
export const jsonRenderer: Renderer = {
  format: 'json',
  async render(model, _template, stem, ctx) {
    const body = `${JSON.stringify(submissionJson(model, ctx.apiBase), null, 2)}\n`;
    return [
      {
        filename: `${stem}.json`,
        contentType: 'application/json; charset=utf-8',
        data: Buffer.from(body, 'utf8'),
      },
    ];
  },
};
