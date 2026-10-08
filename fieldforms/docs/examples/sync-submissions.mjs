#!/usr/bin/env node
/**
 * Pulls FieldForms submissions into a folder of JSON files, for on-premises systems: it only
 * makes outbound HTTPS calls, so no inbound firewall rule is needed. Run it from cron (or with
 * --watch) and point the other system at the folder.
 *
 *   FIELDFORMS_URL=https://forms.example.com FIELDFORMS_API_KEY=ff_xxxxxxxx_… \
 *     node sync-submissions.mjs ./submissions [--form <formId>] [--watch <seconds>]
 *
 * Needs Node 18 or later and a key with the submissions:read scope. Each submission is written
 * once as <out>/<id>.json (the fieldforms.submission/1 schema); the position is kept in
 * <out>/.cursor, so a run carries on where the last one stopped. Files are written before the
 * cursor moves, so an interrupted run repeats at most one page and never skips one.
 */
/* global process, console, setTimeout, URL, fetch, AbortSignal -- Node 18+ */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const formId = flag('--form');
const watch = Number(flag('--watch') ?? 0);
const outDir = args[0];
const baseUrl = (process.env.FIELDFORMS_URL ?? '').replace(/\/+$/, '');
const apiKey = process.env.FIELDFORMS_API_KEY ?? '';
if (!outDir || !baseUrl || !apiKey) {
  console.error('Usage: FIELDFORMS_URL=… FIELDFORMS_API_KEY=… node sync-submissions.mjs <dir>');
  process.exit(2);
}

const cursorFile = join(outDir, '.cursor');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes through a temporary file, so a reader never sees half a file. */
async function writeAtomic(path, text) {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

async function readCursor() {
  try {
    return (await readFile(cursorFile, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function getPage(cursor) {
  const url = new URL(`${baseUrl}/api/v1/submissions`);
  url.searchParams.set('limit', '500');
  if (formId) url.searchParams.set('formId', formId);
  if (cursor) url.searchParams.set('cursor', cursor);
  for (;;) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 429) {
      // Over the key's rate limit: wait as long as the server asks.
      await sleep(Math.max(1, Number(res.headers.get('retry-after')) || 30) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`FieldForms answered ${res.status}: ${body.error ?? res.statusText}`);
    }
    return res.json();
  }
}

/** Fetches every page available now; returns how many submissions were written. */
async function syncOnce() {
  let cursor = await readCursor();
  let written = 0;
  for (;;) {
    const page = await getPage(cursor);
    for (const doc of page.data) {
      await writeAtomic(join(outDir, `${doc.submission.id}.json`), JSON.stringify(doc, null, 2));
      written++;
    }
    if (page.resume && page.resume !== cursor) await writeAtomic(cursorFile, page.resume);
    cursor = page.resume;
    if (!page.next) return written;
  }
}

await mkdir(outDir, { recursive: true });
do {
  const n = await syncOnce();
  console.log(`${new Date().toISOString()} wrote ${n} submission(s)`);
  if (watch > 0) await sleep(watch * 1000);
} while (watch > 0);
