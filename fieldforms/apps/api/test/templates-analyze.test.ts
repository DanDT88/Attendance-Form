import type { FormDefinition, GroupField } from '@fieldforms/shared';
import { describe, expect, it } from 'vitest';
import { analyzeTemplate } from '../src/outputs/templates/analyze.js';
import { DEF, patchZip, wordTemplate } from './outputs-docx-fixtures.js';

/** Version 1 has no `score` and no photo in the group; version 3 has `fault` as text. */
const V1: FormDefinition = {
  ...DEF,
  fields: DEF.fields
    .filter((f) => f.id !== 'score')
    .map((f) =>
      f.type === 'group'
        ? { ...f, fields: (f as GroupField).fields.filter((c) => c.id !== 'photo') }
        : f,
    ),
};
const V3: FormDefinition = {
  ...DEF,
  fields: DEF.fields.map((f) =>
    f.id === 'fault' ? { id: 'fault', type: 'text', label: 'Fault' } : f,
  ),
};
const VERSIONS = [
  { version: 1, definition: V1 },
  { version: 2, definition: DEF },
  { version: 3, definition: V3 },
];

describe('analyzing Word templates', () => {
  it('reports unknown names as errors and fields missing from some versions as warnings', async () => {
    const content = await wordTemplate([
      'Area {{area}} score {{score}} typo {{typo}} site {{_site}} {{_captured}} {{_branding.name}}',
      'Bad reserved {{_nope}} and {{_site.name}}',
      '{{#items}}',
      'Row {{item}} x {{qty}} {{%photo}} {{%checked_by}} {{area}} {{typo2}}',
      '{{/items}}',
      'Outside the loop: {{qty}}, the group itself: {{items}}',
      '{{^blank_note}}none{{/blank_note}}{{#needs_nothing}}x{{/needs_nothing}}',
      'Pictures {{%_logo}} {{%fault}} {{%fault-2}} {{%signature}} {{%items-1-checked_by}} {{%items-2-photo-1}}',
      'Wrong pictures {{%area}} {{%items-1-qty-1}} {{%nowhere}}',
      '{{#_fields}}{{label}}: {{text}}{{#media}}{{%.}}{{/media}}{{/_fields}}',
    ]);
    const a = await analyzeTemplate('docx', content, VERSIONS);
    expect(a.errors.sort()).toEqual(
      [
        'Unknown field "typo"',
        'Unknown field "typo2"',
        'Unknown field "qty"',
        'Unknown field "needs_nothing"',
        'Unknown field "nowhere"',
        'Unknown name "_nope"',
        'Unknown name "_site.name"',
        '"area" is not a photo or signature field',
        '"items.qty" is not a photo field',
      ].sort(),
    );
    expect(a.warnings.sort()).toEqual(
      [
        '"score" is not in version 1; it prints as blank there',
        '"items.photo" is not in version 1; it prints as blank there',
        '"fault" is not a photo or signature field in version 3; it prints nothing there',
        '"fault" is not a photo field in version 3; it prints nothing there',
        '{{items}} is a repeating group and prints nothing; repeat its rows with {{#items}}…{{/items}}',
      ].sort(),
    );
    for (const p of [
      'area',
      'score',
      '_site',
      '_captured',
      '_branding.name',
      'items',
      'items.item',
      'items.qty',
      '%items.photo',
      '%items.checked_by',
      'blank_note',
      '%_logo',
      '%fault',
      '%fault-2',
      '%signature',
      '%items-1-checked_by',
      '%items-2-photo-1',
      '_fields',
      '_fields.label',
      '_fields.text',
      '%.',
    ]) {
      expect(a.placeholders, p).toContain(p);
    }
  });

  it('refuses raw XML, calculations and broken sections', async () => {
    const a = await analyzeTemplate(
      'docx',
      await wordTemplate(['{{@raw}}', 'x {{a + b}} {{ area | upper }}']),
      VERSIONS,
    );
    expect(a.errors).toEqual([
      '{{@raw}}: raw XML tags are not allowed',
      '{{a + b}}: Word templates take names only (no calculations, filters or spaces)',
      '{{ area | upper }}: Word templates take names only (no calculations, filters or spaces)',
    ]);
    const unclosed = await analyzeTemplate(
      'docx',
      await wordTemplate(['{{#items}} no end']),
      VERSIONS,
    );
    expect(unclosed.errors.join(' ')).toMatch(/unclosed/i);
  });

  it('refuses templates with external links, and files that are not Word', async () => {
    const base = await wordTemplate(['{{area}}']);
    const linked = patchZip(base, {
      'word/_rels/document.xml.rels': (x) =>
        x.replace(
          '</Relationships>',
          '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>',
        ),
    });
    const a = await analyzeTemplate('docx', linked, VERSIONS);
    expect(a.errors[0]).toMatch(/links to something outside the file/);
    const notWord = await analyzeTemplate('docx', Buffer.from('<html></html>'), VERSIONS);
    expect(notWord.errors).toEqual(['The file is not a Word document (.docx)']);
    const clean = await analyzeTemplate('docx', base, VERSIONS);
    expect(clean).toEqual({ placeholders: ['area'], errors: [], warnings: [] });
  });

  it('cannot check field names without a published version', async () => {
    const a = await analyzeTemplate('docx', await wordTemplate(['{{anything}} {{_site}}']), []);
    expect(a.errors).toEqual([]);
    expect(a.warnings).toEqual([
      'There is no form version to check against, so field names were not checked',
    ]);
    expect(a.placeholders).toEqual(['anything', '_site']);
  });
});

describe('analyzing HTML (Liquid) templates', () => {
  it('checks variables, loop variables over groups and `_fields`, and reserved names', async () => {
    const html = `
      <h1>{{ _form }} {{ area }} {{ score }} {{ typo }}</h1>
      {% for row in items %}<p>{{ row.qty }} {{ row.nope }} {{ forloop.index }} {{ area }}</p>{% endfor %}
      {% for f in _fields %}{{ f.label }} {{ f.bogus }}{% for r in f.rows %}{{ r.anything }}{% endfor %}{% endfor %}
      {{ _site }} {{ _nope }} {{ _branding.colour }} {{ _images["fault-1"] }} {{ items.size }} {{ items | size }}
      {% assign x = area %}{{ x }} {{ _captured | date: "%Y" }} {{ items.first.qty }} {{ area.x }}
      {% if needs_nothing %}x{% endif %}`;
    const a = await analyzeTemplate('html', html, VERSIONS);
    expect(a.errors.sort()).toEqual(
      [
        'Unknown field "typo"',
        'Unknown field "items.nope"',
        'Unknown field "needs_nothing"',
        'Unknown name "_nope"',
        'Unknown name "f.bogus" (fields have id, label, type, text, rows, media)',
        '"area.x": a field has no parts',
      ].sort(),
    );
    expect(a.warnings).toEqual(['"score" is not in version 1; it prints as blank there']);
    for (const p of [
      '_form',
      'area',
      'items',
      'items.qty',
      '_fields',
      '_fields.label',
      '_site',
      '_branding.colour',
      '_images.fault-1',
      '_captured',
    ]) {
      expect(a.placeholders, p).toContain(p);
    }
  });

  it('reports syntax errors, unknown filters and includes', async () => {
    const broken = await analyzeTemplate('html', '{% for x in items %}no end', VERSIONS);
    expect(broken.errors[0]).toMatch(/^Template error: /);
    const filter = await analyzeTemplate('html', '{{ area | shout }}', VERSIONS);
    expect(filter.errors[0]).toMatch(/^Template error: .*shout/);
    for (const tag of ['{% include "x" %}', '{% render "x" %}', '{% layout "x" %}x']) {
      const a = await analyzeTemplate('html', tag, VERSIONS);
      expect(a.errors.join(' '), tag).toMatch(/include|render|layout|Template error/);
      expect(a.errors.length, tag).toBeGreaterThan(0);
    }
    expect(await analyzeTemplate('html', '<p>{{ area | upcase | raw }}</p>', VERSIONS)).toEqual({
      placeholders: ['area'],
      errors: [],
      warnings: [],
    });
  });

  it('warns about tags the PDF leaves out', async () => {
    const a = await analyzeTemplate(
      'html',
      '<SCRIPT>x()</script><link rel="stylesheet" href="https://x"><iframe src=x></iframe><p>{{ area }}</p>',
      VERSIONS,
    );
    expect(a.errors).toEqual([]);
    expect(a.warnings).toEqual([
      'PDFs leave out <script>, <link>, <iframe>: scripts, frames and external files are not loaded',
    ]);
    expect((await analyzeTemplate('html', '<p>a <scripted> b</p>', VERSIONS)).warnings).toEqual([]);
  });
});
