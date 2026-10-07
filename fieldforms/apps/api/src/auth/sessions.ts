import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';

export const SESSION_COOKIE = 'ff_session';
/** Avoid a write on every request: only extend a session once it is this old. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Db,
  userId: string,
  days: number,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await db
    .insertInto('sessions')
    .values({
      token_hash: hashToken(token),
      user_id: userId,
      expires_at: expiresAt,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 400) ?? null,
    })
    .execute();
  return { token, expiresAt };
}

export interface SessionUser {
  userId: string;
  role: 'admin' | 'manager' | 'supervisor';
  displayName: string;
  expiresAt: Date;
  /** Set when the sliding expiry moved, so the cookie should be re-sent. */
  refreshed: boolean;
}

/** Looks up a session, rejecting expired sessions and deactivated users; slides the expiry. */
export async function readSession(db: Db, token: string, days: number): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.user_id',
      'sessions.expires_at',
      'sessions.last_seen_at',
      'users.role',
      'users.display_name',
      'users.active',
    ])
    .where('sessions.token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (!row || !row.active) return null;
  const now = Date.now();
  if (row.expires_at.getTime() <= now) {
    await db.deleteFrom('sessions').where('token_hash', '=', tokenHash).execute();
    return null;
  }
  let expiresAt = row.expires_at;
  let refreshed = false;
  if (now - row.last_seen_at.getTime() > REFRESH_AFTER_MS) {
    expiresAt = new Date(now + days * 86_400_000);
    refreshed = true;
    await db
      .updateTable('sessions')
      .set({ last_seen_at: new Date(now), expires_at: expiresAt })
      .where('token_hash', '=', tokenHash)
      .execute();
  }
  return { userId: row.user_id, role: row.role, displayName: row.display_name, expiresAt, refreshed };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute();
}

export async function deleteUserSessions(db: Db, userId: string): Promise<void> {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
}
