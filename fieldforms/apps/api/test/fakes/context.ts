import {
  evaluateExpression,
  reservedValues,
  templateData,
  type DocField,
  type DocumentModel,
  type FormDefinition,
  type MappingSource,
} from '@fieldforms/shared';
import {
  DEFAULT_ENDPOINTS,
  type AdapterEnv,
  type DeliveryContext,
  type Endpoints,
} from '../../src/destinations/types.js';
import { renderLiquid } from '../../src/lib/liquid.js';
import { parseNetworkPolicy } from '../../src/lib/netguard.js';
import type { RenderedFile } from '../../src/outputs/types.js';
import { DEF, model as fixtureModel } from '../outputs-fixtures.js';

/** Vendor policy for tests: loopback allowed, so the fakes can stand in for Google and Microsoft. */
export const LOOPBACK = parseNetworkPolicy({
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8',
  DESTINATIONS_ALLOW_SAME_NETWORK: 'true',
});
/** The production policy: public addresses only. */
export const STRICT = parseNetworkPolicy({});

export function makeEnv(endpoints: Partial<Endpoints>, over: Partial<AdapterEnv> = {}): AdapterEnv {
  return {
    policy: STRICT,
    vendorPolicy: LOOPBACK,
    mailer: {
      send: async () => {
        throw new Error('no mail in these tests');
      },
    },
    endpoints: { ...DEFAULT_ENDPOINTS, ...endpoints },
    signal: new AbortController().signal,
    now: () => new Date(),
    emailAttachmentLimit: 10 * 1024 * 1024,
    ...over,
  };
}

/** The pipeline's mapping value (services/delivery-runner.ts), for adapter tests without a DB. */
function mappingValue(
  def: FormDefinition,
  model: DocumentModel,
  source: MappingSource,
  row?: { group: string; index: number },
): unknown {
  if (source.type === 'field') {
    const [a, b] = source.field.split('.');
    const top = (id: string) => model.fields.find((f) => f.id === id);
    const cell = (cells: DocField[] | undefined, id: string) =>
      cells?.find((c) => c.id === id)?.text ?? null;
    if (row) {
      const group = top(row.group);
      if (b && a === row.group) return cell(group?.rows?.[row.index], b);
      if (!b) {
        const sibling = cell(group?.rows?.[row.index], a!);
        if (sibling !== null) return sibling;
      }
    }
    if (b)
      return (
        top(a!)
          ?.rows?.map((cells) => cell(cells, b) ?? '')
          .join(', ') ?? null
      );
    return top(a!)?.text ?? null;
  }
  const r = evaluateExpression(def, model.raw, source.expression, {
    extras: reservedValues(model),
    row,
  });
  if (r.error) throw new Error(r.error);
  return r.value;
}

export const DELIVERY_ID = '9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

export const pdf = (text = 'one'): RenderedFile => ({
  filename: 'Site inspection - abcdef12.pdf',
  contentType: 'application/pdf',
  data: Buffer.from(`%PDF-1.7 ${text}`),
});
export const jsonFile = (text = '{}'): RenderedFile => ({
  filename: 'Site inspection - abcdef12.json',
  contentType: 'application/json',
  data: Buffer.from(text),
});

export function makeCtx(
  over: Partial<Omit<DeliveryContext, 'delivery'>> & {
    delivery?: Partial<DeliveryContext['delivery']>;
    def?: FormDefinition;
  } = {},
): DeliveryContext {
  const { delivery, def = DEF, ...rest } = over;
  const m = rest.model ?? fixtureModel();
  const generation = delivery?.generation ?? 1;
  const id = delivery?.id ?? DELIVERY_ID;
  return {
    delivery: {
      id,
      generation,
      attempt: 1,
      idempotencyKey: `${id}.${generation}`,
      resend: generation > 1,
      ...delivery,
    },
    test: null,
    model: m,
    files: [pdf()],
    json: {},
    value: (source, row) => mappingValue(def, m, source, row),
    liquid: (t, c) => renderLiquid(t, templateData(m), c),
    contacts: { submitterEmail: null, taskSenderEmail: null, siteRecipients: [], siteManagers: [] },
    target: null,
    earlierEvidence: [],
    link: m.submission.url,
    ...rest,
  };
}

/** Everything an error exposes: what the pipeline would store or show. */
export function exposed(err: unknown): string {
  const e = err as { message?: string; detail?: string };
  return `${e?.message ?? ''}\n${e?.detail ?? ''}`;
}
