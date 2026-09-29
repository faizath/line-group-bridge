// LINE counts every length limit in UTF-16 code units, which is exactly
// JavaScript's String.prototype.length.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Control and invisible format characters; used for single-line fields.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

/** Collapses whitespace and strips control/format characters (for display names). */
export function cleanSingleLine(s: string): string {
  return s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Truncates to at most `max` UTF-16 units without splitting a grapheme cluster
 * (and therefore never a surrogate pair). Appends `…` when truncated and room remains.
 */
export function fit(s: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const budget = max - ellipsis.length;
  let out = '';
  if (budget > 0) {
    for (const { segment } of segmenter.segment(s)) {
      if (out.length + segment.length > budget) break;
      out += segment;
    }
    return out + ellipsis;
  }
  for (const { segment } of segmenter.segment(s)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

/**
 * Splits text into chunks of at most `max` units, preferring the last newline,
 * then the last space before the limit, never splitting a grapheme cluster.
 */
export function splitText(s: string, max: number): string[] {
  const parts: string[] = [];
  let rest = s;
  while (rest.length > max) {
    // Largest grapheme-safe prefix ≤ max.
    let safe = 0;
    for (const { index, segment } of segmenter.segment(rest)) {
      if (index + segment.length > max) break;
      safe = index + segment.length;
    }
    if (safe === 0) safe = Math.min(max, rest.length);
    const window = rest.slice(0, safe);
    const nl = window.lastIndexOf('\n');
    const sp = window.lastIndexOf(' ');
    const cut = nl > safe / 2 ? nl + 1 : sp > safe / 2 ? sp + 1 : safe;
    parts.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}
