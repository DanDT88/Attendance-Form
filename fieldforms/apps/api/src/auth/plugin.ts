import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import type { AuditContext } from '../services/audit.js';
import { resolveSiteIds, type AuthUser } from './scope.js';
import { readSession, SESSION_COOKIE } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-fieldforms';

export function setSessionCookie(
  reply: FastifyReply,
  cfg: Config,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.COOKIE_SECURE,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, cfg: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.COOKIE_SECURE,
  });
}

/**
 * Loads the signed-in user on every request and enforces the CSRF header on writes.
 * Routes then call requireUser / requireRole, so access is denied unless a route opts in.
 */
export const authPlugin = fp(async (app: FastifyInstance, opts: { db: Db; cfg: Config }) => {
  const { db, cfg } = opts;
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
      // A cross-site form or fetch cannot set this header without a CORS preflight, which the API
      // never grants, so its presence proves the request came from our own pages.
      throw new HttpError(403, 'Missing request header');
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await readSession(db, token, cfg.SESSION_DAYS);
    if (!session) {
      clearSessionCookie(reply, cfg);
      return;
    }
    if (session.refreshed) setSessionCookie(reply, cfg, token, session.expiresAt);
    req.user = {
      id: session.userId,
      role: session.role,
      displayName: session.displayName,
      siteIds: await resolveSiteIds(db, session.userId, session.role),
    };
  });
});

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: AuthUser['role'][]): AuthUser {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

export function auditCtx(req: FastifyRequest): AuditContext {
  return {
    actorUserId: req.user?.id ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  };
}
