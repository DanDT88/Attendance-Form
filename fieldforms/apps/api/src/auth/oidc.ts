import * as client from 'openid-client';
import type { OidcProviderConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../lib/errors.js';

/**
 * Sign-in with Microsoft 365 or Google Workspace (any OIDC provider). Accounts are never created
 * here: an admin creates the user with their work email first, and the first SSO sign-in binds the
 * provider's subject id to that user. After that the subject, not the email, identifies them.
 */

const discovered = new Map<string, Promise<client.Configuration>>();

function configFor(p: OidcProviderConfig): Promise<client.Configuration> {
  let c = discovered.get(p.id);
  if (!c) {
    c = client.discovery(new URL(p.issuer), p.clientId, p.clientSecret);
    // Do not cache a failed discovery; the provider may just have been unreachable.
    c.catch(() => discovered.delete(p.id));
    discovered.set(p.id, c);
  }
  return c;
}

export interface OidcPending {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
}

export async function startOidc(
  p: OidcProviderConfig,
  redirectUri: string,
): Promise<{ url: string; pending: OidcPending }> {
  const config = await configFor(p);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, pending: { provider: p.id, state, nonce, verifier } };
}

export async function finishOidc(
  p: OidcProviderConfig,
  callbackUrl: URL,
  pending: OidcPending,
): Promise<{ issuer: string; subject: string; email: string | null }> {
  const config = await configFor(p);
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
  });
  const claims = tokens.claims();
  if (!claims) throw new HttpError(401, 'The identity provider returned no ID token');
  const email =
    (typeof claims.email === 'string' && claims.email) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@')
      ? claims.preferred_username
      : null);
  return { issuer: claims.iss, subject: claims.sub, email: email ? email.toLowerCase() : null };
}

/** Finds the FieldForms user for an SSO identity, binding the subject on first use. */
export async function matchOidcUser(
  db: Db,
  identity: { issuer: string; subject: string; email: string | null },
): Promise<string> {
  const bound = await db
    .selectFrom('users')
    .select(['id', 'active'])
    .where('oidc_issuer', '=', identity.issuer)
    .where('oidc_subject', '=', identity.subject)
    .executeTakeFirst();
  if (bound) {
    if (!bound.active) throw new HttpError(403, 'This account is deactivated');
    return bound.id;
  }
  if (!identity.email)
    throw new HttpError(403, 'Your account has no email address that FieldForms recognises');
  const byEmail = await db
    .selectFrom('users')
    .select(['id', 'active', 'role', 'oidc_subject'])
    .where('email', '=', identity.email)
    .executeTakeFirst();
  if (!byEmail || !byEmail.active || byEmail.role === 'supervisor') {
    throw new HttpError(
      403,
      'No FieldForms account for this email. Ask an administrator to add you.',
    );
  }
  if (byEmail.oidc_subject) {
    // The email is already bound to a different identity: refuse rather than silently re-binding.
    throw new HttpError(403, 'This email is linked to a different sign-in. Ask an administrator.');
  }
  await db
    .updateTable('users')
    .set({ oidc_issuer: identity.issuer, oidc_subject: identity.subject })
    .where('id', '=', byEmail.id)
    .execute();
  return byEmail.id;
}
