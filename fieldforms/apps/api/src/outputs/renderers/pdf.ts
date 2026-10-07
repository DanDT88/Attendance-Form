import { templateData, type DocumentModel } from '@fieldforms/shared';
import { renderLiquid, TemplateError } from '../../lib/liquid.js';
import {
  builtInHtml,
  documentTitle,
  mediaItems,
  templateDocument,
  type LayoutImages,
} from '../html-layout.js';
import { dataUri, mapLimit } from '../media.js';
import {
  EMBED_MAX_IMAGES,
  EMBED_MAX_SIDE,
  RenderError,
  type RenderContext,
  type RenderedFile,
  type Renderer,
  type TemplateRef,
} from '../types.js';
import { docxRenderer } from './docx.js';

/** Logos are shown about 50 px high; this leaves room for print resolution. */
const LOGO_SIDE = 400;
const PARALLEL_LOADS = 4;

/**
 * The images a PDF embeds, as data: URIs: signatures first (they matter most), then photos in
 * document order, at most EMBED_MAX_IMAGES of them at EMBED_MAX_SIDE.
 */
export async function embeddedImages(
  model: DocumentModel,
  ctx: RenderContext,
): Promise<LayoutImages> {
  const items = mediaItems(model);
  const signatures = items.filter((m) => m.ref.kind === 'signature');
  const photos = items.filter((m) => m.ref.kind === 'photo');
  const chosen = [...signatures, ...photos].slice(0, EMBED_MAX_IMAGES);
  const loaded = await mapLimit(chosen, PARALLEL_LOADS, (m) =>
    ctx.media.load(m.ref, { maxSide: EMBED_MAX_SIDE }),
  );
  const images = new Map<string, string | null>();
  chosen.forEach((m, i) => {
    const img = loaded[i];
    images.set(m.ref.name, img ? dataUri(img) : null);
  });
  const logoId = model.branding.logoBlobId;
  const logo = logoId ? await ctx.media.logo(logoId, { maxSide: LOGO_SIDE }) : null;
  const shownPhotos = chosen.filter((m) => m.ref.kind === 'photo').length;
  return { logo: logo ? dataUri(logo) : null, images, omitted: photos.length - shownPhotos };
}

/**
 * A Liquid HTML template: it sees the template data plus `_images` (data: URIs by media name)
 * and the logo in `_branding.logo`. Every value is HTML-escaped (`| raw` cannot undo it) and the
 * output goes into the body of our own document.
 */
async function templateHtml(
  model: DocumentModel,
  template: TemplateRef,
  ctx: RenderContext,
): Promise<string> {
  const assets = await embeddedImages(model, ctx);
  const images: Record<string, string> = {};
  for (const [name, uri] of assets.images) if (uri) images[name] = uri;
  const data = templateData(model);
  const source =
    typeof template.content === 'string' ? template.content : template.content.toString('utf8');
  let rendered: string;
  try {
    rendered = await renderLiquid(
      source,
      {
        ...data,
        _images: images,
        _branding: { ...(data._branding as object), logo: assets.logo ?? '' },
      },
      'html',
    );
  } catch (err) {
    if (err instanceof TemplateError) throw new RenderError(err.message);
    throw err;
  }
  return templateDocument(documentTitle(model), rendered);
}

/** The HTML that becomes the PDF: a template's, or the built-in layout. */
export async function pdfHtml(
  model: DocumentModel,
  template: TemplateRef | null,
  ctx: RenderContext,
): Promise<string> {
  if (template?.kind === 'html') return templateHtml(model, template, ctx);
  return builtInHtml(model, await embeddedImages(model, ctx));
}

const pdfFile = (stem: string, data: Buffer): RenderedFile => ({
  filename: `${stem}.pdf`,
  contentType: 'application/pdf',
  data,
});

/** PDF: the built-in branded layout or a Liquid HTML template, through Gotenberg; a Word template through LibreOffice. */
export const pdfRenderer: Renderer = {
  format: 'pdf',
  async render(model, template, stem, ctx) {
    if (template?.kind === 'docx') {
      const [docx] = await docxRenderer.render(model, template, stem, ctx);
      if (!docx) throw new RenderError('The Word template produced no document');
      return [pdfFile(stem, await ctx.pdf.officeToPdf(docx.data, docx.filename, ctx.signal))];
    }
    const html = await pdfHtml(model, template, ctx);
    return [pdfFile(stem, await ctx.pdf.htmlToPdf(html, ctx.signal))];
  },
};
