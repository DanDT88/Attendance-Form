import type { Db } from '../db/index.js';

export interface AuditContext {
  actorUserId: string | null;
  /** Set instead of actorUserId for calls made with an API key (/api/v1). */
  actorApiKeyId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEvent {
  action: string;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

/**
 * Appends to the audit log. The table is append-only (trigger + no UPDATE/DELETE grant).
 * Callers that change data pass their transaction so the audit row commits with the change.
 */
export async function audit(db: Db, ctx: AuditContext, ev: AuditEvent): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      actor_user_id: ctx.actorApiKeyId ? null : ctx.actorUserId,
      actor_api_key_id: ctx.actorApiKeyId ?? null,
      action: ev.action,
      entity: ev.entity ?? null,
      entity_id: ev.entityId ?? null,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent?.slice(0, 400) ?? null,
      details: ev.details ? JSON.stringify(ev.details) : null,
    })
    .execute();
}
