import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docxRenderer } from '../src/outputs/renderers/docx.js';
import {
  EMBED_MAX_IMAGES,
  EMBED_MAX_SIDE,
  RenderError,
  type TemplateRef,
} from '../src/outputs/types.js';
import {
  ANSWERS,
  assertBalanced,
  context,
  fakeMedia,
  model,
  patchZip,
  relationships,
  text,
  unzip,
  visibleText,
  wordTemplate,
} from './outputs-docx-fixtures.js';

const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const tpl = (content: Buffer, version = 2): TemplateRef => ({
  templateId: 't1',
  versionId: 'tv1',
  version,
  kind: 'docx',
  content,
});

async function render(blocks: Parameters<typeof wordTemplate>[0], opts = {}, m = model()) {
  const { media, calls } = fakeMedia();
  const content = await wordTemplate(blocks, opts);
  const [file] = await docxRenderer.render(m, tpl(content), 'Out', context(media));
  const files = unzip(file!.data);
  const doc = text(files, 'word/document.xml');
  return { file: file!, files, doc, shown: visibleText(doc), calls };
}

/** Pictures in a part, each with the media file it points to. */
function pictures(files: Record<string, Uint8Array>, part: string) {
  const xml = text(files, part);
  const relsPath = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const rels = relationships(files[relsPath] ? text(files, relsPath) : '');
  return [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)].map((m) => {
    const rId = /r:embed="([^"]+)"/.exec(m[0])![1]!;
    const rel = rels.get(rId);
    const cx = Number(/<wp:extent cx="(\d+)"/.exec(m[0])![1]);
    return { rId, rel, cx, media: rel ? files[`word/${rel.target}`] : undefined };
  });
}

describe('built-in Word layout', () => {
  it('has the facts, every answer, a table per repeat group, photos and signatures', async () => {
    const { media, calls } = fakeMedia();
    const files = await docxRenderer.render(
      model(),
      null,
      'Site inspection - abcdef12',
      context(media),
    );
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file!.filename).toBe('Site inspection - abcdef12.docx');
    expect(file!.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const zip = unzip(file!.data);
    const doc = text(zip, 'word/document.xml');
    assertBalanced(doc);
    const shown = visibleText(doc);
    for (const s of [
      'Site inspection',
      'Sandton Office',
      'Delta Facilities',
      'Thandi Nkosi',
      'abcdef12',
      'Area inspected',
      'Kitchen & pantry',
      'Inspection date',
      '2026-10-07',
      'Floors, Bins',
      '72.5',
      'Line one\nLine two <b>&</b>',
      '=HYPERLINK("http://evil.example","x")',
      'Consumables',
      'Soap',
      'Paper',
      'Item photo',
      'Photos',
      'fault-1',
      'items-1-photo-1',
    ]) {
      expect(shown).toContain(s);
    }
    expect(shown).not.toMatch(/undefined|null|\[object/);
    // Notes are instructions, not answers.
    expect(shown).not.toContain('Not printed');
    // Branding: the colour fills the title bar, the footer carries the company's text.
    expect(doc).toContain('w:fill="0B6E4F"');
    const footer = Object.keys(zip).find((n) => /^word\/footer\d*\.xml$/.test(n))!;
    expect(visibleText(text(zip, footer))).toContain('Delta Facilities (Pty) Ltd');
    expect(text(zip, footer)).toMatch(/PAGE/);

    // 3 photos and 3 signatures loaded at the embedding size, plus the logo.
    const media_ = Object.keys(zip).filter((n) => /^word\/media\/.+/.test(n));
    expect(media_).toHaveLength(7);
    expect(calls.filter((c) => c.kind === 'load')).toHaveLength(6);
    expect(calls.filter((c) => c.kind === 'load').every((c) => c.maxSide === EMBED_MAX_SIDE)).toBe(
      true,
    );
    expect(calls.filter((c) => c.kind === 'logo')).toEqual([
      { kind: 'logo', id: 'logo-blob', maxSide: 600 },
    ]);
    expect(calls.some((c) => c.kind === 'original')).toBe(false);
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(7);
  });

  it('embeds at most EMBED_MAX_IMAGES pictures and says so', async () => {
    const many = Array.from({ length: EMBED_MAX_IMAGES + 5 }, (_, i) => ({
      blobId: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`,
    }));
    const { media, calls } = fakeMedia();
    const [file] = await docxRenderer.render(
      model({ ...ANSWERS, fault: many }),
      null,
      'Many',
      context(media),
    );
    const zip = unzip(file!.data);
    expect(calls.filter((c) => c.kind === 'load')).toHaveLength(EMBED_MAX_IMAGES);
    // 60 pictures and the logo.
    expect(Object.keys(zip).filter((n) => /^word\/media\/.+/.test(n))).toHaveLength(
      EMBED_MAX_IMAGES + 1,
    );
    const shown = visibleText(text(zip, 'word/document.xml'));
    // Signatures come first: the 3 signatures and 57 of the 66 photos fit, 9 are left out.
    expect(shown).toMatch(/9 more pictures are not shown: a document holds at most 60/);
  });

  it('copes with missing files, no logo, a sample and characters XML cannot hold', async () => {
    const { media } = fakeMedia({ missing: ['00000000-0000-4000-8000-000000000001'] });
    const m = model({ ...ANSWERS, notes: 'bell\u0007 and \u0000nul' }, undefined, {
      logoBlobId: null,
      name: '',
      colour: 'not a colour',
      footer: '',
    });
    m.submission.sample = true;
    const [file] = await docxRenderer.render(m, null, 'X', context(media));
    const zip = unzip(file!.data);
    const doc = text(zip, 'word/document.xml');
    assertBalanced(doc);
    expect(doc.includes('\u0000') || doc.includes('\u0007')).toBe(false);
    const shown = visibleText(doc);
    expect(shown).toContain('bell and nul');
    expect(shown).toContain('fault-1: the photo file is missing');
    expect(shown).toContain('SAMPLE');
    expect(doc).toContain('w:fill="1F4E79"');
  });
});

describe('Word templates', () => {
  it('fills names, loops over groups, and shows or hides sections', async () => {
    const { shown, doc } = await render([
      'Area: {{area}} at {{ _site }} on {{inspected_on}}',
      '{{#items}}',
      'Row {{item}} x {{qty}} for {{_site}}',
      '{{/items}}',
      [
        ['Item', 'Qty'],
        ['{{#items}}{{item}}', '{{qty}}{{/items}}'],
      ],
      '{{^blank_note}}No notes given{{/blank_note}}',
      '{{#blank_note}}HIDDEN{{/blank_note}}',
      '{{#notes}}Notes: {{notes}}{{/notes}}',
      'Blank:[{{blank_note}}][{{not_a_field}}][{{fault_missing.x}}]',
      'Count: {{items.length}} Brand: {{_branding.name}}',
      '{{#_fields}}{{label}}={{text}};{{/_fields}}',
    ]);
    assertBalanced(doc);
    expect(shown).toContain('Area: Kitchen & pantry at Sandton Office on 2026-10-07');
    expect(shown).toContain('Row Soap x 3 for Sandton Office');
    expect(shown).toContain('Row Paper x 10 for Sandton Office');
    expect(shown).toMatch(/Soap\n3\n[\s\S]*Paper\n10/);
    expect(shown).toContain('No notes given');
    expect(shown).not.toContain('HIDDEN');
    // Multi-line answers become line breaks; markup in answers stays text.
    expect(doc).toMatch(/Line one<\/w:t><\/w:r>(<w:r>)?<w:br\/>/);
    expect(doc).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(shown).toContain('Blank:[][][]');
    expect(shown).toContain('Count: 2 Brand: Delta Facilities');
    expect(shown).toContain('Area inspected=Kitchen & pantry;');
    expect(shown).not.toMatch(/undefined|null|\[object/);
  });

  it('resolves only own properties of the data: prototype names print nothing', async () => {
    const { shown, calls } = await render([
      'P:[{{constructor}}][{{__proto__}}][{{toString}}][{{hasOwnProperty}}]',
      'Q:[{{items.constructor}}][{{_branding.constructor.name}}][{{area.length}}][{{prototype}}]',
      '{{#constructor}}LEAK{{/constructor}}{{#__proto__}}LEAK{{/__proto__}}',
      '{{#items}}R:[{{constructor}}][{{__proto__}}]{{/items}}',
    ]);
    expect(shown).toContain('P:[][][][]');
    expect(shown).toContain('Q:[][][][]');
    expect(shown).not.toContain('LEAK');
    expect(shown).toContain('R:[][]R:[][]');
    expect(shown).not.toMatch(/function|Object|native code/);
    expect(calls).toHaveLength(0);
  });

  it('escapes answers, so an answer cannot add Word markup', async () => {
    const evil = '</w:t></w:r><w:r><w:t>INJECTED';
    const { doc, shown } = await render(
      ['Notes: {{notes}}'],
      {},
      model({ ...ANSWERS, notes: evil }),
    );
    assertBalanced(doc);
    expect(shown).toContain(`Notes: ${evil}`);
    expect(doc).not.toContain('<w:t>INJECTED');
  });

  it('refuses raw-XML tags, calculations and filters', async () => {
    const content = async (p: string) => wordTemplate(['Before', p, 'After']);
    for (const [para, message] of [
      ['{{@raw}}', /raw XML tags are not allowed/],
      ['Text {{@raw}} more', /raw XML tags are not allowed/],
      ['{{a + b}}', /names only/],
      ['{{ area | upper }}', /names only/],
      ['{{area.toUpperCase()}}', /names only/],
      ['{{ #items }}x{{ /items }}', /remove the spaces/],
      ['{{%../../etc/passwd}}', /picture tag takes/],
      ['{{%https://example.com/x.png}}', /picture tag takes/],
      ['{{#items}}never closed', /unclosed/i],
    ] as const) {
      const { media } = fakeMedia();
      const err = await docxRenderer
        .render(model(), tpl(await content(para)), 'X', context(media))
        .catch((e: unknown) => e);
      expect(err, para).toBeInstanceOf(RenderError);
      expect((err as Error).message, para).toMatch(message);
      expect((err as Error).message).toMatch(/^Word template version 2: /);
    }
  });

  it('refuses templates that link outside themselves', async () => {
    const base = await wordTemplate(['Hello {{area}}']);
    const linkedImage = patchZip(base, {
      'word/_rels/document.xml.rels': (x) =>
        x.replace(
          '</Relationships>',
          `<Relationship Id="rIdX" Type="${IMAGE_REL}" Target="http://169.254.169.254/latest/meta-data" TargetMode="External"/></Relationships>`,
        ),
    });
    const includePicture = patchZip(base, {
      'word/document.xml': (x) =>
        x.replace(
          '</w:body>',
          '<w:p><w:fldSimple w:instr=\' INCLUDEPICTURE "file:///etc/passwd" \\d \'><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p></w:body>',
        ),
    });
    // A field code split over runs, as Word writes it.
    const includeText = patchZip(base, {
      'word/document.xml': (x) =>
        x.replace(
          '</w:body>',
          '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDE</w:instrText></w:r>' +
            '<w:r><w:instrText>TEXT "\\\\\\\\server\\\\share\\\\x.docx" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
            '<w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>',
        ),
    });
    const vml = patchZip(base, {
      'word/document.xml': (x) =>
        x.replace(
          '</w:body>',
          '<w:p><w:r><w:pict><v:shape><v:imagedata src="http://example.com/a.png"/></v:shape></w:pict></w:r></w:p></w:body>',
        ),
    });
    const settingsRel = patchZip(base, {
      'word/_rels/settings.xml.rels': () =>
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/Normal.dotm" TargetMode="External"/></Relationships>',
    });
    for (const [name, content, message] of [
      ['linked image', linkedImage, /links to something outside the file/],
      ['INCLUDEPICTURE', includePicture, /INCLUDEPICTURE field/],
      ['INCLUDETEXT split over runs', includeText, /INCLUDETEXT field/],
      ['VML linked picture', vml, /picture linked by address/],
      ['attached template', settingsRel, /links to something outside the file/],
      ['not a Word file', Buffer.from('plain text, not a zip'), /not a Word document/],
    ] as const) {
      const { media, calls } = fakeMedia();
      const err = await docxRenderer
        .render(model(), tpl(content), 'X', context(media))
        .catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(RenderError);
      expect((err as Error).message, name).toMatch(message);
      expect(calls, name).toHaveLength(0);
    }
    // A plain HYPERLINK field or a page number is fine.
    const pageField = patchZip(base, {
      'word/document.xml': (x) =>
        x.replace(
          '</w:body>',
          '<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:body>',
        ),
    });
    const { media } = fakeMedia();
    await expect(
      docxRenderer.render(model(), tpl(pageField), 'X', context(media)),
    ).resolves.toHaveLength(1);
  });

  it('refuses an HTML template for Word', async () => {
    const { media } = fakeMedia();
    await expect(
      docxRenderer.render(
        model(),
        { templateId: 't', versionId: 'v', version: 1, kind: 'html', content: '<p>{{ area }}</p>' },
        'X',
        context(media),
      ),
    ).rejects.toBeInstanceOf(RenderError);
  });
});

describe('the photo module', () => {
  it('puts a field’s photos in the text, with relationships, media files and content types', async () => {
    const { files, doc, calls } = await render(['Fault: {{%fault}} end']);
    assertBalanced(doc);
    const pics = pictures(files, 'word/document.xml');
    expect(pics).toHaveLength(2);
    for (const p of pics) {
      expect(p.rel?.type).toBe(IMAGE_REL);
      expect(p.rel?.mode).toBeUndefined();
      expect(p.rel?.target).toMatch(/^media\/ffpic\d+\.jpeg$/);
      expect(p.media?.length).toBeGreaterThan(100);
      // Two photos share the line: each at most half of 15 cm.
      expect(p.cx).toBeLessThanOrEqual(7.5 * 360_000);
    }
    expect(new Set(pics.map((p) => p.rel?.target)).size).toBe(2);
    expect(text(files, '[Content_Types].xml')).toMatch(
      /Extension="jpeg"[^>]*|ContentType="image\/jpeg"[^>]*Extension="jpeg"/,
    );
    // The text around the tag is kept, in the same paragraph.
    expect(doc).toMatch(
      /Fault: <\/w:t><w:drawing>[\s\S]*<\/w:drawing><w:t xml:space="preserve"> end<\/w:t>/,
    );
    expect(calls.filter((c) => c.kind === 'load').map((c) => c.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
    ]);
  });

  it('shows the row’s own photo and signature inside a group loop', async () => {
    const { files, shown } = await render([
      '{{#items}}',
      'Row {{item}}: {{%photo}} signed {{%checked_by}}',
      '{{/items}}',
      [
        ['Item', 'Photo'],
        ['{{#items}}{{item}}', '{{%photo}}{{/items}}'],
      ],
    ]);
    expect(shown).toContain('Row Soap: ');
    expect(shown).toContain('Row Paper: ');
    const pics = pictures(files, 'word/document.xml');
    // Paragraph loop: row 1 photo + 2 signatures; table: row 1 photo again.
    expect(pics).toHaveLength(4);
    expect(pics.every((p) => p.rel?.type === IMAGE_REL && p.media)).toBe(true);
    const targets = pics.map((p) => p.rel!.target);
    // The same photo used twice is one file.
    expect(targets[0]).toBe(targets[3]);
    expect(new Set(targets).size).toBe(3);
    // In a table cell the photo is smaller.
    expect(pics[3]!.cx).toBeLessThanOrEqual(5.5 * 360_000);
    expect(pics[0]!.cx).toBeLessThanOrEqual(15 * 360_000);
  });

  it('takes media names, the logo in a header, and tags split over runs', async () => {
    const { files, calls } = await render(
      [
        'Second: {{%fault-2}}',
        { runs: ['Sig: {{%sig', 'nature}}'] },
        'Row 2 signature {{%items-2-checked_by}}',
      ],
      { header: ['{{%_logo}} {{_branding.name}}'] },
    );
    expect(pictures(files, 'word/document.xml')).toHaveLength(3);
    const header = Object.keys(files).find((n) => /^word\/header\d*\.xml$/.test(n))!;
    const logo = pictures(files, header);
    expect(logo).toHaveLength(1);
    expect(logo[0]!.rel?.target).toMatch(/\.png$/);
    expect(logo[0]!.cx).toBeLessThanOrEqual(6 * 360_000);
    expect(text(files, '[Content_Types].xml')).toMatch(/Extension="png"/);
    expect(visibleText(text(files, header))).toContain('Delta Facilities');
    expect(calls.map((c) => c.id)).toEqual([
      'logo-blob',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000013',
    ]);
  });

  it('only ever shows pictures of the model: other names show nothing and load nothing', async () => {
    const m = model({ ...ANSWERS, notes: '00000000-0000-4000-8000-000000000099' });
    const { files, calls } = await render(
      [
        '[{{%area}}][{{%notes}}][{{%not_a_field}}][{{%fault-9}}][{{%photo}}][{{%constructor}}]',
        '{{#items}}[{{%.}}]{{/items}}',
        '{{#_fields}}{{#media}}{{%.}}{{/media}}{{/_fields}}',
      ],
      {},
      m,
    );
    // Only the loop over `_fields` media names shows pictures: each one in the model.
    const ids = calls.filter((c) => c.kind === 'load').map((c) => c.id);
    expect(ids).not.toContain('00000000-0000-4000-8000-000000000099');
    expect(ids.sort()).toEqual(
      ['000000000001', '000000000003', '000000000004'].map((n) => `00000000-0000-4000-8000-${n}`),
    );
    expect(pictures(files, 'word/document.xml')).toHaveLength(3);
  });

  it('caps a template at EMBED_MAX_IMAGES pictures and notes it', async () => {
    const many = Array.from({ length: EMBED_MAX_IMAGES + 3 }, (_, i) => ({
      blobId: `00000000-0000-4000-8000-${String(2000 + i).padStart(12, '0')}`,
    }));
    const { files, calls, shown } = await render(
      ['{{%fault}}', '{{%signature}}'],
      {},
      model({ ...ANSWERS, fault: many }),
    );
    expect(calls.filter((c) => c.kind === 'load')).toHaveLength(EMBED_MAX_IMAGES);
    expect(pictures(files, 'word/document.xml')).toHaveLength(EMBED_MAX_IMAGES);
    expect(shown).toContain('more pictures than one document can hold');
  });

  it('never overwrites the template’s own pictures or relationship ids', async () => {
    const original = Buffer.from('original picture bytes');
    const content = patchZip(await wordTemplate(['{{%fault}} {{%signature}}']), {
      'word/media/ffpic1.png': () => original.toString('latin1'),
      'word/media/ffpic2.jpeg': () => original.toString('latin1'),
      'word/_rels/document.xml.rels': (x) =>
        x.replace(
          '</Relationships>',
          `<Relationship Id="rIdFfPic1" Type="${IMAGE_REL}" Target="media/ffpic1.png"/></Relationships>`,
        ),
    });
    const { media } = fakeMedia();
    const [file] = await docxRenderer.render(model(), tpl(content), 'X', context(media));
    const files = unzip(file!.data);
    expect(Buffer.from(files['word/media/ffpic1.png']!).toString('latin1')).toBe(
      original.toString('latin1'),
    );
    expect(Buffer.from(files['word/media/ffpic2.jpeg']!).toString('latin1')).toBe(
      original.toString('latin1'),
    );
    const pics = pictures(files, 'word/document.xml');
    expect(pics).toHaveLength(3);
    const targets = pics.map((p) => p.rel!.target);
    expect(new Set(targets).size).toBe(3);
    expect(targets).not.toContain('media/ffpic1.png');
    expect(targets).not.toContain('media/ffpic2.jpeg');
    expect(pics.map((p) => p.rId)).not.toContain('rIdFfPic1');
    const rels = relationships(text(files, 'word/_rels/document.xml.rels'));
    expect(rels.get('rIdFfPic1')?.target).toBe('media/ffpic1.png');
  });

  it('shows nothing for a missing file', async () => {
    const { media } = fakeMedia({ missing: ['00000000-0000-4000-8000-000000000004'] });
    const content = await wordTemplate(['Signed: [{{%signature}}]']);
    const [file] = await docxRenderer.render(model(), tpl(content), 'X', context(media));
    const files = unzip(file!.data);
    expect(pictures(files, 'word/document.xml')).toHaveLength(0);
    expect(visibleText(text(files, 'word/document.xml'))).toContain('Signed: []');
  });
});

const soffice = ['/usr/bin/soffice', '/usr/local/bin/soffice'].find((p) => existsSync(p));

describe.skipIf(!soffice)('LibreOffice opens the output (the PDF route for Word templates)', () => {
  it('converts the built-in layout and a template with pictures to PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ff-docx-'));
    try {
      const { media } = fakeMedia();
      const [builtIn] = await docxRenderer.render(model(), null, 'builtin', context(media));
      const content = await wordTemplate(
        [
          'Area {{area}}',
          '{{#items}}',
          'Row {{item}} {{%photo}} {{%checked_by}}',
          '{{/items}}',
          '{{%fault}}',
        ],
        { header: ['{{%_logo}} {{_branding.name}}'] },
      );
      const [fromTemplate] = await docxRenderer.render(
        model(),
        tpl(content),
        'template',
        context(media),
      );
      for (const f of [builtIn!, fromTemplate!]) {
        await writeFile(join(dir, f.filename), f.data);
        execFileSync(
          soffice!,
          [
            // A private profile, so this never waits on (or clashes with) another LibreOffice.
            `-env:UserInstallation=file://${join(dir, 'profile')}`,
            '--headless',
            '--convert-to',
            'pdf',
            '--outdir',
            dir,
            join(dir, f.filename),
          ],
          {
            stdio: 'ignore',
            timeout: 120_000,
          },
        );
        const pdf = await readFile(join(dir, f.filename.replace(/\.docx$/, '.pdf')));
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        // The logo, the photos and the signatures are images in the PDF (identical ones shared).
        expect(
          (pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length,
        ).toBeGreaterThanOrEqual(3);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
