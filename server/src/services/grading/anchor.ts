import type { ExtractedDocument, PositionedToken, Rect } from "../../domain/types.js";
import { tokensInRange } from "../pdf/extractText.js";
import { flatten, type Mapped } from "../text/normalise.js";

/**
 * Locating an evidence quote inside the answer paper.
 *
 * The grader returns quotes it believes are verbatim, but in practice they drift:
 * whitespace collapses, a misspelling gets silently corrected, a clause is trimmed.
 * An exact string search would fail on most real quotes and we would lose the
 * annotation. So we search in three widening steps and always report *how well* the
 * quote matched, which feeds the confidence score and the human-review flag.
 */

export interface AnchorResult {
  rects: Rect[];
  score: number; // 0..1
  anchored: boolean;
  /** The text actually matched in the document, useful for debugging drift. */
  matchedText: string | null;
}

const MIN_ACCEPTABLE_SCORE = 0.55;

/**
 * A lower-cased, whitespace-collapsed view of a string, with a map back to the
 * original offsets. Shared with the offline grader so both search the same way.
 */
type Normalised = Mapped;

function normalise(input: string): Normalised {
  const flat = flatten(input);
  return { text: flat.text.toLowerCase(), map: flat.map };
}

/** Damerau-free Levenshtein distance, two-row variant. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

interface Word {
  text: string;
  start: number; // index into normalised text
  end: number;
}

function words(norm: string): Word[] {
  const result: Word[] = [];
  const re = /[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    result.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return result;
}

/**
 * Find the best matching span for `quote` inside `haystack`.
 * Returns normalised-space offsets, or null if nothing came close.
 */
function findBestSpan(
  haystack: Normalised,
  quote: string,
): { start: number; end: number; score: number } | null {
  const q = normalise(quote);
  if (q.text.length === 0) return null;

  // 1. Exact (post-normalisation) hit - the common case.
  const exact = haystack.text.indexOf(q.text);
  if (exact !== -1) {
    return { start: exact, end: exact + q.text.length, score: 1 };
  }

  const hayWords = words(haystack.text);
  const quoteWords = words(q.text);
  if (hayWords.length === 0 || quoteWords.length === 0) return null;

  // 2. Word-window scan. Try windows around the quote's word count so that a quote
  //    with a dropped or added word still lines up.
  const target = quoteWords.length;
  const widths = new Set<number>();
  for (const delta of [0, -2, -1, 1, 2]) {
    const w = target + delta;
    if (w >= 1 && w <= hayWords.length) widths.add(w);
  }

  let best: { start: number; end: number; score: number } | null = null;
  for (const width of widths) {
    for (let i = 0; i + width <= hayWords.length; i++) {
      const start = hayWords[i]!.start;
      const end = hayWords[i + width - 1]!.end;
      const candidate = haystack.text.slice(start, end);
      // Cheap prefilter: length must be in the same ballpark before we pay for
      // an edit-distance computation on every window in the document.
      const ratio = candidate.length / q.text.length;
      if (ratio < 0.55 || ratio > 1.8) continue;
      const score = similarity(candidate, q.text);
      if (!best || score > best.score) best = { start, end, score };
    }
  }

  // 3. Last resort for a long quote whose ends drifted: anchor on the most
  //    distinctive word and take a span of the quote's length around it.
  if ((!best || best.score < MIN_ACCEPTABLE_SCORE) && quoteWords.length >= 3) {
    const rare = [...quoteWords]
      .filter((w) => w.text.length >= 5)
      .sort((a, b) => b.text.length - a.text.length)[0];
    if (rare) {
      const at = haystack.text.indexOf(rare.text);
      if (at !== -1) {
        const start = Math.max(0, at - Math.floor(q.text.length / 2));
        const end = Math.min(haystack.text.length, start + q.text.length);
        const score = similarity(haystack.text.slice(start, end), q.text);
        if (!best || score > best.score) best = { start, end, score };
      }
    }
  }

  return best;
}

/**
 * Group tokens into per-line rectangles. One box per visual line reads far better on
 * the page than a single box spanning a wrapped sentence, which would swallow the
 * text to the left and right of it.
 */
export function rectsForTokens(tokens: PositionedToken[]): Rect[] {
  if (tokens.length === 0) return [];
  const lines: PositionedToken[][] = [];
  for (const token of tokens) {
    const line = lines.find((l) => {
      const head = l[0]!;
      return head.page === token.page && Math.abs(head.y - token.y) <= head.h * 0.6;
    });
    if (line) line.push(token);
    else lines.push([token]);
  }

  const pad = 1.5;
  return lines.map((line) => {
    const page = line[0]!.page;
    const x0 = Math.min(...line.map((t) => t.x));
    const y0 = Math.min(...line.map((t) => t.y));
    const x1 = Math.max(...line.map((t) => t.x + t.w));
    const y1 = Math.max(...line.map((t) => t.y + t.h));
    return {
      page,
      x: x0 - pad,
      y: y0 - pad,
      w: Math.max(x1 - x0 + pad * 2, 4),
      h: Math.max(y1 - y0 + pad * 2, 6),
    };
  });
}

/** Locate `quote` in the answer document and return boxes to draw around it. */
export function anchorQuote(doc: ExtractedDocument, quote: string): AnchorResult {
  const empty: AnchorResult = { rects: [], score: 0, anchored: false, matchedText: null };
  if (!quote || quote.trim().length < 3 || doc.tokens.length === 0) return empty;

  const haystack = normalise(doc.text);
  const span = findBestSpan(haystack, quote);
  if (!span || span.score < MIN_ACCEPTABLE_SCORE) {
    return { ...empty, score: span?.score ?? 0 };
  }

  // Normalised offsets back to offsets in the original document text.
  const startOriginal = haystack.map[span.start];
  const endOriginal = haystack.map[Math.min(span.end - 1, haystack.map.length - 1)];
  if (startOriginal === undefined || endOriginal === undefined) return empty;

  const tokens = tokensInRange(doc, startOriginal, endOriginal + 1);
  const rects = rectsForTokens(tokens);
  if (rects.length === 0) return { ...empty, score: span.score };

  return {
    rects,
    score: Number(span.score.toFixed(3)),
    anchored: true,
    matchedText: doc.text.slice(startOriginal, endOriginal + 1),
  };
}
