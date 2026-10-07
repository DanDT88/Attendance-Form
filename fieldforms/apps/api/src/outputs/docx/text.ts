/**
 * Small helpers shared by the Word and Excel layouts.
 */

/**
 * Characters XML 1.0 cannot hold (control characters other than tab and line breaks, and the
 * non-characters U+FFFE/U+FFFF). One stray character from a scanner or a paste would otherwise
 * make Word or Excel refuse the whole file.
 */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function cleanText(s: string): string {
  return s.replace(NOT_XML, '');
}

const DEFAULT_COLOUR = '1F4E79';

/** The branding colour as six hex digits (no '#'), or a dark blue when it is not a colour. */
export function brandHex(colour: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((colour ?? '').trim());
  if (m) return m[1]!.toUpperCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec((colour ?? '').trim());
  if (short)
    return `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
  return DEFAULT_COLOUR;
}

/** Black or white, whichever reads better on the colour. */
export function textOn(hex: string): string {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Above this, black text has more contrast than white (WCAG contrast ratios are equal).
  return luminance > 0.179 ? '000000' : 'FFFFFF';
}
