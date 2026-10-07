import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryError } from '../src/destinations/types.js';
import { gotenbergConverter } from '../src/outputs/gotenberg.js';

/** A stand-in Gotenberg that answers with whatever the test asks for and records requests. */
let server: Server;
let base: string;
let respond: { status: number; body: string; delayMs?: number } = { status: 200, body: '%PDF-1.7' };
const seen: { url: string; auth: string | undefined; body: string; type: string }[] = [];

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('latin1');
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seen.push({
      url: req.url ?? '',
      auth: req.headers.authorization,
      body: await bodyOf(req),
      type: req.headers['content-type'] ?? '',
    });
    const r = respond;
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    res.writeHead(r.status, { 'content-type': 'application/pdf' }).end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
});

const signal = () => new AbortController().signal;

async function failure(p: Promise<unknown>): Promise<DeliveryError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
}

describe('Gotenberg client', () => {
  it('posts index.html to Chromium with basic auth and returns the PDF', async () => {
    respond = { status: 200, body: '%PDF-1.7 from chromium' };
    seen.length = 0;
    const pdf = gotenbergConverter({ url: `${base}/`, username: 'ff', password: 's3cret-pass' });
    const out = await pdf.htmlToPdf('<!doctype html><p>Hello ✓</p>', signal());
    expect(out.toString()).toBe('%PDF-1.7 from chromium');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/forms/chromium/convert/html');
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from('ff:s3cret-pass').toString('base64')}`);
    expect(seen[0]!.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]!.body).toContain('filename="index.html"');
    expect(seen[0]!.body).toContain('name="printBackground"');
    expect(seen[0]!.body).toContain(Buffer.from('<p>Hello ✓</p>').toString('latin1'));
  });

  it('posts an office file to LibreOffice under a plain name', async () => {
    respond = { status: 200, body: '%PDF-1.7 from libreoffice' };
    seen.length = 0;
    const pdf = gotenbergConverter({ url: base });
    const out = await pdf.officeToPdf(
      Buffer.from('PK\u0003\u0004 docx'),
      'Ops/../evil name.DOCX',
      signal(),
    );
    expect(out.toString()).toBe('%PDF-1.7 from libreoffice');
    expect(seen[0]!.url).toBe('/forms/libreoffice/convert');
    expect(seen[0]!.auth).toBeUndefined();
    expect(seen[0]!.body).toContain('filename="document.docx"');
    expect(seen[0]!.body).not.toContain('evil');
  });

  it('fails permanently when it is not configured', async () => {
    const err = await failure(gotenbergConverter({ url: undefined }).htmlToPdf('<p>', signal()));
    expect(err).toMatchObject({
      message: 'PDF conversion is not configured',
      permanent: true,
      errorClass: 'settings',
    });
  });

  it('retries a 5xx, 429 or 408 and never keeps the body', async () => {
    for (const status of [500, 503, 429, 408]) {
      respond = { status, body: 'Traceback with document text and s3cret-pass' };
      const err = await failure(
        gotenbergConverter({ url: base, username: 'ff', password: 's3cret-pass' }).htmlToPdf(
          '<p>',
          signal(),
        ),
      );
      expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable', status });
      expect(err.message).toBe(`PDF conversion service returned HTTP ${status}`);
      expect(`${err.message} ${err.detail}`).not.toMatch(/Traceback|s3cret|document text/);
    }
  });

  it('treats a 4xx as a document that cannot be converted, and 401 as bad credentials', async () => {
    respond = { status: 400, body: 'bad html' };
    expect(
      await failure(
        gotenbergConverter({ url: base }).officeToPdf(Buffer.from('x'), 'a.docx', signal()),
      ),
    ).toMatchObject({ permanent: true, errorClass: 'template', status: 400 });
    respond = { status: 413, body: '' };
    expect(await failure(gotenbergConverter({ url: base }).htmlToPdf('x', signal()))).toMatchObject(
      {
        permanent: true,
        errorClass: 'too_large',
      },
    );
    respond = { status: 401, body: '' };
    const err = await failure(
      gotenbergConverter({ url: base, username: 'ff', password: 'wrong-password' }).htmlToPdf(
        'x',
        signal(),
      ),
    );
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings' });
    expect(`${err.message} ${err.detail}`).not.toContain('wrong-password');
  });

  it('retries when the service cannot be reached, with a safe detail', async () => {
    const closed = createServer();
    await new Promise<void>((ok) => closed.listen(0, '127.0.0.1', ok));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((ok) => closed.close(ok));
    const err = await failure(
      gotenbergConverter({ url: `http://ff:pw-in-url@127.0.0.1:${port}` }).htmlToPdf('x', signal()),
    );
    expect(err).toMatchObject({
      message: 'PDF conversion service could not be reached',
      permanent: false,
      errorClass: 'unreachable',
    });
    expect(err.detail).toBe('Gotenberg network error ECONNREFUSED');
  });

  it('moves credentials in the URL into basic auth', async () => {
    respond = { status: 200, body: '%PDF' };
    seen.length = 0;
    const url = base.replace('http://', 'http://ff:p%40ss@');
    await gotenbergConverter({ url }).htmlToPdf('x', signal());
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from('ff:p@ss').toString('base64')}`);
  });

  it("stops at the caller's deadline", async () => {
    respond = { status: 200, body: '%PDF', delayMs: 2_000 };
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const started = Date.now();
    const err = await failure(gotenbergConverter({ url: base }).htmlToPdf('x', ctl.signal));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(err).toMatchObject({ permanent: false, errorClass: 'unreachable' });
    expect(err.detail).toBe('Gotenberg request stopped at the attempt deadline');
  });
});
