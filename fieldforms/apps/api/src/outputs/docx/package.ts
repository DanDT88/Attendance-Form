import { unzipSync } from 'fflate';
import PizZip from 'pizzip';

/**
 * Word files are ZIP packages that can point outside themselves: a picture linked by URL, a field
 * that includes another file (INCLUDEPICTURE, INCLUDETEXT, LINK), an OLE link or an attached
 * template on a network share. LibreOffice follows some of these when it converts to PDF, which
 * would let a template reach the network or the renderer's files. Templates with any of them are
 * refused, as are packages that would unpack to an unreasonable size.
 */

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export class PackageError extends Error {}

/**
 * Opens a Word package after checking the sizes its directory declares (a ZIP bomb is refused
 * before anything is inflated).
 */
export function openPackage(content: Buffer): PizZip {
  let entries = 0;
  let total = 0;
  let tooBig = false;
  try {
    unzipSync(new Uint8Array(content.buffer, content.byteOffset, content.byteLength), {
      filter(file) {
        entries++;
        total += file.originalSize;
        if (file.originalSize > MAX_ENTRY_BYTES) tooBig = true;
        return false;
      },
    });
  } catch {
    throw new PackageError('The file is not a Word document (.docx)');
  }
  if (entries > MAX_ENTRIES || total > MAX_TOTAL_BYTES || tooBig) {
    throw new PackageError('The Word file unpacks to more than 80 MB; make it smaller');
  }
  let zip: PizZip;
  try {
    zip = new PizZip(content);
  } catch {
    throw new PackageError('The file is not a Word document (.docx)');
  }
  if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) {
    throw new PackageError('The file is not a Word document (.docx)');
  }
  return zip;
}

/** Field codes that read another file or address when the document is opened or converted. */
const REMOTE_FIELDS = new Set([
  'INCLUDEPICTURE',
  'INCLUDETEXT',
  'LINK',
  'IMPORT',
  'DDE',
  'DDEAUTO',
]);

/**
 * Numeric character references decoded (`&#69;xternal` is "External" to every XML parser), so a
 * check below cannot be dodged by spelling a keyword with them.
 */
const decodeNumeric = (s: string) =>
  s.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_, n: string) => {
    const code = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The field instructions in a part: complex fields (`w:fldChar` begin … `w:instrText` … separate
 * or end, possibly nested) and simple ones (`w:fldSimple w:instr`). Returns each field's code.
 */
export function fieldCodes(xml: string): string[] {
  const codes: string[] = [];
  const stack: { text: string; done: boolean }[] = [];
  const re =
    /<w:fldChar\b[^>]*\bw:fldCharType\s*=\s*["'](begin|separate|end)["'][^>]*>|<w:instrText\b[^>]*>([^<]*)<\/w:instrText>|<w:fldSimple\b[^>]*\bw:instr\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] === 'begin') stack.push({ text: '', done: false });
    else if (m[1] === 'separate' || m[1] === 'end') {
      const top = stack[stack.length - 1];
      if (top && !top.done) {
        codes.push(top.text);
        top.done = true;
      }
      if (m[1] === 'end') stack.pop();
    } else if (m[2] !== undefined) {
      const top = stack[stack.length - 1];
      if (top && !top.done) top.text += decode(m[2]);
    } else codes.push(decode(m[3] ?? m[4] ?? ''));
  }
  // A field left open at the end of the part still counts.
  for (const f of stack) if (!f.done) codes.push(f.text);
  return codes;
}

const fieldName = (code: string) => (/^\s*([A-Za-z]+)/.exec(code)?.[1] ?? '').toUpperCase();

/** Problems that make a Word package unsafe to render; empty when it is fine. */
export function packageProblems(zip: PizZip): string[] {
  const problems = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.rels')) {
      const rels = decodeNumeric(entry.asText());
      // External mode, or a target with a URI scheme (file:, http:, …) whatever its mode says.
      if (
        /\bTargetMode\s*=\s*["']\s*External\s*["']/i.test(rels) ||
        /\bTarget\s*=\s*["']\s*[a-z][a-z0-9+.-]*:/i.test(rels)
      ) {
        problems.add(
          'The template links to something outside the file (a linked picture, a hyperlink, an ' +
            'attached template or a linked object). Remove the links, embed pictures, and upload it again.',
        );
      }
      if (/relationships\/(aFChunk|subDocument)["']/i.test(rels)) {
        problems.add(
          'The template includes another document (an alternative format chunk or a subdocument).',
        );
      }
    } else if (
      lower.endsWith('.xml') &&
      (lower.startsWith('word/') || lower.startsWith('customxml/'))
    ) {
      const xml = decodeNumeric(entry.asText());
      for (const code of fieldCodes(xml)) {
        const f = fieldName(code);
        if (REMOTE_FIELDS.has(f)) {
          problems.add(
            `The template has a ${f} field, which reads another file or address. Remove it.`,
          );
        }
      }
      if (/<v:imagedata\b[^>]*\b(?:src|o:href)\s*=\s*["'][^"']+["']/i.test(xml)) {
        problems.add(
          'The template has a picture linked by address. Insert the picture into the file instead.',
        );
      }
    }
  }
  return [...problems];
}
