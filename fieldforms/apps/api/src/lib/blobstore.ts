import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

/** Where photo bytes live. Metadata (hash, size, type, uploader) is in the `blobs` table. */
export interface BlobStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  ensureReady(): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]*$/i;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe blob key: ${key}`);
}

export class LocalBlobStore implements BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename so a crash never leaves a half-written photo under the final name.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      return await readFile(join(this.root, key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    opts: { endpoint?: string; region: string; accessKey?: string; secretKey?: string; forcePathStyle: boolean },
  ) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials:
        opts.accessKey && opts.secretKey
          ? { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey }
          : undefined,
    });
  }

  async ensureReady(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }
}

export function createBlobStore(cfg: Config): BlobStore {
  if (cfg.BLOB_STORE === 's3') {
    return new S3BlobStore(cfg.S3_BUCKET, {
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      accessKey: cfg.S3_ACCESS_KEY,
      secretKey: cfg.S3_SECRET_KEY,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalBlobStore(cfg.BLOB_LOCAL_DIR);
}
