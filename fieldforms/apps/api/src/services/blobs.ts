import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AuthUser } from '../auth/scope.js';
import type { BlobStore } from '../lib/blobstore.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit, type AuditContext } from './audit.js';
import { canViewSubmission } from './form-submissions.js';

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Magic numbers, so a client cannot store arbitrary files by lying about Content-Type. */
function sniff(data: Buffer): string | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  if (
    data.length > 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    data.length > 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/**
 * Stores a photo under a client-generated id. Idempotent: re-sending the same bytes is a no-op;
 * different bytes under an existing id are refused.
 */
export async function putBlob(
  db: Db,
  store: BlobStore,
  user: AuthUser,
  id: string,
  data: Buffer,
): Promise<{ id: string; duplicate: boolean }> {
  const type = sniff(data);
  if (!type) throw badRequest('Only JPEG, PNG or WebP photos are accepted');
  const sha256 = createHash('sha256').update(data).digest('hex');

  const existing = await db
    .selectFrom('blobs')
    .select(['sha256', 'uploaded_by'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (existing) {
    if (existing.sha256 !== sha256 || existing.uploaded_by !== user.id)
      throw conflict('A different photo already has this id');
    return { id, duplicate: true };
  }

  const now = new Date();
  const ext = type.split('/')[1];
  const key = `photos/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${ext}`;
  // Bytes first, then the row: a row never points at a missing object.
  await store.put(key, data, type);
  await db
    .insertInto('blobs')
    .values({
      id,
      sha256,
      content_type: type,
      size_bytes: data.length,
      storage_key: key,
      uploaded_by: user.id,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return { id, duplicate: false };
}

export async function getBlobForUser(
  db: Db,
  store: BlobStore,
  user: AuthUser,
  id: string,
  ctx: AuditContext,
): Promise<{ data: Buffer; contentType: string }> {
  const blob = await db.selectFrom('blobs').selectAll().where('id', '=', id).executeTakeFirst();
  if (!blob) throw notFound();

  let allowed = user.role === 'admin' || blob.uploaded_by === user.id;
  if (!allowed && user.role === 'manager' && user.siteIds) {
    const ref = await db
      .selectFrom('register_submissions')
      .select('id')
      .where((eb) => eb.or([eb('supervisor_photo_id', '=', id), eb('staff_photo_id', '=', id)]))
      .where(
        'site_id',
        'in',
        user.siteIds.length ? user.siteIds : ['00000000-0000-0000-0000-000000000000'],
      )
      .executeTakeFirst();
    allowed = !!ref;
  }
  if (!allowed && user.role !== 'supervisor') {
    // A photo or signature in a form submission is visible to whoever may see that submission.
    const refs = await db
      .selectFrom('form_submission_files as fsf')
      .innerJoin('form_submissions as s', 's.id', 'fsf.submission_id')
      .leftJoin('dispatches as d', 'd.id', 's.dispatch_id')
      .select(['s.site_id', 's.submitted_by', 'd.created_by as dispatch_created_by'])
      .where('fsf.blob_id', '=', id)
      .execute();
    allowed = refs.some((r) => canViewSubmission(user, r));
  }
  if (!allowed) throw notFound();

  const data = await store.get(blob.storage_key);
  if (!data) throw notFound('Photo file is missing from storage');
  await audit(db, ctx, { action: 'photo.view', entity: 'blob', entityId: id });
  return { data, contentType: blob.content_type };
}
