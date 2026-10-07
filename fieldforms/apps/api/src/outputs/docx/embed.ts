import type { MediaRef } from '@fieldforms/shared';
import { EMBED_MAX_IMAGES, EMBED_MAX_SIDE, type LoadedImage, type MediaLoader } from '../types.js';

/**
 * Images embedded in one Word document: each photo or signature is loaded once (the same picture
 * used twice is one file), at most EMBED_MAX_IMAGES of them in document order, so a submission
 * with hundreds of photos still makes a document of bounded size. The logo does not count.
 */
export class ImageBudget {
  private readonly loads = new Map<string, Promise<LoadedImage | null>>();
  private logoLoad: Promise<LoadedImage | null> | undefined;
  /** References that were not embedded because the limit was reached. */
  readonly skipped = new Set<string>();

  constructor(
    private readonly media: MediaLoader,
    private readonly signal: AbortSignal,
    private readonly max = EMBED_MAX_IMAGES,
  ) {}

  /** Null when the file is missing or the limit is reached (see `isSkipped`). */
  load(ref: MediaRef): Promise<LoadedImage | null> {
    const key = mediaKey(ref);
    const known = this.loads.get(key);
    if (known) return known;
    if (this.loads.size >= this.max) {
      this.skipped.add(key);
      return Promise.resolve(null);
    }
    this.signal.throwIfAborted();
    const p = this.media.load(ref, { maxSide: EMBED_MAX_SIDE });
    this.loads.set(key, p);
    return p;
  }

  isSkipped(ref: MediaRef): boolean {
    return this.skipped.has(mediaKey(ref));
  }

  logo(blobId: string | null): Promise<LoadedImage | null> {
    if (!blobId) return Promise.resolve(null);
    this.logoLoad ??= this.media.logo(blobId, { maxSide: LOGO_MAX_SIDE });
    return this.logoLoad;
  }
}

/**
 * Runs `tasks` a few at a time. They start in order, so the pictures that claim the budget's
 * slots are the first ones in the document.
 */
export async function inOrder(tasks: (() => Promise<void>)[], concurrency = 4): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

/** One picture: a photo with the same markup layer is the same image wherever it is used. */
export function mediaKey(ref: MediaRef): string {
  return `${ref.kind}:${ref.blobId}:${ref.annotationBlobId ?? ''}`;
}

export const LOGO_MAX_SIDE = 600;

/** Boxes images are fitted into, in centimetres (A4 with 2 cm margins is 17 cm wide). */
export const BOXES = {
  photo: { w: 15, h: 18 },
  photoInCell: { w: 5.5, h: 5.5 },
  signature: { w: 6, h: 3 },
  signatureInCell: { w: 4, h: 2 },
  logo: { w: 6, h: 2.5 },
} as const;
export type Box = { w: number; h: number };

const PX_PER_CM = 96 / 2.54;
/** Word measures drawings in EMU: 914400 per inch, so 9525 per pixel at 96 dpi. */
export const EMU_PER_PX = 9525;

/**
 * The size to show an image at, in pixels at 96 dpi: its own size, scaled down (never up) to fit
 * the box, keeping the aspect ratio.
 */
export function fitToBox(
  img: { width: number; height: number },
  box: Box,
): { w: number; h: number } {
  const w = Math.max(1, img.width);
  const h = Math.max(1, img.height);
  const scale = Math.min(1, (box.w * PX_PER_CM) / w, (box.h * PX_PER_CM) / h);
  // Rounded down, so the picture never spills out of its box.
  return { w: Math.max(1, Math.floor(w * scale)), h: Math.max(1, Math.floor(h * scale)) };
}

/** Several photos of one field share a line: up to three side by side, each in its part of the box. */
export function shareBox(box: Box, count: number): Box {
  const perLine = Math.min(Math.max(1, count), 3);
  if (perLine === 1) return box;
  const w = (box.w - 0.3 * (perLine - 1)) / perLine;
  return { w, h: Math.min(box.h, w * 1.34) };
}
