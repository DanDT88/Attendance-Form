import type { Db } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import { audit, type AuditContext } from '../services/audit.js';
import { dummyVerify, verifySecret } from './passwords.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

const INVALID = 'Invalid sign-in details';

type Method = 'pin' | 'password';

/**
 * Verifies a PIN (supervisors, by employee number) or a password (managers and admins, by email).
 * Unknown accounts take as long as known ones, and five failures lock the account for 15 minutes.
 */
export async function verifyCredentials(
  db: Db,
  method: Method,
  identifier: string,
  secret: string,
  ctx: Omit<AuditContext, 'actorUserId'>,
): Promise<{ id: string }> {
  const ident = identifier.trim();
  const user = await db
    .selectFrom('users')
    .select([
      'id',
      'role',
      'active',
      'pin_hash',
      'password_hash',
      'failed_attempts',
      'locked_until',
    ])
    .where(method === 'pin' ? 'employee_no' : 'email', '=', ident)
    .executeTakeFirst();

  const eligible =
    user &&
    user.active &&
    (method === 'pin' ? user.role === 'supervisor' : user.role !== 'supervisor');

  if (!user || !eligible) {
    await dummyVerify(secret);
    await audit(
      db,
      { ...ctx, actorUserId: null },
      {
        action: 'auth.failed',
        details: { method, identifier: ident.slice(0, 100), reason: 'unknown_or_ineligible' },
      },
    );
    throw new HttpError(401, INVALID);
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    await audit(
      db,
      { ...ctx, actorUserId: user.id },
      { action: 'auth.locked', entity: 'user', entityId: user.id },
    );
    throw new HttpError(423, `Too many attempts. Try again after ${LOCKOUT_MINUTES} minutes.`);
  }

  const ok = await verifySecret(method === 'pin' ? user.pin_hash : user.password_hash, secret);
  if (!ok) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await db
      .updateTable('users')
      .set({
        failed_attempts: lock ? 0 : attempts,
        locked_until: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.locked_until,
      })
      .where('id', '=', user.id)
      .execute();
    await audit(
      db,
      { ...ctx, actorUserId: user.id },
      {
        action: lock ? 'auth.lockout' : 'auth.failed',
        entity: 'user',
        entityId: user.id,
        details: { method, attempts },
      },
    );
    if (lock)
      throw new HttpError(423, `Too many attempts. Try again after ${LOCKOUT_MINUTES} minutes.`);
    throw new HttpError(401, INVALID);
  }

  await db
    .updateTable('users')
    .set({ failed_attempts: 0, locked_until: null, last_login_at: new Date() })
    .where('id', '=', user.id)
    .execute();
  await audit(
    db,
    { ...ctx, actorUserId: user.id },
    {
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      details: { method },
    },
  );
  return { id: user.id };
}
