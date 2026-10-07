import type { DestinationSettings } from '@fieldforms/shared';
import {
  DeliveryError,
  type AdapterEnv,
  type CheckResult,
  type DeliveryContext,
  type DestinationAdapter,
  type OpenConnection,
} from '../types.js';
import { googleApi, SHEETS_SCOPE, type GoogleConfig } from '../vendors/google-auth.js';
import { requireConnection, vendorRequest, type VendorApi } from '../vendors/http.js';

/**
 * Google Sheets: appends one row per submission (or per row of a repeat group) to a sheet.
 *
 * Values are written USER_ENTERED, so dates and numbers are typed as they would be by hand,
 * and text that a sheet would read as a formula (starting with = + - @, a tab or a line break)
 * gets a leading apostrophe, which makes it plain text. The header row is written (RAW) when
 * row 1 is empty; a different header row is left alone and reported.
 *
 * Delivery is at least once: Sheets has no idempotency key, so a retry after a lost reply can
 * append the same rows twice. Map `_id` to a column to spot (and remove) such duplicates.
 */

type Settings = DestinationSettings<'google_sheets'>;

/** A cell holds at most 50,000 characters. */
const CELL_MAX = 50_000;

export type Cell = string | number | boolean;

/** Text that a sheet would read as a formula, and a leading apostrophe (which a sheet hides). */
const FORMULA_START = /^[=+\-@\t\r\n']/;
/** A plain negative number cannot run as a formula; keep it typed. */
const NEGATIVE_NUMBER = /^-\d+(\.\d+)?$/;

function text(s: string): string {
  const t = s.length > CELL_MAX - 1 ? s.slice(0, CELL_MAX - 1) : s;
  return FORMULA_START.test(t) && !NEGATIVE_NUMBER.test(t) ? `'${t}` : t;
}

/** A mapped value as a cell: numbers and booleans as they are, lists joined, text escaped. */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return text(v);
  if (Array.isArray(v))
    return text(
      v
        .map((x) => (x === null || x === undefined ? '' : typeof x === 'object' ? '' : String(x)))
        .join(', '),
    );
  return '';
}

/** A1 notation for a sheet: always quoted, quotes doubled. */
export const sheetRange = (sheet: string, cells: string) =>
  `'${sheet.replace(/'/g, "''")}'!${cells}`;

/** The rows to append: one per submission, or one per row of the `rowsFrom` group. */
export function buildRows(ctx: DeliveryContext, settings: Settings): Cell[][] {
  const row = (at?: { group: string; index: number }) =>
    settings.columns.map((c) => toCell(ctx.value(c.source, at)));
  if (!settings.rowsFrom) return [row()];
  const group = ctx.model.fields.find((f) => f.id === settings.rowsFrom);
  const count = group?.rows?.length ?? 0;
  return Array.from({ length: count }, (_, index) => row({ group: settings.rowsFrom!, index }));
}

const mapSheetsError: VendorApi['mapError'] = (info, detail) => {
  // A sheet name that does not exist makes the range unparseable.
  if (info.status === 400 && /unable to parse range/i.test(info.message))
    return new DeliveryError('The sheet was not found in the spreadsheet', {
      permanent: true,
      errorClass: 'not_found',
      detail,
      status: info.status,
    });
  if (info.status === 403 && !/rate/i.test(info.reason ?? ''))
    return new DeliveryError('The spreadsheet is not shared with the service account', {
      permanent: true,
      errorClass: 'credentials',
      detail,
      status: info.status,
    });
  return undefined;
};

const sheetsApi = (conn: OpenConnection<GoogleConfig> | null, env: AdapterEnv) =>
  googleApi('Google Sheets', requireConnection(conn, 'Google'), SHEETS_SCOPE, env, mapSheetsError);

const NOT_FOUND = 'The spreadsheet was not found, or it is not shared with the service account';

const valuesUrl = (env: AdapterEnv, settings: Settings, range: string) =>
  `${env.endpoints.googleSheets}/spreadsheets/${encodeURIComponent(settings.spreadsheetId)}/values/${encodeURIComponent(range)}`;

/** Row 1 of the sheet, as displayed ([] when empty). */
async function headerRow(api: VendorApi, settings: Settings): Promise<string[]> {
  const reply = await vendorRequest(
    api,
    valuesUrl(api.env, settings, sheetRange(settings.sheetName, '1:1')),
    { query: { majorDimension: 'ROWS' }, notFound: NOT_FOUND },
  );
  const values = reply.json<{ values?: unknown }>().values;
  const first = Array.isArray(values) && Array.isArray(values[0]) ? (values[0] as unknown[]) : [];
  const out = first.map((v) => (v === null || v === undefined ? '' : String(v)));
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

/** The 1-based columns where the sheet's header differs from the destination's headers. */
export function headerMismatches(existing: string[], wanted: string[]): number[] {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < Math.max(existing.length, wanted.length); i++)
    if (norm(existing[i]) !== norm(wanted[i])) out.push(i + 1);
  return out;
}

const mismatchWarning = (cols: number[]) =>
  `The sheet's header row does not match the destination's columns (column ${cols.slice(0, 10).join(', ')})`;

export const googleSheetsAdapter: DestinationAdapter<Settings, GoogleConfig> = {
  kind: 'google_sheets',

  async deliver(ctx, settings, conn, env) {
    const target = { spreadsheetId: settings.spreadsheetId, sheet: settings.sheetName };
    // Work the rows out first, so a test send still checks the mappings.
    const rows = buildRows(ctx, settings);
    if (ctx.test && !settings.testWrites)
      return {
        outcome: 'skipped',
        detail: 'Test rows are switched off',
        target,
        evidence: { rows: rows.length },
      };
    if (!rows.length)
      return {
        outcome: 'skipped',
        detail: 'The repeat group has no rows',
        target,
        evidence: { rows: 0 },
      };

    const api = await sheetsApi(conn, env);
    const headers = settings.columns.map((c) => c.header);
    const existing = await headerRow(api, settings);
    let headerWritten = false;
    let warning: string | undefined;
    if (!existing.length) {
      // PUT to A1 (not an append), so two deliveries racing on an empty sheet write it once.
      const range = sheetRange(settings.sheetName, 'A1');
      await vendorRequest(api, valuesUrl(env, settings, range), {
        method: 'PUT',
        query: { valueInputOption: 'RAW' },
        json: { range, majorDimension: 'ROWS', values: [headers] },
        notFound: NOT_FOUND,
      });
      headerWritten = true;
    } else {
      const cols = headerMismatches(existing, headers);
      if (cols.length) warning = mismatchWarning(cols);
    }

    const range = sheetRange(settings.sheetName, 'A1');
    const reply = await vendorRequest(api, `${valuesUrl(env, settings, range)}:append`, {
      method: 'POST',
      query: {
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        includeValuesInResponse: false,
      },
      json: { range, majorDimension: 'ROWS', values: rows },
      notFound: NOT_FOUND,
    });
    const updates = reply.json<{ updates?: { updatedRange?: unknown; updatedRows?: unknown } }>()
      .updates;
    const updatedRange =
      typeof updates?.updatedRange === 'string' ? updates.updatedRange.slice(0, 200) : undefined;
    return {
      outcome: 'delivered',
      target: { ...target, ...(updatedRange ? { range: updatedRange } : {}) },
      evidence: {
        rows: typeof updates?.updatedRows === 'number' ? updates.updatedRows : rows.length,
        ...(updatedRange ? { updatedRange } : {}),
        headerWritten,
        ...(warning ? { warning } : {}),
      },
    };
  },

  async check(settings, conn, env): Promise<CheckResult> {
    const api = await sheetsApi(conn, env);
    const meta = await vendorRequest(
      api,
      `${env.endpoints.googleSheets}/spreadsheets/${encodeURIComponent(settings.spreadsheetId)}`,
      { query: { fields: 'properties.title,sheets.properties.title' }, notFound: NOT_FOUND },
    );
    const j = meta.json<{
      properties?: { title?: string };
      sheets?: { properties?: { title?: string } }[];
    }>();
    const title = j.properties?.title ?? settings.spreadsheetId;
    const names = (j.sheets ?? []).map((s) => s.properties?.title).filter(Boolean);
    if (!names.includes(settings.sheetName))
      return {
        ok: false,
        summary: `There is no sheet named '${settings.sheetName}' in '${title}'`,
        facts: { spreadsheet: title },
      };
    const existing = await headerRow(api, settings);
    const warnings: string[] = [];
    if (!existing.length)
      warnings.push('Row 1 is empty: the header row is written with the first delivery');
    else {
      const cols = headerMismatches(
        existing,
        settings.columns.map((c) => c.header),
      );
      if (cols.length) warnings.push(mismatchWarning(cols));
    }
    return {
      ok: true,
      summary: `Sheet '${settings.sheetName}' in '${title}'`,
      facts: { spreadsheet: title, sheet: settings.sheetName },
      warnings,
    };
  },
};
