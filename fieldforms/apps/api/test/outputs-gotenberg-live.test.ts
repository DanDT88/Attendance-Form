import { Document, Packer, Paragraph, TextRun } from 'docx';
import { describe, expect, it } from 'vitest';
import { DeliveryError } from '../src/destinations/types.js';
import { gotenbergConverter } from '../src/outputs/gotenberg.js';
import { pdfHtml, pdfRenderer } from '../src/outputs/renderers/pdf.js';
import { fakeMedia, model, renderContext } from './outputs-fixtures.js';

/*
 * Against a real Gotenberg, started as the deployment runs it (basic auth, JavaScript off, no
 * private or public addresses for Chromium). Skipped unless GOTENBERG_TEST_URL is set, e.g.
 *
 *   docker run -d --name ff-documents-gotenberg -p 127.0.0.1::3000 \
 *     -e GOTENBERG_API_BASIC_AUTH_USERNAME=ff -e GOTENBERG_API_BASIC_AUTH_PASSWORD=pw \
 *     gotenberg/gotenberg:8 gotenberg --api-enable-basic-auth --chromium-disable-javascript=true \
 *     --chromium-deny-private-ips=true --chromium-deny-public-ips=true
 *   GOTENBERG_TEST_URL=http://127.0.0.1:<port> GOTENBERG_TEST_USERNAME=ff GOTENBERG_TEST_PASSWORD=pw
 */
const url = process.env.GOTENBERG_TEST_URL;
const auth = {
  username: process.env.GOTENBERG_TEST_USERNAME,
  password: process.env.GOTENBERG_TEST_PASSWORD,
};

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

describe.skipIf(!url)('Gotenberg (live)', () => {
  const pdf = gotenbergConverter({ url, ...auth });
  const signal = () => AbortSignal.timeout(90_000);

  it('turns the built-in layout into a PDF', async () => {
    const html = await pdfHtml(model(), null, renderContext());
    const out = await pdf.htmlToPdf(html, signal());
    expect(isPdf(out)).toBe(true);
    expect(out.length).toBeGreaterThan(5_000);
  }, 120_000);

  it('renders through the PDF renderer, a hostile template included', async () => {
    const ctx = renderContext(fakeMedia(), pdf);
    const [file] = await pdfRenderer.render(
      model(),
      {
        templateId: 't',
        versionId: 'v',
        version: 1,
        kind: 'html',
        content:
          '<meta http-equiv="refresh" content="0;url=http://169.254.169.254/"><base href="http://169.254.169.254/"><img src="http://169.254.169.254/x.png"><h1>{{ _form }}</h1><p>{{ notes }}</p>',
      },
      'Live',
      ctx,
    );
    expect(file!.filename).toBe('Live.pdf');
    expect(isPdf(file!.data)).toBe(true);
  }, 120_000);

  it('turns a Word file into a PDF with LibreOffice', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun({ text: 'Site inspection', bold: true })] }),
            new Paragraph({ children: [new TextRun('Area: Kitchen')] }),
          ],
        },
      ],
    });
    const word = Buffer.from(await Packer.toBuffer(doc));
    const out = await pdf.officeToPdf(word, 'Inspection.docx', signal());
    expect(isPdf(out)).toBe(true);
  }, 120_000);

  it('refuses wrong credentials permanently', async () => {
    const bad = gotenbergConverter({ url, username: 'ff', password: 'not-the-password' });
    const err = await bad.htmlToPdf('<p>x</p>', signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err).toMatchObject({ permanent: true, errorClass: 'settings', status: 401 });
  }, 120_000);
});
