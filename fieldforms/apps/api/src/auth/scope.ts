import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { forbidden } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  role: 'admin' | 'manager' | 'supervisor';
  displayName: string;
  /** Site ids this user may see. null = every site (admins). */
  siteIds: string[] | null;
}

/** Resolves a user's company / region / site scopes to the set of site ids they cover. */
export async function resolveSiteIds(db: Db, userId: string, role: AuthUser['role']): Promise<string[] | null> {
  if (role === 'admin') return null;
  const rows = await sql<{ id: string }>`
    SELECT DISTINCT s.id
    FROM user_scopes us
    JOIN sites s ON (
         (us.scope_type = 'site'    AND s.id = us.scope_id)
      OR (us.scope_type = 'region'  AND s.region_id = us.scope_id)
      OR (us.scope_type = 'company' AND s.region_id IN (SELECT r.id FROM regions r WHERE r.company_id = us.scope_id))
    )
    WHERE us.user_id = ${userId}
  `.execute(db);
  return rows.rows.map((r) => r.id);
}

export function canSeeSite(user: AuthUser, siteId: string): boolean {
  return user.siteIds === null || user.siteIds.includes(siteId);
}

export function assertSite(user: AuthUser, siteId: string): void {
  if (!canSeeSite(user, siteId)) throw forbidden('That site is outside your access');
}
