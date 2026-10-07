import { mediaRefs, type DocField, type DocumentModel, type MediaRef } from '@fieldforms/shared';
import type { DXT } from 'docxtemplater';
import type PizZip from 'pizzip';
import type { LoadedImage } from '../types.js';
import { BOXES, EMU_PER_PX, fitToBox, mediaKey, shareBox, type Box } from './embed.js';

/**
 * `{{%name}}` puts pictures into a Word template. The free docxtemplater image module is
 * unmaintained and depends on a vulnerable XML library, and it loads whatever path or URL the
 * template's data gives it. This module only shows pictures of the document model: the tag names
 * a photo or signature field (inside a repeat-group section, a field of that row), a media name
 * ("fault_photo-1", "items-2-photo-1"), `_logo`, or `.` for a media name being looped over. It
 * never reads a path or an address.
 *
 * Rendering is synchronous in docxtemplater while loading pictures is not, so a template renders
 * twice: first to learn which pictures it shows, in document order (PhotoCollector), then, with
 * them loaded, to write them (PhotoWriter).
 */
export const PHOTO_MODULE = 'fieldforms-photo';

export type PhotoTarget = { kind: 'logo' } | { kind: 'media'; ref: MediaRef };

/** Where a tag is in the document, worked out once when the template is checked. */
export interface TagPlace {
  /** The text element the tag is in: only `w:t` (ordinary text) can hold a picture. */
  textTag: string | null;
  /** Inside a table cell: pictures are drawn smaller. */
  inCell: boolean;
}

interface ScopeView {
  path: string[];
  items: number[];
  types: string[];
  current: unknown;
}

function scopeOf(sm: DXT.ScopeManager): ScopeView {
  const s = sm as DXT.ScopeManager & { scopeTypes?: unknown[] };
  return {
    path: s.scopePath ?? [],
    items: s.scopePathItem ?? [],
    types: (s.scopeTypes ?? []).map(String),
    current: s.scopeList?.[s.scopeList.length - 1],
  };
}

function byName(model: DocumentModel, name: string): PhotoTarget[] {
  const ref = mediaRefs(model).find((r) => r.name === name);
  return ref ? [{ kind: 'media', ref }] : [];
}

/** The pictures a tag shows at this place in the document: references from the model only. */
export function resolvePhotoTag(
  model: DocumentModel,
  tag: string,
  scope: ScopeView,
): PhotoTarget[] {
  if (tag === '_logo') return model.branding.logoBlobId ? [{ kind: 'logo' }] : [];
  if (tag === '.') return typeof scope.current === 'string' ? byName(model, scope.current) : [];
  // The innermost repeat-group row this tag is repeated for, if any.
  let row: DocField[] | undefined;
  scope.path.forEach((name, i) => {
    if (scope.types[i] !== 'array') return;
    const group = model.fields.find((f) => f.type === 'group' && f.id === name.trim());
    const r = group?.rows?.[scope.items[i] ?? -1];
    if (r) row = r;
  });
  const field = row?.find((c) => c.id === tag) ?? model.fields.find((f) => f.id === tag);
  if (field) return (field.media ?? []).map((ref) => ({ kind: 'media', ref }));
  return byName(model, tag);
}

/** What the module does with a tag; the template renderer supplies it. */
export interface PhotoHost {
  render(tag: string, scope: ScopeView, place: TagPlace | undefined, filePath: string): string;
}

/** A docxtemplater module; a new one is needed for each document. */
export function photoModule(host: PhotoHost | null, places: WeakMap<object, TagPlace>): DXT.Module {
  return {
    name: 'FieldFormsPhotoModule',
    matchers: () => [['%', PHOTO_MODULE, {}]],
    render(part: DXT.Part, options: DXT.RenderOptions) {
      if (part.module !== PHOTO_MODULE) return null;
      if (!host) return { value: '', errors: [] };
      const value = host.render(
        part.value.trim(),
        scopeOf(options.scopeManager),
        places.get(part),
        options.filePath,
      );
      return { value, errors: [] };
    },
  };
}

/** First pass: records the pictures in document order and writes nothing. */
export class PhotoCollector implements PhotoHost {
  readonly targets: PhotoTarget[] = [];
  constructor(private readonly model: DocumentModel) {}
  render(tag: string, scope: ScopeView): string {
    this.targets.push(...resolvePhotoTag(this.model, tag, scope));
    return '';
  }
}

export const targetKey = (t: PhotoTarget) => (t.kind === 'logo' ? 'logo' : mediaKey(t.ref));

const NS = {
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const escapeXml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/**
 * An inline picture (`w:drawing/wp:inline/a:graphic/pic:pic` with `a:blip r:embed`). The
 * namespaces are declared on the element, so it is valid in headers and footers whose root
 * does not declare them.
 */
export function inlineDrawing(
  rId: string,
  id: number,
  descr: string,
  size: { w: number; h: number },
): string {
  const cx = size.w * EMU_PER_PX;
  const cy = size.h * EMU_PER_PX;
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="${NS.wp}" ` +
    `xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:r="${NS.r}">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${escapeXml(descr)}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg' } as const;

/**
 * Second pass: writes the loaded pictures. Each picture becomes one file in word/media, and each
 * part that shows it (the body, a header) gets a relationship to it; `finish` adds the files,
 * relationships and content types to the package after docxtemplater has rendered.
 */
export class PhotoWriter implements PhotoHost {
  private readonly files = new Map<string, { path: string; img: LoadedImage }>();
  /** part path → (picture key → relationship id), and every id in its .rels. */
  private readonly rels = new Map<string, { ids: Map<string, string>; taken: Set<string> }>();
  private zip: PizZip | null = null;
  private nextId = 1;
  private nextFile = 1;

  constructor(
    private readonly model: DocumentModel,
    private readonly loaded: Map<string, LoadedImage | null>,
    private readonly skipped: (t: PhotoTarget) => boolean,
  ) {}

  /** The package being rendered; drawing ids continue after the ones it already has. */
  attach(zip: PizZip): void {
    this.zip = zip;
    let max = 0;
    for (const name of Object.keys(zip.files)) {
      if (!/^word\/[^/]+\.xml$/.test(name)) continue;
      for (const m of zip.files[name]!.asText().matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)) {
        max = Math.max(max, Number(m[1]));
      }
    }
    this.nextId = Math.max(max, 1000) + 1;
  }

  render(tag: string, scope: ScopeView, place: TagPlace | undefined, filePath: string): string {
    const targets = resolvePhotoTag(this.model, tag, scope);
    const pieces: string[] = [];
    let limited = false;
    for (const t of targets) {
      const img = this.loaded.get(targetKey(t));
      if (!img) {
        if (this.skipped(t)) limited = true;
        continue;
      }
      const box = this.boxFor(t, place, targets.length);
      const descr = t.kind === 'logo' ? 'Logo' : t.ref.name;
      pieces.push(
        inlineDrawing(this.relFor(filePath, t, img), this.nextId++, descr, fitToBox(img, box)),
      );
    }
    const note = limited
      ? '(more pictures than one document can hold; see the photos download)'
      : '';
    if (!pieces.length) return escapeXml(note);
    return (
      '</w:t>' +
      pieces.join('<w:t xml:space="preserve"> </w:t>') +
      `<w:t xml:space="preserve">${note ? ' ' + escapeXml(note) : ''}`
    );
  }

  private boxFor(t: PhotoTarget, place: TagPlace | undefined, count: number): Box {
    const inCell = !!place?.inCell;
    if (t.kind === 'logo') return BOXES.logo;
    if (t.ref.kind === 'signature') return inCell ? BOXES.signatureInCell : BOXES.signature;
    return shareBox(inCell ? BOXES.photoInCell : BOXES.photo, inCell ? 1 : count);
  }

  private relFor(filePath: string, t: PhotoTarget, img: LoadedImage): string {
    const zip = this.zip!;
    const key = targetKey(t);
    let file = this.files.get(key);
    if (!file) {
      const ext = EXT[img.contentType];
      // A name the template does not already use (our own names only ever count up).
      while (zip.file(new RegExp(`^word/media/ffpic${this.nextFile}\\.`, 'i')).length)
        this.nextFile++;
      file = { path: `word/media/ffpic${this.nextFile++}.${ext}`, img };
      this.files.set(key, file);
    }
    let rels = this.rels.get(filePath);
    if (!rels) {
      const text = zip.file(relsPathOf(filePath))?.asText() ?? '';
      rels = {
        ids: new Map(),
        taken: new Set([...text.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]!)),
      };
      this.rels.set(filePath, rels);
    }
    let rId = rels.ids.get(key);
    if (!rId) {
      let n = rels.ids.size + 1;
      while (rels.taken.has(`rIdFfPic${n}`)) n++;
      rId = `rIdFfPic${n}`;
      rels.taken.add(rId);
      rels.ids.set(key, rId);
    }
    return rId;
  }

  /** Adds the picture files, the relationships and the content types to the rendered package. */
  finish(): void {
    const zip = this.zip;
    if (!zip || !this.files.size) return;
    const exts = new Set<string>();
    for (const { path, img } of this.files.values()) {
      zip.file(path, img.data);
      exts.add(EXT[img.contentType]);
    }
    for (const [part, { ids }] of this.rels) {
      if (!ids.size) continue;
      const relsPath = relsPathOf(part);
      const entries = [...ids]
        .map(([key, rId]) => {
          const target = this.files.get(key)!.path.slice('word/'.length);
          return `<Relationship Id="${rId}" Type="${IMAGE_REL}" Target="${target}"/>`;
        })
        .join('');
      const existing = zip.file(relsPath)?.asText();
      zip.file(
        relsPath,
        existing && existing.includes('</Relationships>')
          ? existing.replace('</Relationships>', `${entries}</Relationships>`)
          : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
              `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`,
      );
    }
    let types = zip.file('[Content_Types].xml')!.asText();
    for (const ext of exts) {
      if (new RegExp(`<Default\\b[^>]*\\bExtension="${ext}"`, 'i').test(types)) continue;
      types = types.replace(
        '</Types>',
        `<Default Extension="${ext}" ContentType="image/${ext}"/></Types>`,
      );
    }
    zip.file('[Content_Types].xml', types);
  }
}

/** word/document.xml → word/_rels/document.xml.rels */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
