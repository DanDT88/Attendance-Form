import { createHash } from 'node:crypto';
import {
  FORMAT_LABELS,
  INCLUDE_ALL,
  RESERVED_NAMES,
  RESERVED_VARIABLES,
  TEMPLATE_FORMATS,
  TEMPLATE_KINDS,
  TEMPLATE_ONLY_VARIABLES,
  reservedValues,
  templateData,
  uuid,
  validateDefinition,
  type DocField,
  type DocumentModel,
  type Format,
  type FormDefinition,
  type TemplateKind,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { fileStem } from '../destinations/naming.js';
import { DeliveryError } from '../destinations/types.js';
import type { BlobStore } from '../lib/blobstore.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { renderLiquid, safeFilename } from '../lib/liquid.js';
import { parse } from '../lib/validate.js';
import { DOCX_TYPE } from '../outputs/renderers/docx.js';
import { analyzeTemplate } from '../outputs/templates/analyze.js';
import { starterTemplate } from '../outputs/templates/starter.js';
import type { PdfConverter, RenderedFile } from '../outputs/types.js';
import { audit, type AuditContext } from './audit.js';
import { formVersions } from './deliveries.js';
import {
  defaultBranding,
  loadSubmission,
  loadTemplate,
  renderFormat,
  sampleSubmission,
} from './documents.js';
import { listItems, listsUsed } from './forms.js';

/**
 * Document templates (HTML for PDF, Word for Word or PDF): linking them to forms, versioned
 * content checked against every published version of those forms, previews, starter templates,
 * the placeholders a form offers, and each form's default template per format.
 * See ARCHITECTURE.md, "Documents", and docs/phase3-api.md, "Templates".
 */

export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
/** The database keeps HTML templates as text of at most this many characters. */
const HTML_MAX_CHARS = 200_000;

const name = z.string().trim().min(1).max(120);
const formIds = z.array(uuid).max(100);

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function uniqueName<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw conflict('A template with that name already exists');
    throw err;
  }
}

/** `placeholders` holds `{ placeholders, warnings }` (what the analysis found when it was saved). */
function analysisOf(stored: unknown): { placeholders: string[]; warnings: string[] } {
  if (Array.isArray(stored)) return { placeholders: stored as string[], warnings: [] };
  const s = (stored ?? {}) as { placeholders?: string[]; warnings?: string[] };
  return { placeholders: s.placeholders ?? [], warnings: s.warnings ?? [] };
}

async function assertForms(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const found = await db.selectFrom('forms').select('id').where('id', 'in', ids).execute();
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw badRequest(`Unknown form: ${missing.join(', ')}`);
}

/** Published versions of every form the template is linked to, for checking its placeholders. */
async function linkedVersions(db: Db, templateId: string) {
  const links = await db
    .selectFrom('template_forms')
    .select('form_id')
    .where('template_id', '=', templateId)
    .execute();
  const out: { version: number; definition: FormDefinition }[] = [];
  for (const l of links) out.push(...(await formVersions(db, l.form_id)));
  return out;
}

/** Destinations (not archived) whose templates name this template, for "used by" and guards. */
async function destinationsUsing(db: Db, templateId: string) {
  return db
    .selectFrom('destinations as d')
    .select(['d.id', 'd.name', 'd.form_id'])
    .where('d.archived_at', 'is', null)
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM jsonb_each_text(d.templates) e WHERE e.value = ${templateId})`,
    )
    .orderBy('d.name')
    .execute();
}

/** Forms whose default download template (per format) is this template. */
async function formsDefaulting(db: Db, templateId: string) {
  return db
    .selectFrom('forms as f')
    .select(['f.id', 'f.name'])
    .where(
      sql<boolean>`EXISTS (SELECT 1 FROM jsonb_each_text(f.document_templates) e WHERE e.value = ${templateId})`,
    )
    .execute();
}

// ---------------------------------------------------------------- checks used by destinations

/**
 * Problems with using these templates for these formats on a form: each template must exist,
 * not be archived, be linked to the form, have content and be able to make the format.
 */
export async function templateProblems(
  db: Db,
  formId: string,
  templates: Partial<Record<Format, string>>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [format, id] of Object.entries(templates) as [Format, string][]) {
    const label = FORMAT_LABELS[format];
    const t = await db
      .selectFrom('output_templates as t')
      .select([
        't.id',
        't.name',
        't.kind',
        't.archived_at',
        sql<boolean>`EXISTS (SELECT 1 FROM template_forms l
          WHERE l.template_id = t.id AND l.form_id = ${formId})`.as('linked'),
        sql<boolean>`EXISTS (SELECT 1 FROM output_template_versions v
          WHERE v.template_id = t.id)`.as('has_content'),
      ])
      .where('t.id', '=', id)
      .executeTakeFirst();
    if (!t) errors.push(`${label}: the template was not found`);
    else if (t.archived_at) errors.push(`${label}: "${t.name}" is archived`);
    else if (!t.linked) errors.push(`${label}: "${t.name}" is not linked to this form`);
    else if (!TEMPLATE_FORMATS[t.kind].includes(format))
      errors.push(
        `${label}: "${t.name}" is ${t.kind === 'html' ? 'an HTML' : 'a Word'} template and cannot make ${label}`,
      );
    else if (!t.has_content) errors.push(`${label}: "${t.name}" has no content yet`);
  }
  return errors;
}

/**
 * The definition documents of a form are built from: its latest published version, else its
 * draft if that is valid (version 0), else null.
 */
export async function currentDefinition(db: Db, formId: string) {
  const form = await db
    .selectFrom('forms')
    .select(['id', 'name', 'draft_definition'])
    .where('id', '=', formId)
    .executeTakeFirst();
  if (!form) throw notFound('Form not found');
  const v = await db
    .selectFrom('form_versions')
    .select(['id', 'version', 'definition'])
    .where('form_id', '=', formId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (v)
    return {
      form,
      version: v.version,
      versionId: v.id,
      definition: v.definition as FormDefinition,
    };
  const draft = validateDefinition(form.draft_definition);
  if (draft.ok && draft.definition)
    return { form, version: 0, versionId: '', definition: draft.definition };
  return { form, version: null, versionId: '', definition: null };
}

// ---------------------------------------------------------------- templates

export async function listTemplates(db: Db, formId?: string) {
  let q = db
    .selectFrom('output_templates as t')
    .select([
      't.id',
      't.name',
      't.kind',
      't.archived_at',
      sql<string[]>`coalesce((SELECT array_agg(l.form_id ORDER BY l.form_id) FROM template_forms l
        WHERE l.template_id = t.id), '{}')`.as('form_ids'),
      sql<{ version: number; created_at: string; placeholders: unknown } | null>`(
        SELECT json_build_object('version', v.version, 'created_at', v.created_at,
          'placeholders', v.placeholders)
        FROM output_template_versions v WHERE v.template_id = t.id
        ORDER BY v.version DESC LIMIT 1)`.as('latest'),
    ])
    .orderBy(sql`t.archived_at IS NOT NULL`)
    .orderBy('t.name');
  if (formId)
    q = q.where(
      sql<boolean>`EXISTS (SELECT 1 FROM template_forms l
        WHERE l.template_id = t.id AND l.form_id = ${formId})`,
    );
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    formIds: r.form_ids,
    latest: r.latest
      ? {
          version: r.latest.version,
          createdAt: new Date(r.latest.created_at),
          warnings: analysisOf(r.latest.placeholders).warnings,
        }
      : null,
    archivedAt: r.archived_at,
  }));
}

export async function createTemplate(
  db: Db,
  userId: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ id: string }> {
  const b = parse(
    z.object({ name, kind: z.enum(TEMPLATE_KINDS), formIds: formIds.default([]) }),
    body,
  );
  const ids = [...new Set(b.formIds)];
  await assertForms(db, ids);
  return uniqueName(
    db.transaction().execute(async (trx) => {
      const t = await trx
        .insertInto('output_templates')
        .values({ name: b.name, kind: b.kind, created_by: userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (ids.length)
        await trx
          .insertInto('template_forms')
          .values(ids.map((form_id) => ({ template_id: t.id, form_id })))
          .execute();
      await audit(trx, ctx, {
        action: 'template.create',
        entity: 'output_template',
        entityId: t.id,
        details: { name: b.name, kind: b.kind, formIds: ids },
      });
      return { id: t.id };
    }),
  );
}

export async function getTemplate(db: Db, id: string) {
  const t = await db
    .selectFrom('output_templates')
    .select(['id', 'name', 'kind', 'archived_at', 'created_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!t) throw notFound('Template not found');
  const links = await db
    .selectFrom('template_forms')
    .select('form_id')
    .where('template_id', '=', id)
    .orderBy('form_id')
    .execute();
  const versions = await db
    .selectFrom('output_template_versions as v')
    .leftJoin('users as u', 'u.id', 'v.created_by')
    .select(['v.id', 'v.version', 'v.created_at', 'v.placeholders', 'v.sha256', 'u.display_name'])
    .where('v.template_id', '=', id)
    .orderBy('v.version', 'desc')
    .execute();
  const usedBy = await destinationsUsing(db, id);
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    formIds: links.map((l) => l.form_id),
    archivedAt: t.archived_at,
    createdAt: t.created_at,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      createdAt: v.created_at,
      createdBy: v.display_name,
      sha256: v.sha256,
      ...analysisOf(v.placeholders),
    })),
    usedBy: usedBy.map((d) => ({ destinationId: d.id, name: d.name, formId: d.form_id })),
  };
}

/**
 * Renames, relinks or archives a template. A form cannot be unlinked, nor the template archived,
 * while a destination or a form's default downloads use it there: they would stop working.
 */
export async function updateTemplate(
  db: Db,
  id: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ ok: true }> {
  const b = parse(
    z.object({
      name: name.optional(),
      formIds: formIds.optional(),
      archived: z.boolean().optional(),
    }),
    body,
  );
  const next = b.formIds ? [...new Set(b.formIds)] : null;
  if (next) await assertForms(db, next);
  await uniqueName(
    db.transaction().execute(async (trx) => {
      const t = await trx
        .selectFrom('output_templates')
        .select(['id', 'name', 'archived_at'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!t) throw notFound('Template not found');
      const changed: string[] = [];
      const used = await destinationsUsing(trx, id);
      const defaults = await formsDefaulting(trx, id);

      if (next) {
        const current = (
          await trx
            .selectFrom('template_forms')
            .select('form_id')
            .where('template_id', '=', id)
            .execute()
        ).map((l) => l.form_id);
        const removed = current.filter((f) => !next.includes(f));
        const added = next.filter((f) => !current.includes(f));
        const blocking = [
          ...used.filter((d) => removed.includes(d.form_id)).map((d) => `destination "${d.name}"`),
          ...defaults.filter((f) => removed.includes(f.id)).map((f) => `form "${f.name}"`),
        ];
        if (blocking.length)
          throw conflict(
            `The template is still used on the forms being unlinked, by ${blocking.join(', ')}`,
          );
        if (removed.length)
          await trx
            .deleteFrom('template_forms')
            .where('template_id', '=', id)
            .where('form_id', 'in', removed)
            .execute();
        if (added.length)
          await trx
            .insertInto('template_forms')
            .values(added.map((form_id) => ({ template_id: id, form_id })))
            .execute();
        if (removed.length || added.length) changed.push('formIds');
      }
      if (b.archived !== undefined && b.archived !== (t.archived_at !== null)) {
        if (b.archived && (used.length || defaults.length)) {
          const names = [
            ...used.map((d) => `destination "${d.name}"`),
            ...defaults.map((f) => `form "${f.name}"`),
          ];
          throw conflict(`The template is still used by ${names.join(', ')}`);
        }
        changed.push(b.archived ? 'archived' : 'unarchived');
      }
      if (b.name !== undefined && b.name !== t.name) changed.push('name');
      if (changed.some((c) => c !== 'formIds'))
        await trx
          .updateTable('output_templates')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.archived !== undefined && {
              archived_at: b.archived ? (t.archived_at ?? new Date()) : null,
            }),
          })
          .where('id', '=', id)
          .execute();
      if (changed.length)
        await audit(trx, ctx, {
          action: 'template.update',
          entity: 'output_template',
          entityId: id,
          details: { changed, ...(next && { formIds: next }) },
        });
    }),
  );
  return { ok: true };
}

/**
 * Saves new content as the next version, after checking it against every published version of
 * the linked forms. Errors (syntax, unknown names, raw XML, external links) stop the save.
 */
export async function saveTemplateContent(
  db: Db,
  userId: string,
  id: string,
  contentType: string | undefined,
  body: unknown,
  ctx: AuditContext,
): Promise<{ version: number; warnings: string[] }> {
  const t = await db
    .selectFrom('output_templates')
    .select(['id', 'kind', 'archived_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!t) throw notFound('Template not found');
  if (t.archived_at) throw badRequest('Unarchive the template before changing it');
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const expected = t.kind === 'html' ? 'text/html' : DOCX_TYPE;
  if (type !== expected)
    throw new HttpError(
      415,
      t.kind === 'html'
        ? 'Send an HTML template as text/html'
        : `Send a Word template as ${DOCX_TYPE}`,
    );
  let content: string | Buffer;
  if (t.kind === 'html') {
    if (typeof body !== 'string' || !body.trim()) throw badRequest('The template is empty');
    if (body.length > HTML_MAX_CHARS)
      throw badRequest(`HTML templates can be at most ${HTML_MAX_CHARS} characters`);
    content = body;
  } else {
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest('The template is empty');
    content = body;
  }

  const analysis = await analyzeTemplate(t.kind, content, await linkedVersions(db, id));
  if (analysis.errors.length)
    throw badRequest('The template has problems to fix before it can be saved', analysis.errors);

  return db.transaction().execute(async (trx) => {
    // Serialise saves of one template so two cannot take the same version number.
    await trx
      .selectFrom('output_templates')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .execute();
    const last = await trx
      .selectFrom('output_template_versions')
      .select(({ fn }) => fn.max('version').as('v'))
      .where('template_id', '=', id)
      .executeTakeFirst();
    const version = (last?.v ?? 0) + 1;
    const hash = sha256(content);
    await trx
      .insertInto('output_template_versions')
      .values({
        template_id: id,
        version,
        content_text: typeof content === 'string' ? content : null,
        content_bytes: Buffer.isBuffer(content) ? content : null,
        sha256: hash,
        placeholders: JSON.stringify({
          placeholders: analysis.placeholders,
          warnings: analysis.warnings,
        }),
        created_by: userId,
      })
      .execute();
    await audit(trx, ctx, {
      action: 'template.content',
      entity: 'output_template',
      entityId: id,
      details: { version, sha256: hash, warnings: analysis.warnings.length },
    });
    return { version, warnings: analysis.warnings };
  });
}

/** One saved version's content, as the file it was uploaded as. */
export async function templateVersionFile(
  db: Db,
  id: string,
  version: number,
): Promise<RenderedFile> {
  const v = await db
    .selectFrom('output_template_versions as v')
    .innerJoin('output_templates as t', 't.id', 'v.template_id')
    .select(['t.name', 't.kind', 'v.version', 'v.content_text', 'v.content_bytes'])
    .where('v.template_id', '=', id)
    .where('v.version', '=', version)
    .executeTakeFirst();
  if (!v) throw notFound('Template version not found');
  const stem = `${v.name} v${v.version}`;
  return v.kind === 'html'
    ? {
        filename: safeFilename(stem, 'template', 'html'),
        contentType: 'text/html; charset=utf-8',
        data: Buffer.from(v.content_text ?? '', 'utf8'),
      }
    : {
        filename: safeFilename(stem, 'template', 'docx'),
        contentType: DOCX_TYPE,
        data: v.content_bytes ?? Buffer.alloc(0),
      };
}

export interface PreviewDeps {
  db: Db;
  blobs: BlobStore;
  pdf: PdfConverter;
  publicUrl: string;
}

/**
 * Renders a template (latest or a given version) against a real submission of a linked form or
 * a generated sample of the first linked form, without sending or caching anything. Showing a
 * real submission is audited.
 */
export async function previewTemplate(
  deps: PreviewDeps,
  id: string,
  body: unknown,
  ctx: AuditContext,
): Promise<RenderedFile> {
  const { db } = deps;
  const b = parse(
    z.object({
      format: z.enum(['pdf', 'docx']),
      version: z.number().int().positive().optional(),
      submissionId: uuid.optional(),
    }),
    body,
  );
  const t = await db
    .selectFrom('output_templates')
    .select(['id', 'name', 'kind', 'archived_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!t) throw notFound('Template not found');
  if (!TEMPLATE_FORMATS[t.kind].includes(b.format))
    throw badRequest(
      `${t.kind === 'html' ? 'An HTML' : 'A Word'} template cannot make ${FORMAT_LABELS[b.format]}`,
    );
  let versionId: string | undefined;
  if (b.version !== undefined) {
    const v = await db
      .selectFrom('output_template_versions')
      .select('id')
      .where('template_id', '=', id)
      .where('version', '=', b.version)
      .executeTakeFirst();
    if (!v) throw notFound('Template version not found');
    versionId = v.id;
  }
  const template = await loadTemplate(db, id, versionId);
  if (!template)
    throw badRequest(
      t.archived_at ? 'The template is archived' : 'Upload the template before previewing it',
    );
  const linked = (
    await db
      .selectFrom('template_forms as l')
      .innerJoin('forms as f', 'f.id', 'l.form_id')
      .select(['f.id', 'f.name'])
      .where('l.template_id', '=', id)
      .orderBy('f.name')
      .execute()
  ).map((f) => f.id);

  let model: DocumentModel;
  if (b.submissionId) {
    const loaded = await loadSubmission(db, b.submissionId, INCLUDE_ALL, deps.publicUrl);
    if (!loaded) throw notFound('Submission not found');
    if (!linked.includes(loaded.model.form.id))
      throw badRequest('The submission is not of a form this template is linked to');
    model = loaded.model;
  } else {
    let found = null;
    for (const formId of linked) {
      const cur = await currentDefinition(db, formId);
      if (cur.definition) {
        found = cur;
        break;
      }
    }
    if (!found?.definition)
      throw badRequest('Link the template to a form with a published version to preview it');
    const lists = await listItems(db, listsUsed([found.definition]));
    model = sampleSubmission(
      found.definition,
      {
        id: found.form.id,
        name: found.form.name,
        version: found.version ?? 0,
        versionId: found.versionId,
      },
      INCLUDE_ALL,
      new Date(),
      { lists, branding: await defaultBranding(db), publicUrl: deps.publicUrl },
    );
  }

  const stem = fileStem(
    model,
    await renderLiquid(
      '{{ _form }} - {{ _site }} - {{ _captured }}',
      templateData(model),
      'line',
    ).catch(() => model.form.name),
  );
  let files: RenderedFile[];
  try {
    ({ files } = await renderFormat(
      { db, blobs: deps.blobs, pdf: deps.pdf, publicUrl: deps.publicUrl },
      {
        // Previews are not cached: they are one-off, often of a version still being written.
        submissionId: null,
        model,
        include: INCLUDE_ALL,
        format: b.format,
        template,
        stem: `PREVIEW ${stem}`,
        signal: AbortSignal.timeout(90_000),
      },
    ));
  } catch (err) {
    if (err instanceof DeliveryError && !err.permanent)
      throw new HttpError(503, 'The document converter is not reachable; try again shortly');
    const e = err as { permanent?: boolean; message?: string };
    if (e.permanent === true && typeof e.message === 'string')
      throw badRequest(e.message.split('\n')[0]!.slice(0, 300));
    throw err;
  }
  if (b.submissionId)
    await audit(db, ctx, {
      action: 'template.preview',
      entity: 'form_submission',
      entityId: b.submissionId,
      details: { templateId: id, version: template.version, format: b.format },
    });
  return files[0]!;
}

/** A starter template for a form, with every field, loop and photo tag. */
export async function formStarterTemplate(
  db: Db,
  formId: string,
  kind: TemplateKind,
): Promise<RenderedFile> {
  const cur = await currentDefinition(db, formId);
  if (!cur.definition) throw badRequest('Publish the form (or fix its draft) first');
  return starterTemplate(kind, cur.definition, cur.form.name);
}

export interface Placeholder {
  name: string;
  label: string;
  kind: 'field' | 'group' | 'photo' | 'reserved';
  sample: string;
}

/**
 * What templates of a form can use: the fields of its latest version (group children as
 * "group.child", photos and signatures as Word picture tags "%id"), then the reserved names.
 * Samples come from the generated sample submission, never real data.
 */
export async function formPlaceholders(db: Db, formId: string): Promise<Placeholder[]> {
  const cur = await currentDefinition(db, formId);
  if (!cur.definition) throw badRequest('Publish the form (or fix its draft) first');
  const lists = await listItems(db, listsUsed([cur.definition]));
  const model = sampleSubmission(
    cur.definition,
    {
      id: cur.form.id,
      name: cur.form.name,
      version: cur.version ?? 0,
      versionId: cur.versionId,
    },
    INCLUDE_ALL,
    new Date(),
    { lists, branding: await defaultBranding(db) },
  );
  const out: Placeholder[] = [];
  const isPicture = (f: DocField) => f.type === 'image' || f.type === 'signature';
  const pictureSample = (f: DocField | undefined) => f?.media?.map((m) => m.name).join(', ') ?? '';
  for (const f of model.fields) {
    if (f.type === 'group') {
      const rows = f.rows?.length ?? 0;
      out.push({
        name: f.id,
        label: f.label,
        kind: 'group',
        sample: `${rows} row${rows === 1 ? '' : 's'}`,
      });
      const def = cur.definition.fields.find((d) => d.id === f.id);
      const children = def?.type === 'group' ? def.fields.filter((c) => c.type !== 'note') : [];
      for (const c of children) {
        const cell = f.rows?.[0]?.find((x) => x.id === c.id);
        const picture = c.type === 'image' || c.type === 'signature';
        out.push({
          name: picture ? `%${f.id}.${c.id}` : `${f.id}.${c.id}`,
          label: `${f.label}: ${c.label}`,
          kind: picture ? 'photo' : 'field',
          sample: picture ? pictureSample(cell) : (cell?.text ?? ''),
        });
      }
    } else if (isPicture(f)) {
      out.push({ name: `%${f.id}`, label: f.label, kind: 'photo', sample: pictureSample(f) });
    } else {
      out.push({ name: f.id, label: f.label, kind: 'field', sample: f.text });
    }
  }
  const reserved = reservedValues(model);
  for (const n of RESERVED_NAMES) {
    const v = reserved[n];
    out.push({
      name: n,
      label: RESERVED_VARIABLES[n],
      kind: 'reserved',
      sample: v === null || v === undefined ? '' : String(v),
    });
  }
  out.push(
    {
      name: '_fields',
      label: TEMPLATE_ONLY_VARIABLES._fields,
      kind: 'reserved',
      sample: `${model.fields.length} fields`,
    },
    {
      name: '_branding',
      label: TEMPLATE_ONLY_VARIABLES._branding,
      kind: 'reserved',
      sample: model.branding.name,
    },
  );
  return out;
}

/**
 * Sets a form's default template for in-app downloads, per format (null removes it). Each
 * template is checked as a destination's would be.
 */
export async function setDocumentTemplates(
  db: Db,
  formId: string,
  body: unknown,
  ctx: AuditContext,
): Promise<{ ok: true }> {
  const b = parse(
    z.object({ pdf: uuid.nullable().optional(), docx: uuid.nullable().optional() }).strict(),
    body,
  );
  const set = Object.fromEntries(
    Object.entries(b).filter((e): e is [Format, string] => typeof e[1] === 'string'),
  ) as Partial<Record<Format, string>>;
  const exists = await db.selectFrom('forms').select('id').where('id', '=', formId).execute();
  if (!exists.length) throw notFound('Form not found');
  const errors = await templateProblems(db, formId, set);
  if (errors.length) throw badRequest(errors.join('; '), errors);
  await db.transaction().execute(async (trx) => {
    const form = await trx
      .selectFrom('forms')
      .select(['id', 'document_templates'])
      .where('id', '=', formId)
      .forUpdate()
      .executeTakeFirst();
    if (!form) throw notFound('Form not found');
    const next = { ...((form.document_templates ?? {}) as Record<string, string>) };
    for (const [format, id] of Object.entries(b)) {
      if (id === undefined) continue;
      if (id === null) delete next[format];
      else next[format] = id;
    }
    await trx
      .updateTable('forms')
      .set({ document_templates: JSON.stringify(next) })
      .where('id', '=', formId)
      .execute();
    await audit(trx, ctx, {
      action: 'form.document_templates',
      entity: 'form',
      entityId: formId,
      details: { documentTemplates: next },
    });
  });
  return { ok: true };
}

/** The download name of a rendered or uploaded file, as a Content-Disposition value. */
export function attachment(filename: string): string {
  return `attachment; filename="${filename.replace(/[^\w .()-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
