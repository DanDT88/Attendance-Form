import { SITE_INSPECTION, templateData, type FormDefinition } from '@fieldforms/shared';
import { describe, expect, it } from 'vitest';
import { renderLiquid } from '../src/lib/liquid.js';
import { docxRenderer } from '../src/outputs/renderers/docx.js';
import { analyzeTemplate } from '../src/outputs/templates/analyze.js';
import { starterTemplate } from '../src/outputs/templates/starter.js';
import {
  DEF,
  assertBalanced,
  context,
  fakeMedia,
  model,
  text,
  unzip,
  visibleText,
} from './outputs-docx-fixtures.js';

const docxRef = (content: Buffer) => ({
  templateId: 'starter',
  versionId: 'sv',
  version: 1,
  kind: 'docx' as const,
  content,
});

describe('starter templates', () => {
  for (const [name, def] of [
    ['the test form', DEF],
    ['the demo site inspection', SITE_INSPECTION],
  ] as const) {
    for (const kind of ['docx', 'html'] as const) {
      it(`${kind} for ${name} uses every field and analyses clean`, async () => {
        const file = await starterTemplate(kind, def, 'Site inspection');
        expect(file.filename).toBe(`Site inspection template.${kind}`);
        expect(file.contentType).toMatch(kind === 'docx' ? /wordprocessingml/ : /^text\/html/);
        const a = await analyzeTemplate(
          kind,
          kind === 'html' ? file.data.toString('utf8') : file.data,
          [{ version: 1, definition: def }],
        );
        expect(a.errors).toEqual([]);
        expect(a.warnings).toEqual([]);
        for (const p of ['_site', '_captured', '_branding.name', '_branding.footer']) {
          expect(a.placeholders).toContain(p);
        }
        for (const f of def.fields) {
          if (f.type === 'note') continue;
          if (f.type === 'image' || f.type === 'signature') {
            // Word: a picture tag; HTML: the picture by its name in `_images`.
            if (kind === 'docx') expect(a.placeholders).toContain(`%${f.id}`);
            continue;
          }
          expect(a.placeholders, f.id).toContain(f.id);
          if (f.type === 'group') {
            for (const c of f.fields) {
              if (c.type === 'image' || c.type === 'signature') {
                if (kind === 'docx') expect(a.placeholders).toContain(`%${f.id}.${c.id}`);
              } else expect(a.placeholders).toContain(`${f.id}.${c.id}`);
            }
          }
        }
        if (kind === 'docx') expect(a.placeholders).toContain('%_logo');
      });
    }
  }

  it('Word starter renders a submission with its photos, signatures, rows and logo', async () => {
    const file = await starterTemplate('docx', DEF, 'Site inspection');
    const { media, calls } = fakeMedia();
    const [out] = await docxRenderer.render(model(), docxRef(file.data), 'S', context(media));
    const files = unzip(out!.data);
    const doc = text(files, 'word/document.xml');
    assertBalanced(doc);
    const shown = visibleText(doc);
    for (const s of [
      'Site inspection',
      'Site: Sandton Office',
      'Submitted by: Thandi Nkosi',
      'Area inspected: Kitchen & pantry',
      'Score: 72.5',
      'Notes: Line one\nLine two <b>&</b>',
      'Soap',
      'Paper',
      'Location: -26.20410, 28.04730 (±5 m)',
    ]) {
      expect(shown).toContain(s);
    }
    expect(shown).not.toContain('No rows.');
    expect(shown).not.toMatch(/\{\{|\}\}|undefined/);
    // fault ×2, signature, row 1 photo, two row signatures; and the logo in the header.
    expect((doc.match(/<w:drawing>/g) ?? []).length).toBe(6);
    const header = Object.keys(files).find((n) => /^word\/header\d*\.xml$/.test(n))!;
    expect(text(files, header)).toContain('<w:drawing>');
    expect(visibleText(text(files, header))).toContain('Delta Facilities');
    expect(calls.filter((c) => c.kind === 'load')).toHaveLength(6);
    // A submission with no rows says so.
    const [empty] = await docxRenderer.render(
      model({ ...model().raw, items: [] }),
      docxRef(file.data),
      'S',
      context(media),
    );
    expect(visibleText(text(unzip(empty!.data), 'word/document.xml'))).toContain('No rows.');
  });

  it('HTML starter renders with Liquid, pictures coming from `_images` by name', async () => {
    const file = await starterTemplate('html', DEF, 'Site inspection');
    const m = model();
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const data = {
      ...templateData(m),
      _images: {
        _logo: png,
        'fault-1': png,
        'fault-2': png,
        signature: png,
        'items-1-photo-1': png,
        'items-1-checked_by': png,
        'items-2-checked_by': png,
      },
    };
    const html = await renderLiquid(file.data.toString('utf8'), data, 'html');
    for (const s of [
      '<td>Kitchen &amp; pantry</td>',
      '<td>Sandton Office</td>',
      '<td>Soap</td>',
      '<td>10</td>',
      '2 rows (below)',
      'background: #0B6E4F',
      'Delta Facilities (Pty) Ltd',
    ]) {
      expect(html).toContain(s);
    }
    expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    expect((html.match(/<img class="photo"/g) ?? []).length).toBe(3);
    expect((html.match(/<img class="signature"/g) ?? []).length).toBe(3);
    expect((html.match(/<img class="logo"/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/undefined|\{\{|\{%/);
  });

  it('keeps labels as text: a label cannot become a tag in either kind', async () => {
    const def: FormDefinition = {
      ...DEF,
      fields: [
        {
          id: 'cost',
          type: 'number',
          label: 'Cost {{ _id }} {% raw %} <script>alert(1)</script> {{@x}}',
        },
        {
          id: 'parts',
          type: 'group',
          label: 'Parts {{#cost}}',
          fields: [{ id: 'part', type: 'text', label: 'Part {{_url}}' }],
        },
        {
          id: 'only_notes',
          type: 'group',
          label: 'Only notes',
          fields: [{ id: 'hint', type: 'note', label: 'Hint' }],
        },
      ],
    };
    for (const kind of ['docx', 'html'] as const) {
      const file = await starterTemplate(kind, def, 'Labels');
      const a = await analyzeTemplate(
        kind,
        kind === 'html' ? file.data.toString('utf8') : file.data,
        [{ version: 1, definition: def }],
      );
      expect(a.errors, kind).toEqual([]);
      expect(a.placeholders, kind).not.toContain('_id');
      expect(a.placeholders, kind).not.toContain('_url');
    }
    const html = (await starterTemplate('html', def, 'Labels')).data.toString('utf8');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Cost &#123;&#123; _id &#125;&#125;');

    // A one-column group still repeats a table row per entry.
    const word = await starterTemplate('docx', def, 'Labels');
    const m = model({ cost: 5, parts: [{ part: 'Bolt' }, { part: 'Nut' }] }, def);
    const { media } = fakeMedia();
    const [out] = await docxRenderer.render(m, docxRef(word.data), 'S', context(media));
    const doc = text(unzip(out!.data), 'word/document.xml');
    const shown = visibleText(doc);
    expect(shown).toContain('Cost {​{ _id }​}');
    expect(shown).not.toContain(m.submission.id);
    expect((doc.match(/<w:tr>|<w:tr /g) ?? []).length).toBe(3);
    expect(shown).toMatch(/Bolt\n[\s\S]*Nut\n/);
  });
});
