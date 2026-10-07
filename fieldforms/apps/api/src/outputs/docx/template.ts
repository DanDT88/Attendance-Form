import { templateData, type DocumentModel } from '@fieldforms/shared';
import Docxtemplater, { type DXT } from 'docxtemplater';
import type PizZip from 'pizzip';
import type { LoadedImage, RenderContext } from '../types.js';
import { ImageBudget, inOrder } from './embed.js';
import { openPackage, packageProblems, PackageError } from './package.js';
import { NAME_PATH, namesOnlyParser } from './parser.js';
import {
  PHOTO_MODULE,
  PhotoCollector,
  photoModule,
  PhotoWriter,
  targetKey,
  type PhotoHost,
  type PhotoTarget,
  type TagPlace,
} from './photo-module.js';

/**
 * Word templates: `{{ name }}` placeholders, `{{#name}}…{{/name}}` sections (a loop over a repeat
 * group's rows, or shown when the value is not blank), `{{^name}}…{{/name}}` (shown when blank)
 * and `{{%name}}` pictures. Names are resolved by `namesOnlyParser`; raw-XML tags are not
 * available at all (docxtemplater's raw-XML module is removed, so `{{@x}}` is an ordinary tag
 * that the checks refuse), and templates linking outside themselves are refused.
 */
export class TemplateProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

/** A tag found in a template, with the sections around it (outermost first). */
export interface TemplateTag {
  kind: 'value' | 'section' | 'image';
  /** The name as written, trimmed ("area", "items", "_logo", "fault_photo-1"). */
  name: string;
  /** As written between the delimiters ("#items", "%photo", " area "). */
  raw: string;
  inverted: boolean;
  sections: string[];
  file: string;
  place: TagPlace;
}

interface RawPart {
  type: string;
  value: string;
  module?: string;
  raw?: string;
  tag?: string;
  text?: boolean;
  position?: string;
  inverted?: boolean;
  subparsed?: RawPart[];
}

type FileTypeConfig = { baseModules: (() => { name?: string })[] };
type DocxtemplaterStatics = typeof Docxtemplater & {
  FileTypeConfig: { docx(): FileTypeConfig };
};

/** docx file handling without the raw-XML module, so a template can never insert raw XML. */
function fileTypeConfig(): FileTypeConfig {
  const config = (Docxtemplater as DocxtemplaterStatics).FileTypeConfig.docx();
  config.baseModules = config.baseModules.filter((make) => make().name !== 'RawXmlModule');
  return config;
}

/** docxtemplater's error explanations (they quote the template, never data). */
function explain(err: unknown): string[] {
  const e = err as { properties?: { errors?: unknown[]; explanation?: string }; message?: string };
  const list = e.properties?.errors?.length ? e.properties.errors : [err];
  const out = list
    .map((x) => {
      const p = (x as { properties?: { explanation?: string } }).properties;
      return p?.explanation ?? (x as Error).message ?? 'Invalid template';
    })
    .slice(0, 10);
  return [...new Set(out)];
}

export interface Compiled {
  doc: Docxtemplater;
  zip: PizZip;
  tags: TemplateTag[];
}

/**
 * Opens and compiles a Word template, collecting its tags. Throws TemplateProblems for a file
 * that is not a usable template (not Word, links outside itself, does not parse).
 */
export function compileTemplate(content: Buffer, host: PhotoHost | null): Compiled {
  let zip: PizZip;
  try {
    zip = openPackage(content);
  } catch (err) {
    if (err instanceof PackageError) throw new TemplateProblems([err.message]);
    throw err;
  }
  const unsafe = packageProblems(zip);
  if (unsafe.length) throw new TemplateProblems(unsafe);

  const places = new WeakMap<object, TagPlace>();
  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      stripInvalidXMLChars: true,
      errorLogging: false,
      // `{{=<% %>=}}` would change the delimiters part-way; templates keep {{ }}.
      syntax: { changeDelimiterPrefix: null },
      fileTypeConfig: fileTypeConfig(),
      parser: namesOnlyParser as unknown as DXT.Options['parser'],
      nullGetter: () => '',
      modules: [photoModule(host, places)],
    });
  } catch (err) {
    // Anything the uploaded file makes docxtemplater throw is a problem with that file.
    throw new TemplateProblems(explain(err));
  }
  // Fail closed if a docxtemplater upgrade renames the raw-XML module.
  if (doc.modules.some((m) => /raw/i.test(String(m.name)))) {
    throw new Error('docxtemplater still has a raw-XML module');
  }

  const tags: TemplateTag[] = [];
  const compiled = (doc as unknown as { compiled: Record<string, { postparsed: RawPart[] }> })
    .compiled;
  for (const [file, xt] of Object.entries(compiled)) {
    const state = { textTag: null as string | null, cells: 0, sections: [] as string[] };
    const walk = (parts: RawPart[]) => {
      for (const p of parts) {
        if (p.type === 'tag') {
          if (p.text) {
            if (p.position === 'start') state.textTag = p.tag ?? null;
            else if (p.position === 'end') state.textTag = null;
          } else if (p.tag === 'w:tc') {
            if (p.position === 'start') state.cells++;
            else if (p.position === 'end') state.cells = Math.max(0, state.cells - 1);
          }
          continue;
        }
        if (p.type !== 'placeholder') continue;
        const place: TagPlace = { textTag: state.textTag, inCell: state.cells > 0 };
        const kind =
          p.module === 'loop' ? 'section' : p.module === PHOTO_MODULE ? 'image' : 'value';
        if (kind === 'image') places.set(p, place);
        tags.push({
          kind,
          name: p.value.trim(),
          raw: p.raw ?? p.value,
          inverted: !!p.inverted,
          sections: [...state.sections],
          file,
          place,
        });
        if (p.module === 'loop' && p.subparsed) {
          state.sections.push(p.value.trim());
          walk(p.subparsed);
          state.sections.pop();
        }
      }
    };
    walk(xt.postparsed);
  }
  return { doc, zip, tags };
}

/** `{{%…}}`: a field id, a media name, `_logo`, or `.` in a section. */
export const IMAGE_NAME = /^(?:\.|_logo|[a-z][a-z0-9_]*(?:-\d+(?:-[a-z][a-z0-9_]*(?:-\d+)?)?)?)$/;

/** Problems with the tags themselves, whatever form they are used with. */
export function tagProblems(tags: TemplateTag[]): string[] {
  const problems = new Set<string>();
  for (const t of tags) {
    const shown = `{{${t.raw}}}`;
    const name = t.name;
    if (t.kind === 'value' && name.startsWith('@')) {
      problems.add(`${shown}: raw XML tags are not allowed`);
    } else if (t.kind === 'value' && /^[#^/%-]/.test(name)) {
      // `{{ #items }}` is not a section: the sign must come straight after the braces.
      problems.add(`${shown}: remove the spaces just inside the braces`);
    } else if (t.kind === 'image') {
      if (!IMAGE_NAME.test(name)) {
        problems.add(
          `${shown}: a picture tag takes a photo or signature field, a photo name or _logo`,
        );
      } else if (t.place.textTag !== 'w:t' || !/^word\/[^/]+\.xml$/.test(t.file)) {
        problems.add(`${shown}: put picture tags in the document text, a header or a footer`);
      }
    } else if (!NAME_PATH.test(name)) {
      problems.add(`${shown}: Word templates take names only (no calculations, filters or spaces)`);
    }
  }
  return [...problems];
}

const TEMPLATE_ERRORS = new Set(['TemplateError', 'RenderingError', 'ScopeParserError']);

/** Renders; docxtemplater's own errors are template problems, anything else is a bug. */
function renderOrThrow(doc: Docxtemplater, data: Record<string, unknown>): void {
  try {
    doc.render(data);
  } catch (err) {
    if (TEMPLATE_ERRORS.has((err as Error).name)) throw new TemplateProblems(explain(err));
    throw err;
  }
}

/**
 * Renders a Word template with a submission. The data is `templateData(model)`: field ids give
 * display text, repeat groups give rows, plus the `_` names. Pictures come from the model only.
 */
export async function renderDocxTemplate(
  model: DocumentModel,
  content: Buffer,
  ctx: RenderContext,
): Promise<Buffer> {
  const data = templateData(model);

  // First pass: check the template and learn which pictures it shows, in order.
  const collector = new PhotoCollector(model);
  const first = compileTemplate(content, collector);
  const problems = tagProblems(first.tags);
  if (problems.length) throw new TemplateProblems(problems);
  renderOrThrow(first.doc, data);

  const budget = new ImageBudget(ctx.media, ctx.signal);
  const loaded = new Map<string, LoadedImage | null>();
  const tasks: (() => Promise<void>)[] = [];
  for (const t of collector.targets) {
    const key = targetKey(t);
    if (loaded.has(key)) continue;
    loaded.set(key, null);
    // Tasks start in document order, so the limit keeps the first pictures.
    tasks.push(async () => {
      const img = t.kind === 'logo' ? budget.logo(model.branding.logoBlobId) : budget.load(t.ref);
      loaded.set(key, await img);
    });
  }
  await inOrder(tasks);
  ctx.signal.throwIfAborted();

  // Second pass: write the pictures.
  const skipped = (t: PhotoTarget) => t.kind === 'media' && budget.isSkipped(t.ref);
  const writer = new PhotoWriter(model, loaded, skipped);
  const second = compileTemplate(content, writer);
  writer.attach(second.zip);
  renderOrThrow(second.doc, data);
  writer.finish();
  return second.doc.toBuffer();
}
