import type { Db } from '../db/index.js';
import type { BlobStore } from '../lib/blobstore.js';
import type { MediaLoader } from './types.js';

/**
 * Loads photos, markup layers, signatures and logos from the blob store (via the `blobs` table),
 * composites a photo's markup layer over it with sharp, scales to `maxSide` and caches results
 * for the life of the loader (one delivery or download). Sample references (blob ids starting
 * with "sample:") return generated placeholder images, for test sends.
 */
export function createMediaLoader(_db: Db, _blobs: BlobStore): MediaLoader {
  throw new Error('The media loader is not built yet');
}
