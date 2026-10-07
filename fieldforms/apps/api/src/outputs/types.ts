import type { DocumentModel, Format, MediaRef } from '@fieldforms/shared';

/**
 * Renderers turn the document model (packages/shared/src/documents.ts) into files. The model
 * holds no image bytes; renderers that need pixels ask the media loader, which composites a
 * photo's markup layer, scales it and caches it for the delivery.
 */
export interface LoadedImage {
  data: Buffer;
  contentType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

export interface MediaLoader {
  /**
   * A photo with its markup composited on top (JPEG), or a signature (PNG), scaled so its
   * longest side is at most `maxSide`. Null when the file is missing.
   */
  load(ref: MediaRef, opts: { maxSide: number }): Promise<LoadedImage | null>;
  /** The untouched original photo; only call it when `ref.includeOriginal` is true. */
  original(ref: MediaRef): Promise<LoadedImage | null>;
  /** A company logo (PNG or JPEG), at most `maxSide` px. */
  logo(blobId: string, opts: { maxSide: number }): Promise<LoadedImage | null>;
}

/** Converts documents to PDF (Gotenberg). Throws a transient DeliveryError when it is down. */
export interface PdfConverter {
  htmlToPdf(html: string, signal: AbortSignal): Promise<Buffer>;
  /** Word (and other office files) to PDF through LibreOffice. */
  officeToPdf(file: Buffer, filename: string, signal: AbortSignal): Promise<Buffer>;
}

export interface RenderedFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface TemplateRef {
  templateId: string;
  versionId: string;
  version: number;
  kind: 'html' | 'docx';
  /** HTML text, or the Word file. */
  content: string | Buffer;
}

export interface RenderContext {
  media: MediaLoader;
  pdf: PdfConverter;
  signal: AbortSignal;
  /** e.g. "https://forms.example.co.za/api/v1", for file links in JSON and XML. */
  apiBase: string;
}

/** Embedding limits: a document never carries more than this many images, at this size. */
export const EMBED_MAX_IMAGES = 60;
export const EMBED_MAX_SIDE = 1024;
/** The `images` format delivers photos at this size. */
export const IMAGES_MAX_SIDE = 1600;

export interface Renderer {
  format: Format;
  /**
   * Renders the model, with the template when one is given (it can produce this format).
   * `stem` is the file name without extension, already made safe. Multi-file formats name
   * files deterministically from the stem and media names.
   */
  render(
    model: DocumentModel,
    template: TemplateRef | null,
    stem: string,
    ctx: RenderContext,
  ): Promise<RenderedFile[]>;
}

/** Raised for a template that cannot render this submission: retrying will not help. */
export class RenderError extends Error {
  readonly permanent = true;
}

/** Bump when a renderer's output changes, so cached documents are not reused. */
export const RENDERER_VERSION = 1;
