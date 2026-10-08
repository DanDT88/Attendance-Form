import { DISPLAY_TZ, wallClockToUtc } from '@fieldforms/shared';
import { Liquid, type LiquidOptions } from 'liquidjs';

/**
 * Liquid for admin-written templates (PDF HTML, XLSX cells, file names, subjects, Slack messages).
 *
 * The defaults of liquidjs are unsafe for this: partials load from the file system (a template
 * could `{% include "/proc/self/environ" %}`) and nothing is escaped. Here every engine has an
 * empty in-memory partials map (include/render/layout can never touch the disk), sees only own
 * properties of plain data, has parse, render and memory limits, and escapes every output for the
 * context it is written into. `| raw` is replaced so a template cannot opt out of escaping.
 */
export type LiquidContext = 'html' | 'slack' | 'line' | 'text';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
/** Slack mrkdwn: only &, < and > are special (they make links and @channel mentions). */
const escapeSlack = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
/** One line (a subject, a file name, a cell): no line breaks or control characters. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
// eslint-disable-next-line no-control-regex
const noControl = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

const ESCAPERS: Record<LiquidContext, (s: string) => string> = {
  html: escapeHtml,
  slack: escapeSlack,
  line: oneLine,
  text: noControl,
};

/**
 * A date or date and time with no offset ('2026-10-31 23:30', as `_captured` and `_received` are
 * written): South African wall-clock time. liquidjs would read it in the process time zone (UTC in
 * the images) and then show it in SAST, two hours late.
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const DATE_FILTERS = [
  'date',
  'date_to_xmlschema',
  'date_to_rfc822',
  'date_to_string',
  'date_to_long_string',
];

const base: LiquidOptions = {
  templates: {},
  relativeReference: false,
  dynamicPartials: false,
  strictFilters: true,
  strictVariables: false,
  ownPropertyOnly: true,
  timezoneOffset: 'Africa/Johannesburg',
  parseLimit: 100_000,
  renderLimit: 2_000,
  memoryLimit: 10_000_000,
  cache: 50,
};

function engine(context: LiquidContext): Liquid {
  const escape = ESCAPERS[context];
  const liquid = new Liquid({
    ...base,
    outputEscape: (v: unknown) => escape(v === null || v === undefined ? '' : String(v)),
  });
  // `raw` would bypass outputEscape; make it a no-op so escaping always applies.
  liquid.registerFilter('raw', (v: unknown) => v);
  for (const name of DATE_FILTERS) {
    const builtin = liquid.filters[name] as (this: unknown, ...args: unknown[]) => unknown;
    liquid.registerFilter(name, function (v: unknown, ...args: unknown[]) {
      const at =
        typeof v === 'string' && WALL_CLOCK.test(v)
          ? wallClockToUtc(v.replace(' ', 'T'), DISPLAY_TZ)
          : v;
      return builtin.call(this, at, ...args);
    });
  }
  return liquid;
}

const engines = new Map<LiquidContext, Liquid>();
function get(context: LiquidContext): Liquid {
  let e = engines.get(context);
  if (!e) engines.set(context, (e = engine(context)));
  return e;
}

export class TemplateError extends Error {
  readonly permanent = true;
}

/** The engine (configured as above) for code that parses and analyses templates without rendering. */
export function liquidParser(): Liquid {
  return get('text');
}

/** Parses a template so errors are reported when it is saved, not when it is first used. */
export function checkLiquid(source: string): string | null {
  try {
    get('text').parse(source);
    return null;
  } catch (err) {
    return (err as Error).message.split('\n')[0] ?? 'Invalid template';
  }
}

export async function renderLiquid(
  source: string,
  data: object,
  context: LiquidContext,
): Promise<string> {
  try {
    const out = await get(context).parseAndRender(source, data);
    return context === 'line' ? oneLine(out).trim() : out;
  } catch (err) {
    throw new TemplateError(`Template error: ${(err as Error).message.split('\n')[0]}`);
  }
}

/**
 * A file name from a rendered template: each character outside [A-Za-z0-9 ._()-] becomes _,
 * no leading dots, at most 120 characters, and the format's extension. Never a path.
 */
export function safeFilename(name: string, fallback: string, ext: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ._()-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s_-]+|[.\s_]+$/g, '')
    .slice(0, 120)
    .trim();
  const stem = cleaned || fallback;
  return stem.toLowerCase().endsWith(`.${ext}`) ? stem : `${stem}.${ext}`;
}
