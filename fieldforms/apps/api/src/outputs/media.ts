import type { MediaRef } from '@fieldforms/shared';
import sharp, { type SharpOptions } from 'sharp';
import type { Db } from '../db/index.js';
import { DeliveryError } from '../destinations/types.js';
import type { BlobStore } from '../lib/blobstore.js';
import type { LoadedImage, MediaLoader } from './types.js';

/**
 * Loads photos, markup layers, signatures and logos from the blob store (via the `blobs` table),
 * composites a photo's markup layer over it with sharp, scales to `maxSide` and caches results
 * for the life of the loader (one delivery or download). Sample references (blob ids starting
 * with "sample:") return generated placeholder images, for test sends.
 */
export function createMediaLoader(db: Db, blobs: BlobStore): MediaLoader {
  const cache = new Map<string, Promise<LoadedImage | null>>();
  const cached = (key: string, make: () => Promise<LoadedImage | null>) => {
    let p = cache.get(key);
    if (!p) {
      p = make();
      cache.set(key, p);
      // A failed read (storage down) may succeed on the next call; a missing file stays null.
      p.catch(() => cache.delete(key));
    }
    return p;
  };

  async function read(blobId: string): Promise<Buffer | null> {
    if (!UUID.test(blobId)) return null;
    const row = await db
      .selectFrom('blobs')
      .select('storage_key')
      .where('id', '=', blobId)
      .executeTakeFirst();
    if (!row) return null;
    try {
      return await blobs.get(row.storage_key);
    } catch {
      // Returning null here would cache a document without its photos for good.
      throw new DeliveryError('Stored files could not be read', {
        permanent: false,
        errorClass: 'internal',
        detail: 'blob store read failed',
      });
    }
  }

  return {
    load(ref, { maxSide }) {
      const key = `load:${ref.kind}:${ref.blobId}:${ref.annotationBlobId ?? ''}:${maxSide}`;
      return cached(key, async () => {
        if (isSample(ref.blobId)) return samplePlaceholder(ref, maxSide);
        const base = await read(ref.blobId);
        if (!base) return null;
        if (ref.kind === 'signature') return scaled(base, maxSide, 'png');
        const layer = ref.annotationBlobId ? await read(ref.annotationBlobId) : null;
        return composite(base, layer, maxSide);
      });
    },
    original(ref) {
      return cached(`original:${ref.blobId}`, async () => {
        if (isSample(ref.blobId)) return samplePlaceholder(ref, SAMPLE_ORIGINAL_SIDE);
        const data = await read(ref.blobId);
        return data ? untouched(data) : null;
      });
    },
    logo(blobId, { maxSide }) {
      return cached(`logo:${blobId}:${maxSide}`, async () => {
        if (isSample(blobId)) return sampleLogo(maxSide);
        const data = await read(blobId);
        return data ? scaled(data, maxSide, 'auto') : null;
      });
    },
  };
}

/** An image as a data: URI, the only kind of image a generated HTML page may show. */
export function dataUri(img: LoadedImage): string {
  return `data:${img.contentType};base64,${img.data.toString('base64')}`;
}

/**
 * Maps with at most `limit` calls in flight, keeping the order of `items`. Image work is CPU
 * and memory heavy; a document with sixty photos should not decode them all at once.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSample = (blobId: string) => blobId.startsWith('sample:');

/** Photos are uploaded as JPEG, PNG or WebP. Anything else (SVG could load other files) is refused. */
const ACCEPTED = new Set(['jpeg', 'png', 'webp']);
/** Phone sensors stay below this; a small PNG that decodes to gigapixels does not. */
const INPUT: SharpOptions = { limitInputPixels: 50_000_000 };
const JPEG_QUALITY = 80;

/** Dimensions that fit inside maxSide × maxSide, never enlarged. */
function fit(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Metadata of an accepted image, or null when it cannot be decoded or is not a photo format. */
async function inspect(data: Buffer) {
  try {
    const meta = await sharp(data, INPUT).metadata();
    return ACCEPTED.has(meta.format) ? meta : null;
  } catch {
    return null;
  }
}

/**
 * A photo with its markup layer on top, as JPEG. The layer was drawn over the photo as shown
 * (upright), so the photo is auto-oriented first and the layer stretched to the photo's size.
 */
async function composite(
  base: Buffer,
  layer: Buffer | null,
  maxSide: number,
): Promise<LoadedImage | null> {
  const meta = await inspect(base);
  if (!meta) return null;
  const size = fit(meta.autoOrient.width, meta.autoOrient.height, maxSide);
  try {
    // Flatten first (a PNG or WebP photo may be transparent), then draw the layer over it.
    const flat = await sharp(base, { ...INPUT, autoOrient: true })
      .resize(size.width, size.height, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let img = sharp(flat.data, {
      raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels },
    });
    const overlay = layer && (await inspect(layer)) ? await scaledLayer(layer, size) : null;
    if (overlay) img = img.composite([{ input: overlay, top: 0, left: 0 }]);
    const out = await img.jpeg({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true });
    return {
      data: out.data,
      contentType: 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    return null;
  }
}

async function scaledLayer(layer: Buffer, size: { width: number; height: number }) {
  try {
    return await sharp(layer, INPUT)
      .resize(size.width, size.height, { fit: 'fill' })
      .ensureAlpha()
      .png()
      .toBuffer();
  } catch {
    // A broken markup layer should not cost the photo itself.
    return null;
  }
}

/**
 * A signature (PNG, transparency kept) or a logo (PNG when it may be transparent, else JPEG),
 * scaled to fit maxSide.
 */
async function scaled(
  data: Buffer,
  maxSide: number,
  as: 'png' | 'auto',
): Promise<LoadedImage | null> {
  const meta = await inspect(data);
  if (!meta) return null;
  const png = as === 'png' || meta.format !== 'jpeg' || !!meta.hasAlpha;
  try {
    const img = sharp(data, { ...INPUT, autoOrient: true }).resize({
      width: maxSide,
      height: maxSide,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const out = await (png ? img.png() : img.jpeg({ quality: 85 })).toBuffer({
      resolveWithObject: true,
    });
    return {
      data: out.data,
      contentType: png ? 'image/png' : 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    return null;
  }
}

/**
 * The original photo. JPEG and PNG files without metadata are returned byte for byte; a file
 * that carries EXIF, XMP or IPTC (which can hold the GPS position, excluded unless the
 * destination includes location) or is WebP is re-encoded upright without it.
 */
async function untouched(data: Buffer): Promise<LoadedImage | null> {
  const meta = await inspect(data);
  if (!meta) return null;
  const { width, height } = meta.autoOrient;
  const clean = !meta.exif && !meta.xmp && !meta.iptc && !meta.orientation;
  if (clean && meta.format === 'jpeg') return { data, contentType: 'image/jpeg', width, height };
  if (clean && meta.format === 'png') return { data, contentType: 'image/png', width, height };
  try {
    const png = meta.format === 'png' || !!meta.hasAlpha;
    const img = sharp(data, { ...INPUT, autoOrient: true });
    const out = await (png ? img.png() : img.jpeg({ quality: 92 })).toBuffer({
      resolveWithObject: true,
    });
    return {
      data: out.data,
      contentType: png ? 'image/png' : 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- sample placeholders

const SAMPLE_ORIGINAL_SIDE = 1200;

const samplePhotoSvg = (
  label: string,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<rect width="1200" height="900" fill="#dfe5ec"/>
<circle cx="900" cy="230" r="90" fill="#f2c94c"/>
<path d="M0 760 L320 420 L560 680 L760 500 L1200 820 L1200 900 L0 900 Z" fill="#8aa1b8"/>
<path d="M0 820 L260 640 L520 800 L820 620 L1200 860 L1200 900 L0 900 Z" fill="#5f7d99"/>
<rect x="300" y="380" width="600" height="140" rx="16" fill="#ffffff" fill-opacity="0.85"/>
<text x="600" y="470" font-family="sans-serif" font-size="64" font-weight="bold" fill="#1b365d" text-anchor="middle">${label}</text>
</svg>`;

const SAMPLE_SIGNATURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
<path d="M40 140 C 80 40, 120 40, 130 120 S 170 180, 200 100 S 250 30, 270 110 C 285 170, 320 160, 340 90 C 355 50, 380 60, 385 120 C 390 160, 430 150, 460 100 S 520 80, 560 120" fill="none" stroke="#1b365d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M60 170 L540 170" stroke="#9aa5b1" stroke-width="2"/>
</svg>`;

const SAMPLE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<rect width="400" height="400" rx="60" fill="#ffffff"/>
<text x="200" y="230" font-family="sans-serif" font-size="88" font-weight="bold" fill="#1b365d" text-anchor="middle">LOGO</text>
</svg>`;

async function fromSvg(svg: string, maxSide: number, as: 'jpeg' | 'png'): Promise<LoadedImage> {
  const img = sharp(Buffer.from(svg)).resize({
    width: maxSide,
    height: maxSide,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const out = await (as === 'png' ? img.png() : img.jpeg({ quality: JPEG_QUALITY })).toBuffer({
    resolveWithObject: true,
  });
  return {
    data: out.data,
    contentType: as === 'png' ? 'image/png' : 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  };
}

function samplePlaceholder(ref: MediaRef, maxSide: number): Promise<LoadedImage> {
  return ref.kind === 'signature'
    ? fromSvg(SAMPLE_SIGNATURE_SVG, maxSide, 'png')
    : fromSvg(samplePhotoSvg('Sample photo'), maxSide, 'jpeg');
}

function sampleLogo(maxSide: number): Promise<LoadedImage> {
  return fromSvg(SAMPLE_LOGO_SVG, maxSide, 'png');
}
