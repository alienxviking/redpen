import type { ExtractedDocument, PositionedToken } from "../../domain/types.js";

/**
 * Registering a transcription against the page's own OCR geometry.
 *
 * A vision model reads a page image and reports boxes normalised 0-1000, but its idea
 * of where the page edges are does not always match the PDF's. On a phone scan the
 * result is a small, *consistent* vertical offset - measured at about 24pt on a 792pt
 * page, which is roughly one line of handwriting. Every box then sits a line low, and
 * the last one lands on blank paper.
 *
 * When the scanner has embedded its own OCR layer we have a second opinion on geometry
 * that is worth more than it looks. Its *text* may be unusable - that is precisely why
 * we transcribed the page again - but its *positions* were derived from the pixels, so
 * they are trustworthy. So: take the words from the transcription and the registration
 * from the text layer.
 *
 * The offset is chosen by agreement rather than by averaging. Each transcribed line
 * votes for the shift that would align it with its nearest text-layer line, and the
 * shift with the most votes wins. A mean would be dragged around by lines the text
 * layer never saw; a vote ignores them.
 */

/** Lines closer together than this are treated as the same row. */
const ROW_TOLERANCE = 4;

/** Below this level of agreement the correction is not trustworthy, so nothing moves. */
const MIN_AGREEMENT = 0.4;

/** Never apply a correction larger than this - a big shift means a bad match, not drift. */
const MAX_SHIFT = 60;

function rowCentres(tokens: PositionedToken[], page: number): number[] {
  const centres = tokens
    .filter((t) => t.page === page)
    .map((t) => t.y + t.h / 2)
    .sort((a, b) => a - b);

  // Collapse tokens that share a row into one centre.
  const rows: number[] = [];
  for (const c of centres) {
    const last = rows[rows.length - 1];
    if (last === undefined || Math.abs(c - last) > ROW_TOLERANCE) rows.push(c);
  }
  return rows;
}

export interface Alignment {
  page: number;
  shift: number;
  agreement: number;
  applied: boolean;
}

/**
 * Shift each page of `vision` so its rows line up with `reference`'s rows.
 * Returns a new document; the input is not modified.
 */
export function alignToTextLayer(
  vision: ExtractedDocument,
  reference: ExtractedDocument,
): { document: ExtractedDocument; alignments: Alignment[] } {
  const alignments: Alignment[] = [];
  const shifts = new Map<number, number>();

  for (const page of vision.pages) {
    const visionRows = rowCentres(vision.tokens, page.page);
    const referenceRows = rowCentres(reference.tokens, page.page);

    if (visionRows.length < 3 || referenceRows.length < 3) {
      alignments.push({ page: page.page, shift: 0, agreement: 0, applied: false });
      continue;
    }

    // Every transcribed row votes for the shift that would align it with its nearest
    // reference row. Bucket the votes to the nearest point and take the winner.
    const votes = new Map<number, number>();
    for (const v of visionRows) {
      const nearest = referenceRows.reduce((a, b) =>
        Math.abs(b - v) < Math.abs(a - v) ? b : a,
      );
      const shift = Math.round(nearest - v);
      if (Math.abs(shift) > MAX_SHIFT) continue;
      votes.set(shift, (votes.get(shift) ?? 0) + 1);
    }

    let best = 0;
    let bestVotes = 0;
    for (const [shift, count] of votes) {
      // Count neighbouring buckets too, so 23pt and 24pt reinforce rather than split.
      const support = (votes.get(shift - 1) ?? 0) + count + (votes.get(shift + 1) ?? 0);
      if (support > bestVotes) {
        bestVotes = support;
        best = shift;
      }
    }

    const agreement = bestVotes / visionRows.length;
    const applied = agreement >= MIN_AGREEMENT && best !== 0;
    if (applied) shifts.set(page.page, best);
    alignments.push({ page: page.page, shift: best, agreement: Number(agreement.toFixed(2)), applied });
  }

  if (shifts.size === 0) return { document: vision, alignments };

  const height = new Map(vision.pages.map((p) => [p.page, p.height]));
  const tokens = vision.tokens.map((t) => {
    const shift = shifts.get(t.page);
    if (shift === undefined) return t;
    const pageHeight = height.get(t.page) ?? t.y + t.h;
    return { ...t, y: Math.min(Math.max(t.y + shift, 0), Math.max(pageHeight - t.h, 0)) };
  });

  return { document: { ...vision, tokens }, alignments };
}
