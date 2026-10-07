import type { MediaRef } from '@fieldforms/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { DeliveryError } from '../src/destinations/types.js';
import { LocalBlobStore, type BlobStore } from '../src/lib/blobstore.js';
import { createMediaLoader } from '../src/outputs/media.js';

/*
 * The loader against a real blob store and real images. The `blobs` table lookup is a stand-in
 * (one query, by id); documents-service.test.ts runs the loader against Postgres.
 */

const ids = {
  photo: '10000000-0000-4000-8000-000000000001',
  layer: '10000000-0000-4000-8000-000000000002',
  big: '10000000-0000-4000-8000-000000000003',
  small: '10000000-0000-4000-8000-000000000004',
  sig: '10000000-0000-4000-8000-000000000005',
  rotated: '10000000-0000-4000-8000-000000000006',
  exif: '10000000-0000-4000-8000-000000000007',
  svg: '10000000-0000-4000-8000-000000000008',
  gone: '10000000-0000-4000-8000-000000000009',
  logo: '10000000-0000-4000-8000-00000000000a',
  broken: '10000000-0000-4000-8000-00000000000b',
  unknown: '10000000-0000-4000-8000-0000000000ff',
};

let dir: string;
let store: BlobStore;
const keys = new Map<string, string>();
const queried: string[] = [];

function fakeDb(): Db {
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: (_col: string, _op: string, id: string) => ({
          executeTakeFirst: async () => {
            queried.push(id);
            const key = keys.get(id);
            return key ? { storage_key: key } : undefined;
          },
        }),
      }),
    }),
  };
  return db as unknown as Db;
}

async function put(id: string, data: Buffer, ext: string) {
  const key = `photos/test/${id}.${ext}`;
  keys.set(id, key);
  await store.put(key, data, 'image/x');
}

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } });

/** RGB of one pixel. */
async function pixel(data: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data: raw, info } = await sharp(data).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const i = (y * info.width + x) * info.channels;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
}

const near = (rgb: [number, number, number], target: [number, number, number], tol = 40) =>
  rgb.every((v, i) => Math.abs(v - target[i]!) <= tol);

const photo = (blobId: string, annotationBlobId: string | null = null): MediaRef => ({
  kind: 'photo',
  blobId,
  annotationBlobId,
  includeOriginal: true,
  name: 'p-1',
});
const signature = (blobId: string): MediaRef => ({
  kind: 'signature',
  blobId,
  annotationBlobId: null,
  includeOriginal: false,
  name: 'sig',
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ff-media-'));
  store = new LocalBlobStore(dir);
  // A blue 800×600 photo with a markup layer drawn at half size: a red square at (100,100)-(200,200).
  await put(ids.photo, await solid(800, 600, '#0000ff').jpeg().toBuffer(), 'jpeg');
  const layer = await sharp({
    create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await solid(100, 100, '#ff0000').png().toBuffer(),
        left: 100,
        top: 100,
      },
    ])
    .png()
    .toBuffer();
  await put(ids.layer, layer, 'png');
  await put(ids.big, await solid(3000, 2000, '#00aa00').jpeg().toBuffer(), 'jpeg');
  await put(ids.small, await solid(300, 200, '#00aa00').jpeg().toBuffer(), 'jpeg');
  await put(
    ids.sig,
    await sharp({
      create: { width: 1200, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer(),
    'png',
  );
  // Stored 800×600 but marked "rotate 90°": shown as 600×800.
  await put(
    ids.rotated,
    await solid(800, 600, '#888888').jpeg().withMetadata({ orientation: 6 }).toBuffer(),
    'jpeg',
  );
  await put(
    ids.exif,
    await solid(320, 240, '#888888')
      .jpeg()
      .withExif({ IFD0: { Copyright: 'Somebody', ImageDescription: 'GPS-bearing camera' } })
      .toBuffer(),
    'jpeg',
  );
  await put(
    ids.svg,
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///etc/passwd"/></svg>',
    ),
    'svg',
  );
  keys.set(ids.gone, 'photos/test/never-written.jpeg');
  await put(ids.logo, await solid(1000, 500, '#123456').png().toBuffer(), 'png');
  await put(ids.broken, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), 'jpeg');
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('media loader', () => {
  it('draws the markup layer over the photo, scaled to the photo', async () => {
    const media = createMediaLoader(fakeDb(), store);
    const img = (await media.load(photo(ids.photo, ids.layer), { maxSide: 1024 }))!;
    expect(img).toMatchObject({ contentType: 'image/jpeg', width: 800, height: 600 });
    expect((await sharp(img.data).metadata()).format).toBe('jpeg');
    // The layer was half size, so its square lands at (200,200)-(400,400) on the photo.
    expect(near(await pixel(img.data, 300, 300), [255, 0, 0])).toBe(true);
    expect(near(await pixel(img.data, 210, 390), [255, 0, 0])).toBe(true);
    expect(near(await pixel(img.data, 100, 100), [0, 0, 255])).toBe(true);
    expect(near(await pixel(img.data, 600, 500), [0, 0, 255])).toBe(true);

    // Scaled down, the markup stays where it was drawn.
    const half = (await media.load(photo(ids.photo, ids.layer), { maxSide: 400 }))!;
    expect(half).toMatchObject({ width: 400, height: 300 });
    expect(near(await pixel(half.data, 150, 150), [255, 0, 0])).toBe(true);
    expect(near(await pixel(half.data, 50, 50), [0, 0, 255])).toBe(true);

    // Without the layer it is the plain photo.
    const plain = (await media.load(photo(ids.photo), { maxSide: 1024 }))!;
    expect(near(await pixel(plain.data, 300, 300), [0, 0, 255])).toBe(true);
  });

  it('fits the longest side in maxSide and never enlarges', async () => {
    const media = createMediaLoader(fakeDb(), store);
    expect(await media.load(photo(ids.big), { maxSide: 1024 })).toMatchObject({
      width: 1024,
      height: 683,
    });
    expect(await media.load(photo(ids.big), { maxSide: 1600 })).toMatchObject({
      width: 1600,
      height: 1067,
    });
    expect(await media.load(photo(ids.small), { maxSide: 1024 })).toMatchObject({
      width: 300,
      height: 200,
    });
  });

  it('turns photos upright before scaling', async () => {
    const media = createMediaLoader(fakeDb(), store);
    const img = (await media.load(photo(ids.rotated), { maxSide: 400 }))!;
    expect(img).toMatchObject({ width: 300, height: 400 });
    const meta = await sharp(img.data).metadata();
    expect(meta.orientation).toBeUndefined();
  });

  it('keeps signatures as PNG with their transparency', async () => {
    const media = createMediaLoader(fakeDb(), store);
    const img = (await media.load(signature(ids.sig), { maxSide: 600 }))!;
    expect(img).toMatchObject({ contentType: 'image/png', width: 600, height: 200 });
    const meta = await sharp(img.data).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
  });

  it('scales logos and keeps PNG logos PNG', async () => {
    const media = createMediaLoader(fakeDb(), store);
    expect(await media.logo(ids.logo, { maxSide: 400 })).toMatchObject({
      contentType: 'image/png',
      width: 400,
      height: 200,
    });
    expect(await media.logo(ids.unknown, { maxSide: 400 })).toBeNull();
  });

  it('returns originals untouched, but never with their metadata', async () => {
    const media = createMediaLoader(fakeDb(), store);
    const plain = (await media.original(photo(ids.small)))!;
    expect(plain.data.equals((await store.get(keys.get(ids.small)!))!)).toBe(true);
    expect(plain).toMatchObject({ contentType: 'image/jpeg', width: 300, height: 200 });

    expect((await sharp((await store.get(keys.get(ids.exif)!))!).metadata()).exif).toBeDefined();
    const cleaned = (await media.original(photo(ids.exif)))!;
    const meta = await sharp(cleaned.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(cleaned.data.includes(Buffer.from('Somebody'))).toBe(false);
    expect(cleaned).toMatchObject({ contentType: 'image/jpeg', width: 320, height: 240 });
  });

  it('returns null for missing, unknown, undecodable and non-photo files', async () => {
    const media = createMediaLoader(fakeDb(), store);
    expect(await media.load(photo(ids.unknown), { maxSide: 100 })).toBeNull();
    expect(await media.load(photo(ids.gone), { maxSide: 100 })).toBeNull();
    expect(await media.load(photo(ids.broken), { maxSide: 100 })).toBeNull();
    // SVG could pull in other files; only JPEG, PNG and WebP are read.
    expect(await media.load(photo(ids.svg), { maxSide: 100 })).toBeNull();
    expect(await media.original(photo(ids.svg))).toBeNull();
    expect(await media.logo(ids.svg, { maxSide: 100 })).toBeNull();
    // Not an id at all: not even looked up.
    const before = queried.length;
    expect(await media.load(photo('../../etc/passwd'), { maxSide: 100 })).toBeNull();
    expect(queried.length).toBe(before);
  });

  it('keeps the photo when its markup layer is broken', async () => {
    const media = createMediaLoader(fakeDb(), store);
    const img = (await media.load(photo(ids.photo, ids.broken), { maxSide: 200 }))!;
    expect(img).toMatchObject({ width: 200, height: 150 });
  });

  it('generates placeholders for sample references without touching storage', async () => {
    const before = queried.length;
    const media = createMediaLoader(fakeDb(), store);
    const p = (await media.load(photo('sample:photo:1'), { maxSide: 800 }))!;
    expect(p).toMatchObject({ contentType: 'image/jpeg', width: 800, height: 600 });
    expect((await sharp(p.data).metadata()).format).toBe('jpeg');
    const s = (await media.load(signature('sample:signature'), { maxSide: 300 }))!;
    expect(s).toMatchObject({ contentType: 'image/png', width: 300, height: 100 });
    expect((await sharp(s.data).stats()).isOpaque).toBe(false);
    expect(await media.original(photo('sample:photo:1'))).toMatchObject({ width: 1200 });
    expect(await media.logo('sample:logo', { maxSide: 64 })).toMatchObject({ width: 64 });
    expect(queried.length).toBe(before);
  });

  it('caches per loader', async () => {
    let gets = 0;
    const counting: BlobStore = {
      put: (k, d, t) => store.put(k, d, t),
      get: (k) => {
        gets++;
        return store.get(k);
      },
      ensureReady: () => store.ensureReady(),
    };
    const media = createMediaLoader(fakeDb(), counting);
    const a = await media.load(photo(ids.photo, ids.layer), { maxSide: 500 });
    const b = await media.load(photo(ids.photo, ids.layer), { maxSide: 500 });
    expect(a).toBe(b);
    expect(gets).toBe(2); // the photo and its layer, once
    await media.load(photo(ids.photo, ids.layer), { maxSide: 300 });
    expect(gets).toBe(4);
    await createMediaLoader(fakeDb(), counting).load(photo(ids.photo, ids.layer), {
      maxSide: 500,
    });
    expect(gets).toBe(6);
  });

  it('fails with a retryable error, not a missing photo, when storage is down', async () => {
    const down: BlobStore = {
      put: async () => undefined,
      get: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:9000 secret=abc');
      },
      ensureReady: async () => undefined,
    };
    const media = createMediaLoader(fakeDb(), down);
    const err = await media.load(photo(ids.photo), { maxSide: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err).toMatchObject({ permanent: false, errorClass: 'internal' });
    expect(`${err.message} ${err.detail}`).not.toContain('10.0.0.5');
  });
});
