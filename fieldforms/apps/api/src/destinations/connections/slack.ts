import type { Response } from 'undici';
import { z } from 'zod';
import { guardedFetch, readLimited } from '../../lib/netguard.js';
import {
  DEFAULT_ENDPOINTS,
  DeliveryError,
  httpError,
  type AdapterEnv,
  type ConnectionDriver,
  type OpenConnection,
} from '../types.js';
import { requestError, WEBHOOK_TIMEOUT_MS } from './webhook.js';

/**
 * Slack connections: one incoming-webhook URL (a secret: it is the only credential). It must be
 * a Slack URL (`env.endpoints.slackHooks`, https://hooks.slack.com/… in production), so a stored
 * URL can never be pointed at another host, and the request uses the vendor network policy.
 * Messages carry text only: no files and nothing beyond what the message template renders.
 */
export const slackSecretSchema = z
  .object({
    webhookUrl: z
      .string()
      .trim()
      .max(500)
      .regex(
        DEFAULT_ENDPOINTS.slackHooks,
        'An incoming webhook URL from Slack (https://hooks.slack.com/…)',
      ),
  })
  .strict();

const notSlack = () =>
  new DeliveryError('The Slack webhook URL is not a Slack incoming webhook', {
    permanent: true,
    errorClass: 'settings',
  });

/** The connection's webhook URL, if it matches Slack's pattern (as typed and as parsed). */
export function slackHookUrl(conn: OpenConnection | null, env: AdapterEnv): URL {
  const raw = conn?.secrets.webhookUrl;
  if (!raw)
    throw new DeliveryError('The Slack webhook URL is not set', {
      permanent: true,
      errorClass: 'settings',
    });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw notSlack();
  }
  const pattern = new RegExp(
    env.endpoints.slackHooks.source,
    env.endpoints.slackHooks.flags.replace(/[gy]/g, ''),
  );
  if (!pattern.test(raw) || !pattern.test(url.href)) throw notSlack();
  return url;
}

/** Slack's error replies are short codes; only these are ever quoted back. */
const SLACK_ERRORS = new Set([
  'invalid_payload',
  'invalid_blocks',
  'invalid_blocks_format',
  'invalid_attachments',
  'no_text',
  'missing_text_or_fallback_or_attachments',
  'msg_too_long',
  'too_many_attachments',
  'user_not_found',
  'channel_not_found',
  'channel_is_archived',
  'action_prohibited',
  'posting_to_general_channel_denied',
  'invalid_token',
  'no_service',
  'no_service_id',
  'no_team',
  'team_disabled',
  'invalid_team',
]);

async function errorCode(res: Response): Promise<string | null> {
  try {
    const text = (await readLimited(res, 64)).toString('utf8').trim();
    return SLACK_ERRORS.has(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Slack's answers: 400 is a message it will not take; 403, 404 and 410 mean the webhook no
 * longer works (a revoked token, a deleted or archived channel), which only an admin can fix;
 * 429 and 5xx are worth retrying.
 */
export function slackError(status: number, code: string | null = null): DeliveryError {
  const message = `Slack returned HTTP ${status}${code ? ` (${code})` : ''}`;
  if (status === 400)
    return new DeliveryError(message, { permanent: true, errorClass: 'rejected', status });
  if (status === 403 || status === 404 || status === 410)
    return new DeliveryError(message, { permanent: true, errorClass: 'credentials', status });
  if (status >= 300 && status < 400)
    return new DeliveryError(`${message} (redirects are not followed)`, {
      permanent: true,
      errorClass: 'rejected',
      status,
    });
  const e = httpError('Slack', status);
  return new DeliveryError(message, {
    permanent: e.permanent,
    errorClass: e.errorClass,
    status,
  });
}

/** Posts `{ text }` to the webhook; returns the status of a 2xx reply, throws otherwise. */
export async function postToSlack(
  url: URL,
  text: string,
  env: AdapterEnv,
  secrets: Record<string, string>,
): Promise<number> {
  let res: Response;
  try {
    res = await guardedFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'FieldForms' },
        body: JSON.stringify({ text }),
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        signal: env.signal,
      },
      env.vendorPolicy,
    );
  } catch (err) {
    throw requestError(err, 'Slack', secrets);
  }
  if (res.status >= 200 && res.status < 300) {
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  }
  const code = res.status >= 400 && res.status < 500 ? await errorCode(res) : null;
  await res.body?.cancel().catch(() => undefined);
  throw slackError(res.status, code);
}

/** Where a message went, for the delivery log: the channel's label, never the URL. */
export function slackTarget(conn: OpenConnection | null): Record<string, unknown> {
  const label = conn?.config.channelLabel;
  return { service: 'slack', channel: typeof label === 'string' && label ? label : null };
}

export const slackDriver: ConnectionDriver = {
  kind: 'slack',
  secretSchema: slackSecretSchema,

  /** Posts "FieldForms is connected" to the channel and reports Slack's answer. */
  async check(conn, env) {
    const url = slackHookUrl(conn, env);
    const facts: Record<string, string> = {};
    const channel = slackTarget(conn).channel;
    if (typeof channel === 'string') facts.channel = channel;
    try {
      const status = await postToSlack(url, 'FieldForms is connected', env, conn.secrets);
      return { ok: true, summary: `Posted a message to Slack (HTTP ${status})`, facts };
    } catch (err) {
      if (err instanceof DeliveryError && err.status)
        return { ok: false, summary: err.message, facts };
      throw err;
    }
  },
};
