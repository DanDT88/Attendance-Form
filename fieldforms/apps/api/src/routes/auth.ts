import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyCredentials } from '../auth/login.js';
import { finishOidc, matchOidcUser, startOidc, type OidcPending } from '../auth/oidc.js';
import { auditCtx, clearSessionCookie, requireUser, setSessionCookie } from '../auth/plugin.js';
import { createSession, deleteSession, SESSION_COOKIE } from '../auth/sessions.js';
import type { AppDeps } from '../app.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';

const OIDC_COOKIE = 'ff_oidc';

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, cfg } = deps;
  const authLimit = { rateLimit: { max: cfg.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } };

  async function signIn(reply: import('fastify').FastifyReply, userId: string, req: import('fastify').FastifyRequest) {
    const s = await createSession(db, userId, cfg.SESSION_DAYS, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, cfg, s.token, s.expiresAt);
  }

  app.post('/auth/pin', { config: authLimit }, async (req, reply) => {
    const body = parse(z.object({ employeeNo: z.string().min(1).max(40), pin: z.string().min(1).max(40) }), req.body);
    const user = await verifyCredentials(db, 'pin', body.employeeNo, body.pin, { ip: req.ip, userAgent: req.headers['user-agent'] });
    await signIn(reply, user.id, req);
    return { ok: true };
  });

  app.post('/auth/password', { config: authLimit }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), req.body);
    const user = await verifyCredentials(db, 'password', body.email.toLowerCase(), body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await signIn(reply, user.id, req);
    return { ok: true };
  });

  app.get('/auth/providers', async () => cfg.oidc.map((p) => ({ id: p.id, label: p.label })));

  app.get<{ Params: { provider: string } }>('/auth/oidc/:provider/start', { config: authLimit }, async (req, reply) => {
    const p = cfg.oidc.find((x) => x.id === req.params.provider);
    if (!p) throw notFound('Unknown sign-in provider');
    const redirectUri = `${cfg.PUBLIC_URL}/api/auth/oidc/${p.id}/callback`;
    const { url, pending } = await startOidc(p, redirectUri);
    reply.setCookie(OIDC_COOKIE, JSON.stringify(pending), {
      path: '/api/auth/oidc',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.COOKIE_SECURE,
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get<{ Params: { provider: string } }>('/auth/oidc/:provider/callback', { config: authLimit }, async (req, reply) => {
    const p = cfg.oidc.find((x) => x.id === req.params.provider);
    if (!p) throw notFound('Unknown sign-in provider');
    const raw = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/api/auth/oidc' });
    try {
      if (!raw) throw new Error('Sign-in expired, please try again');
      const pending = JSON.parse(raw) as OidcPending;
      if (pending.provider !== p.id) throw new Error('Sign-in provider mismatch');
      const callbackUrl = new URL(req.url, cfg.PUBLIC_URL);
      const identity = await finishOidc(p, callbackUrl, pending);
      const userId = await matchOidcUser(db, identity);
      await db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', userId).execute();
      await audit(db, { actorUserId: userId, ip: req.ip, userAgent: req.headers['user-agent'] }, {
        action: 'auth.login',
        entity: 'user',
        entityId: userId,
        details: { method: `oidc:${p.id}` },
      });
      await signIn(reply, userId, req);
      return reply.redirect('/');
    } catch (err) {
      await audit(db, { actorUserId: null, ip: req.ip, userAgent: req.headers['user-agent'] }, {
        action: 'auth.failed',
        details: { method: `oidc:${p.id}`, reason: (err as Error).message.slice(0, 200) },
      });
      return reply.redirect(`/login?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    if (req.user) await audit(db, auditCtx(req), { action: 'auth.logout', entity: 'user', entityId: req.user.id });
    clearSessionCookie(reply, cfg);
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const user = requireUser(req);
    const settings = await getSettings(db);
    const consent = await db
      .selectFrom('consents')
      .select('accepted_at')
      .where('user_id', '=', user.id)
      .where('notice_version', '=', settings.privacyNoticeVersion)
      .executeTakeFirst();
    return {
      id: user.id,
      role: user.role,
      displayName: user.displayName,
      siteIds: user.siteIds,
      privacyNotice: { version: settings.privacyNoticeVersion, text: settings.privacyNoticeText },
      consentRequired: !consent,
    };
  });

  app.post('/consent', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ version: z.string().min(1).max(40) }), req.body);
    const settings = await getSettings(db);
    if (body.version !== settings.privacyNoticeVersion) {
      return { ok: false, message: 'The notice has changed; please read the latest version.' };
    }
    await db
      .insertInto('consents')
      .values({ user_id: user.id, notice_version: body.version, ip: req.ip })
      .onConflict((oc) => oc.columns(['user_id', 'notice_version']).doNothing())
      .execute();
    await audit(db, auditCtx(req), { action: 'privacy.consent', entity: 'user', entityId: user.id, details: { version: body.version } });
    return { ok: true };
  });
}
