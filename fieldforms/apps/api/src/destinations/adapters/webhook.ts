import { createHash } from 'node:crypto';
import type { DestinationSettings } from '@fieldforms/shared';
import {
  postJson,
  webhookEndpoint,
  webhookHeaders,
  webhookTarget,
} from '../connections/webhook.js';
import { DeliveryError, httpError, type DestinationAdapter } from '../types.js';

/**
 * Webhook destination: POSTs the submission as JSON to the connection's URL.
 *
 *   { event: "submission", test, delivery: { id, generation, attempt }, submission,
 *     files?: [{ filename, contentType, size, sha256, data (base64) }] }
 *
 * Every request of one generation carries the same `Idempotency-Key` (`<delivery id>.<generation>`),
 * so a receiver can drop the repeat of a retry whose reply was lost, and answer 409 to say it
 * already has it. A resend is a new generation and carries `X-FieldForms-Resend: 1`; a test send
 * carries `X-FieldForms-Test: 1` (and `test: true` in the body).
 */
type Settings = DestinationSettings<'webhook'>;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export const webhookAdapter: DestinationAdapter<Settings> = {
  kind: 'webhook',

  async deliver(ctx, s, conn, env) {
    const { url, signingSecret } = webhookEndpoint(conn);
    const secrets = conn?.secrets ?? {};
    const payload: Record<string, unknown> = {
      event: 'submission',
      test: !!ctx.test,
      delivery: {
        id: ctx.delivery.id,
        generation: ctx.delivery.generation,
        attempt: ctx.delivery.attempt,
      },
      submission: ctx.json,
    };
    if (s.includeFiles)
      payload.files = ctx.files.map((f) => ({
        filename: f.filename,
        contentType: f.contentType,
        size: f.data.length,
        sha256: sha256(f.data),
        data: f.data.toString('base64'),
      }));
    const body = JSON.stringify(payload);
    const extra: Record<string, string> = {
      'X-FieldForms-Delivery': ctx.delivery.idempotencyKey,
      'Idempotency-Key': ctx.delivery.idempotencyKey,
    };
    if (ctx.delivery.resend) extra['X-FieldForms-Resend'] = '1';
    if (ctx.test) extra['X-FieldForms-Test'] = '1';

    const r = await postJson(
      url,
      body,
      webhookHeaders(body, signingSecret, env.now(), extra),
      env.policy,
      env,
      'the receiver',
      secrets,
    );
    const target = webhookTarget(url);
    const evidence = { status: r.status, contentLength: r.contentLength, sha256: r.sha256 };
    if (r.status >= 200 && r.status < 300) return { outcome: 'delivered', target, evidence };
    if (r.status === 409) return { outcome: 'already_present', target, evidence };
    if (r.status >= 300 && r.status < 400)
      throw new DeliveryError(`Receiver returned HTTP ${r.status} (redirects are not followed)`, {
        permanent: true,
        errorClass: 'rejected',
        status: r.status,
      });
    throw httpError('Receiver', r.status);
  },
};
