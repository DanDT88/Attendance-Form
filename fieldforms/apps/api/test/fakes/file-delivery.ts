import {
  buildDocumentModel,
  INCLUDE_ALL,
  templateData,
  type FormDefinition,
} from '@fieldforms/shared';
import {
  DEFAULT_ENDPOINTS,
  type AdapterEnv,
  type DeliveryContext,
} from '../../src/destinations/types.js';
import { renderLiquid } from '../../src/lib/liquid.js';
import { parseNetworkPolicy, type NetworkPolicy } from '../../src/lib/netguard.js';
import type { RenderedFile } from '../../src/outputs/types.js';

/** Delivery contexts and adapter environments for the file destinations' tests (SFTP, S3). */

/** Tests: loopback and this machine allowed, so in-process fakes can stand in. */
export const LOOPBACK = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
/** Production default: public addresses only. */
export const STRICT = parseNetworkPolicy({});

export function adapterEnv(
  policy: NetworkPolicy = LOOPBACK,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): AdapterEnv {
  return {
    policy,
    vendorPolicy: policy,
    mailer: {
      send: async () => {
        throw new Error('no mail in these tests');
      },
    },
    endpoints: DEFAULT_ENDPOINTS,
    signal,
    now: () => new Date('2026-10-07T08:00:00Z'),
    emailAttachmentLimit: 10 * 1024 * 1024,
  };
}

const definition: FormDefinition = {
  schemaVersion: 1,
  title: 'Site inspection',
  settings: { siteRequired: false },
  fields: [],
};

export interface ContextOptions {
  submissionId?: string;
  deliveryId?: string;
  generation?: number;
  attempt?: number;
  files?: RenderedFile[];
  test?: boolean;
  target?: Record<string, unknown> | null;
  site?: string;
}

export const pdf = (name: string, text: string): RenderedFile => ({
  filename: name,
  contentType: 'application/pdf',
  data: Buffer.from(`%PDF-1.7 ${text}`),
});

export function fileContext(o: ContextOptions = {}): DeliveryContext {
  const submissionId = o.submissionId ?? 'abcdef12-0000-4000-8000-000000000001';
  const deliveryId = o.deliveryId ?? '11111111-2222-4333-8444-555555555555';
  const generation = o.generation ?? 1;
  const model = buildDocumentModel(
    definition,
    {},
    {
      form: { id: 'f', name: 'Site inspection', version: 1, versionId: 'v' },
      submission: {
        id: submissionId,
        receivedAt: '2026-10-07T08:00:00Z',
        capturedAt: '2026-10-07T07:55:00Z',
        clockSkewFlag: false,
        siteId: null,
        site: o.site ?? 'Durban North',
        region: 'KZN',
        company: 'Delta Facilities',
        submittedBy: '',
        taskTitle: '',
        url: '',
      },
      branding: { name: '', colour: '#000000', logoBlobId: null, footer: '' },
    },
    { include: INCLUDE_ALL },
  );
  const data = templateData(model);
  return {
    delivery: {
      id: deliveryId,
      generation,
      attempt: o.attempt ?? 1,
      idempotencyKey: `${deliveryId}.${generation}`,
      resend: generation > 1,
    },
    test: o.test ? { tester: { email: 'admin@example.com', name: 'Admin' } } : null,
    model,
    files: o.files ?? [pdf(`Site inspection ${submissionId.slice(0, 8)}.pdf`, 'one')],
    json: {},
    value: () => null,
    liquid: (template, context) => renderLiquid(template, data, context),
    contacts: { submitterEmail: null, taskSenderEmail: null, siteRecipients: [], siteManagers: [] },
    target: o.target ?? null,
    link: '',
  };
}
