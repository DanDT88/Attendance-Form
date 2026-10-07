import type { DocumentModel } from '@fieldforms/shared';
import { safeFilename } from '../lib/liquid.js';
import type { RenderedFile } from '../outputs/types.js';
import type { DeliveryContext } from './types.js';

/**
 * File and folder names for file destinations (SFTP, S3, Google Drive, OneDrive).
 *
 * The pipeline renders the destination's file-name template once per generation into a stem
 * (`fileStem`), and the renderers name every file from it, so all attempts of a delivery produce
 * the same names. A stem that does not contain the submission id gets `_<short id>` appended, so
 * two submissions can never share a file name.
 */
export function fileStem(model: DocumentModel, rendered: string): string {
  const s = model.submission;
  const base = safeFilename(rendered, `${model.form.name} ${s.shortId}`, 'x').replace(/\.x$/, '');
  if (base.includes(s.shortId) || base.includes(s.id)) return base;
  return `${base}_${s.shortId}`.slice(0, 120);
}

/** One folder segment: like a file name, but never "." or "..". */
function segment(raw: string): string {
  const cleaned = safeFilename(raw, '', 'x').replace(/\.x$/, '');
  return cleaned === '.' || cleaned === '..' ? '' : cleaned;
}

/**
 * Renders a folder template ("{{ _company }}/{{ _site }}/{{ _captured | date: '%Y-%m' }}"):
 * the template is rendered as one line, split on "/", and each segment cleaned; empty, "." and
 * ".." segments are dropped, so the result can never climb out of the configured base.
 */
export async function renderFolder(ctx: DeliveryContext, template: string): Promise<string> {
  if (!template.trim()) return '';
  const rendered = await ctx.liquid(template, 'line');
  return rendered.split('/').map(segment).filter(Boolean).join('/');
}

/** A test send's files get a "TEST " prefix so nobody mistakes them for real ones. */
export function uploadName(ctx: DeliveryContext, file: RenderedFile): string {
  return ctx.test ? `TEST ${file.filename}` : file.filename;
}

/** The folder (rendered once) and the name of each file to upload. */
export async function plannedUploads(
  ctx: DeliveryContext,
  folderTemplate: string,
): Promise<{ folder: string; files: { name: string; path: string; file: RenderedFile }[] }> {
  const folder = await renderFolder(ctx, folderTemplate);
  const files = ctx.files.map((file) => {
    const name = uploadName(ctx, file);
    return { name, path: folder ? `${folder}/${name}` : name, file };
  });
  return { folder, files };
}
