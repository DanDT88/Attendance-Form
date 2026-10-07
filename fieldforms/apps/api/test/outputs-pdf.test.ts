import { INCLUDE_ALL, type Answers, type FormDefinition } from '@fieldforms/shared';
import { describe, expect, it, vi } from 'vitest';
import { CSP, sanitizeTemplateHtml } from '../src/outputs/html-layout.js';
import { pdfHtml, pdfRenderer } from '../src/outputs/renderers/pdf.js';
import {
  EMBED_MAX_IMAGES,
  EMBED_MAX_SIDE,
  RenderError,
  type TemplateRef,
} from '../src/outputs/types.js';
import {
  ANSWERS,
  DEF,
  fakeMedia,
  fakePdf,
  META,
  model,
  S1,
  renderContext,
  srcValues,
} from './outputs-fixtures.js';

// The Word renderer is built separately; here only the hand-over to LibreOffice is tested.
vi.mock('../src/outputs/renderers/docx.js', () => ({
  docxRenderer: {
    format: 'docx',
    render: vi.fn(async (_m: unknown, _t: unknown, stem: string) => [
      {
        filename: `${stem}.docx`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: Buffer.from('PK fake docx'),
      },
    ]),
  },
}));

const html = (content: string): TemplateRef => ({
  templateId: 't1',
  versionId: 'tv1',
  version: 1,
  kind: 'html',
  content,
});

/** The <head> must open with our CSP, before anything a browser could act on. */
function expectOwnHead(doc: string) {
  expect(doc.startsWith('<!doctype html>\n<html lang="en">\n<head>\n')).toBe(true);
  const head = doc.slice(doc.indexOf('<head>') + 6, doc.indexOf('</head>')).trim();
  expect(head.startsWith(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)).toBe(
    true,
  );
  expect(CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
}

describe('PDF: the built-in layout', () => {
  it('has our CSP first and escapes every answer', async () => {
    const doc = await pdfHtml(model(), null, renderContext());
    expectOwnHead(doc);
    // The hostile answer is shown as text, never as markup.
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/<img src=http/i);
    expect(doc).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=http://169.254.169.254',
    );
    expect(doc).toContain('Mop &amp; &quot;bucket&quot;');
    expect(doc.match(/<meta http-equiv=/g)).toHaveLength(1);
  });

  it('shows the header, facts, answers, a table per group, photos, signatures and footer', async () => {
    const media = fakeMedia();
    const doc = await pdfHtml(model(), null, renderContext(media));
    expect(doc).toContain('<header class="bar">');
    expect(doc).toContain('background: #1B365D; color: #ffffff');
    expect(doc).toContain('<h1>Site inspection</h1>');
    expect(doc).toContain('<div class="brand">Delta Facilities</div>');
    for (const fact of [
      'Sandton City',
      'Delta Facilities',
      'Gauteng',
      'abcdef12',
      '2026-10-06 17:30 SAST',
      '2026-10-07 10:00 SAST',
      'Thandi Mokoena',
      'Monthly check',
      'Site inspection, version 2',
    ])
      expect(doc).toContain(`<td>${fact}</td>`);
    expect(doc).toContain('<tr><th>Area</th><td>Kitchen</td></tr>');
    expect(doc).toContain('<tr><th>Checks</th><td>Floors, Bins</td></tr>');
    expect(doc).toContain('<tr><th>Fault photo</th><td>2 photos</td></tr>');
    expect(doc).toContain('<h2>Items</h2>');
    expect(doc).toContain('<tr><th class="n">#</th><th>Item</th><th>Count</th></tr>');
    expect(doc).toContain('<tr><td class="n">1</td><td>Bleach</td><td>2</td></tr>');
    expect(doc).toContain('<figcaption>Fault photo (1 of 2)</figcaption>');
    expect(doc).toContain('<figcaption>Items 1: Item photo</figcaption>');
    expect(doc).toContain('<h2>Signatures</h2>');
    expect(doc).toContain('<figcaption>Signature</figcaption>');
    expect(doc).toContain('Delta Facilities (Pty) Ltd');
    expect(doc).not.toContain('Read me'); // notes are not answers
    expect(doc).not.toContain('undefined');
    // Photos at the embedding size, the logo once.
    expect(media.calls.filter((c) => c.op === 'load').map((c) => c.maxSide)).toEqual([
      EMBED_MAX_SIDE,
      EMBED_MAX_SIDE,
      EMBED_MAX_SIDE,
      EMBED_MAX_SIDE,
    ]);
    expect(media.calls.filter((c) => c.op === 'logo')).toHaveLength(1);
  });

  it('embeds only data: images', async () => {
    const doc = await pdfHtml(model(), null, renderContext());
    const srcs = srcValues(doc);
    expect(srcs.length).toBe(5); // logo, three photos, one signature
    for (const s of srcs) expect(s).toMatch(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/);
  });

  it('caps the embedded images, keeping signatures, and says how many photos are left out', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      blobId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    const def: FormDefinition = {
      ...DEF,
      fields: DEF.fields.map((f) => (f.id === 'fault' ? { ...f, maxCount: 100 } : f)),
    };
    const media = fakeMedia();
    const doc = await pdfHtml(
      model(INCLUDE_ALL, { def, answers: { ...ANSWERS, fault: many } as unknown as Answers }),
      null,
      renderContext(media),
    );
    const loads = media.calls.filter((c) => c.op === 'load');
    expect(loads).toHaveLength(EMBED_MAX_IMAGES);
    expect(loads[0]!.id).toBe(S1);
    // 71 photos (70 + one in a group) and a signature: 59 photos fit beside the signature.
    expect(doc).toContain('… 12 more photos not shown');
    expect(srcValues(doc)).toHaveLength(EMBED_MAX_IMAGES + 1);
  });

  it('shows a missing photo as unavailable and marks samples', async () => {
    const doc = await pdfHtml(
      model(INCLUDE_ALL, {
        meta: { ...META, submission: { ...META.submission, sample: true } },
      }),
      null,
      renderContext(fakeMedia({ missing: ['11111111-1111-4111-8111-111111111111'] })),
    );
    expect(doc).toContain('<div class="missing">Photo not available</div>');
    expect(doc).toContain('Sample document: generated test data');
  });

  it('leaves out what the destination does not include', async () => {
    const doc = await pdfHtml(
      model({
        fields: ['area'],
        photos: 'none',
        signatures: false,
        location: 'none',
        submitter: false,
      }),
      null,
      renderContext(),
    );
    expect(doc).not.toContain('Leaking tap');
    expect(doc).not.toContain('Thandi');
    expect(doc).not.toContain('<h2>Photos</h2>');
    expect(doc).not.toContain('<h2>Signatures</h2>');
    expect(doc).not.toContain('-26.1');
    expect(srcValues(doc)).toHaveLength(1); // the logo
  });

  it('never puts an unsafe brand colour into the CSS', async () => {
    const doc = await pdfHtml(
      model(INCLUDE_ALL, {
        meta: {
          ...META,
          branding: { ...META.branding, colour: 'red;}</style><script>x()</script>' },
        },
      }),
      null,
      renderContext(),
    );
    expect(doc).not.toMatch(/<script/i);
    expect(doc).toContain('background: #1B365D');
  });

  it('renders through the PDF converter as <stem>.pdf', async () => {
    const pdf = fakePdf();
    const files = await pdfRenderer.render(
      model(),
      null,
      'Report - abcdef12',
      renderContext(fakeMedia(), pdf),
    );
    expect(files).toEqual([
      {
        filename: 'Report - abcdef12.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.7 fake'),
      },
    ]);
    expect(pdf.calls).toHaveLength(1);
    expect(pdf.calls[0]!.kind).toBe('html');
  });
});

describe('PDF: an HTML template', () => {
  it('cannot add a refresh, a base URL or a script, and stays inside our document', async () => {
    const template = html(`<html><head>
<meta http-equiv="refresh" content="0;url=http://169.254.169.254/latest/meta-data">
<META HTTP-EQUIV="Content-Security-Policy" content="default-src *">
<meta content="a>b" http-equiv="refresh">
<meta/http-equiv="refresh" content="0;url=http://10.0.0.1">
<base href="http://169.254.169.254/">
<link rel="stylesheet" href="http://169.254.169.254/x.css">
<script>alert(1)</script><SCRIPT src="http://x/y.js"></SCRIPT>
<scr<script>x</script>ipt>alert(2)</script>
<iframe src="http://169.254.169.254/"></iframe>
</head><body><h1>{{ _form }}</h1><p>{{ area }}</p>
<meta http-equiv="refresh" content="0;url=http://unterminated"`);
    const doc = await pdfHtml(model(), template, renderContext());
    expectOwnHead(doc);
    expect(doc.match(/<meta\b/gi)).toHaveLength(2); // ours: CSP and charset
    expect(doc.match(/http-equiv=/gi)).toHaveLength(1);
    expect(doc).not.toMatch(/<base\b/i);
    expect(doc).not.toMatch(/<script\b/i);
    expect(doc).not.toMatch(/<link\b/i);
    expect(doc).not.toMatch(/<iframe\b/i);
    expect(doc).not.toContain('url=http://169.254.169.254');
    expect(doc).toContain('<h1>Site inspection</h1><p>Kitchen</p>');
    // The template is in the body, after our head.
    expect(doc.indexOf('<h1>Site inspection</h1>')).toBeGreaterThan(doc.indexOf('<body>'));
  });

  it('escapes answers, and | raw cannot unescape them', async () => {
    const doc = await pdfHtml(
      model(),
      html(
        '<div>{{ notes | raw }}</div><div>{{ notes }}</div><ul>{% for r in items %}<li>{{ r.item | raw }}</li>{% endfor %}</ul>',
      ),
      renderContext(),
    );
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/<img src=http/i);
    expect(doc.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)).toHaveLength(2);
    expect(doc).toContain('<li>Mop &amp; &quot;bucket&quot;</li>');
  });

  it('gets photos and the logo as data: URIs', async () => {
    const doc = await pdfHtml(
      model(),
      html(
        '<img src="{{ _images["fault-1"] }}"><img src="{{ _images["items-1-pic-1"] }}"><img src="{{ _branding.logo }}"><img src="{{ _images.sig }}">{{ _images["nope"] }}',
      ),
      renderContext(),
    );
    const srcs = srcValues(doc);
    expect(srcs).toHaveLength(4);
    for (const s of srcs) expect(s).toMatch(/^data:image\/(jpeg|png);base64,/);
  });

  it('reports a template that cannot render as a RenderError', async () => {
    await expect(pdfHtml(model(), html('{% for x in %}'), renderContext())).rejects.toBeInstanceOf(
      RenderError,
    );
  });

  it('strips blocked tags however they are written', () => {
    expect(sanitizeTemplateHtml('<p>a</p><BASE HREF=x><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(sanitizeTemplateHtml('<p>a</p></Script ><p>b</p>')).toBe('<p>a</p><p>b</p>');
    // A tag joined together by a removal is left as text.
    expect(sanitizeTemplateHtml('<me<meta>ta http-equiv=refresh content=0>x')).toBe(
      '&lt;meta http-equiv=refresh content=0>x',
    );
    expect(sanitizeTemplateHtml('<scr<script>x</script>ipt>alert(2)</script>')).toBe('alert(2)');
    expect(sanitizeTemplateHtml('<me</meta>ta>')).toBe('&lt;meta>');
    // Left open at the end, our own closing tags would complete it, so the rest goes.
    expect(sanitizeTemplateHtml('x<script src=y>')).toBe('x');
    expect(sanitizeTemplateHtml('x<meta http-equiv="refresh" content="0;url=y"')).toBe('x');
    expect(sanitizeTemplateHtml('x<meta http-equiv="refresh" content="0;url=y')).toBe('x');
    expect(sanitizeTemplateHtml("x<base href='http://y")).toBe('x');
    expect(sanitizeTemplateHtml('<basefont><metadata><p title="<meta>">ok</p>')).toBe(
      '<basefont><metadata><p title="">ok</p>',
    );
  });

  it('takes linear time on output crafted to make it backtrack', () => {
    const n = 100_000;
    for (const input of [
      '<script '.repeat(n),
      '<meta "'.repeat(n),
      "<meta x='a".repeat(n),
      '</meta '.repeat(n),
      `${'<me'.repeat(n)}<meta>${'ta>'.repeat(n)}`,
      `<meta${' a="b"'.repeat(n)}`,
    ]) {
      const started = Date.now();
      const out = sanitizeTemplateHtml(input);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(out).not.toMatch(/<(script|meta)(?=[\s/>]|$)/i);
    }
  });
});

describe('PDF: a Word template', () => {
  it('makes the Word file and converts it with LibreOffice', async () => {
    const pdf = fakePdf();
    const files = await pdfRenderer.render(
      model(),
      { templateId: 't2', versionId: 'tv2', version: 3, kind: 'docx', content: Buffer.from('PK') },
      'Report',
      renderContext(fakeMedia(), pdf),
    );
    expect(files.map((f) => f.filename)).toEqual(['Report.pdf']);
    expect(files[0]!.data.toString()).toBe('%PDF-1.7 fake office');
    expect(pdf.calls).toEqual([
      { kind: 'office', input: Buffer.from('PK fake docx'), filename: 'Report.docx' },
    ]);
  });
});
