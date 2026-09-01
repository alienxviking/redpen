import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Annotation, AnnotationType, GradeResult } from "../../domain/types.js";

/**
 * Render an annotated *copy* of the answer paper.
 *
 * The original bytes are never mutated - they are parsed into a new document and the
 * marking is drawn on top, so the student's paper on disk stays exactly as submitted.
 *
 * Layout approach: boxes are drawn where the text actually is, and each one gets a
 * numbered badge. The teacher's note goes in the right-hand margin at the same height,
 * with a leader line back to the badge, stacking downwards when two notes collide.
 * Notes whose quote could not be located on the page are collected onto the summary
 * sheet instead of being dropped or, worse, drawn somewhere arbitrary.
 */

const COLOURS: Record<AnnotationType, { r: number; g: number; b: number }> = {
  error: { r: 0.84, g: 0.15, b: 0.16 },
  missing: { r: 0.9, g: 0.49, b: 0.07 },
  spelling: { r: 0.13, g: 0.44, b: 0.82 },
  layout: { r: 0.52, g: 0.25, b: 0.68 },
  praise: { r: 0.11, g: 0.55, b: 0.33 },
};

const LABELS: Record<AnnotationType, string> = {
  error: "Incorrect",
  missing: "Missing",
  spelling: "Spelling",
  layout: "Layout",
  praise: "Good",
};

const NOTE_WIDTH = 150;
const NOTE_FONT_SIZE = 6.5;
const NOTE_LINE_HEIGHT = 8;
const NOTE_GAP = 6;

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        // A single word longer than the column: hard-break it.
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    lines.push(line);
  }
  return lines.filter((l) => l.length > 0);
}

/** Tracks where notes have already been placed on a page so they never overlap. */
class MarginColumn {
  private occupied: Array<{ top: number; bottom: number }> = [];
  constructor(private readonly pageHeight: number) {}

  place(preferredTop: number, height: number): number {
    let top = Math.min(preferredTop, this.pageHeight - 20);
    for (let guard = 0; guard < 200; guard++) {
      const bottom = top - height;
      const clash = this.occupied.find((o) => top > o.bottom - NOTE_GAP && bottom < o.top + NOTE_GAP);
      if (!clash) break;
      top = clash.bottom - NOTE_GAP;
    }
    this.occupied.push({ top, bottom: top - height });
    return top;
  }
}

function drawBadge(page: PDFPage, font: PDFFont, x: number, y: number, n: number, colour: { r: number; g: number; b: number }) {
  const radius = 6.5;
  page.drawCircle({
    x,
    y,
    size: radius,
    color: rgb(colour.r, colour.g, colour.b),
    borderColor: rgb(1, 1, 1),
    borderWidth: 0.75,
  });
  const label = String(n);
  const size = 7;
  page.drawText(label, {
    x: x - font.widthOfTextAtSize(label, size) / 2,
    y: y - size / 2 + 0.7,
    size,
    font,
    color: rgb(1, 1, 1),
  });
}

export interface AnnotateOptions {
  /** Append the score summary sheet. On by default. */
  includeSummary?: boolean;
}

export async function buildAnnotatedPdf(
  originalBytes: Buffer | Uint8Array,
  result: GradeResult,
  annotations: Annotation[],
  options: AnnotateOptions = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(new Uint8Array(originalBytes));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = pdf.getPages();
  const columns = new Map<number, MarginColumn>();
  const placed: Annotation[] = [];
  const unplaced: Annotation[] = [];

  // Number the annotations in reading order so the badges and the summary agree.
  const ordered = [...annotations].sort((a, b) => {
    const ra = a.rects[0];
    const rb = b.rects[0];
    if (!ra && !rb) return 0;
    if (!ra) return 1;
    if (!rb) return -1;
    if (ra.page !== rb.page) return ra.page - rb.page;
    return rb.y - ra.y; // higher on the page first
  });

  let index = 0;
  for (const annotation of ordered) {
    const first = annotation.rects[0];
    const page = first ? pages[first.page] : undefined;
    if (!first || !page) {
      unplaced.push(annotation);
      continue;
    }

    index += 1;
    placed.push(annotation);
    const colour = COLOURS[annotation.type];
    const { width, height } = page.getSize();

    for (const rect of annotation.rects) {
      const target = pages[rect.page];
      if (!target) continue;
      target.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        borderColor: rgb(colour.r, colour.g, colour.b),
        borderWidth: 1.1,
        color: rgb(colour.r, colour.g, colour.b),
        opacity: 0.06,
        borderOpacity: 0.95,
      });
    }

    // Keep the badge on the page even when the quote starts hard against the edge.
    drawBadge(
      page,
      bold,
      Math.min(Math.max(first.x - 2, 9), width - 9),
      Math.min(first.y + first.h + 2, height - 9),
      index,
      colour,
    );

    // The margin note.
    const heading = `${index}. ${LABELS[annotation.type]}`;
    const body = annotation.correction
      ? `${annotation.comment}\nCorrection: ${annotation.correction}`
      : annotation.comment;
    const lines = wrap(body, font, NOTE_FONT_SIZE, NOTE_WIDTH - 10);
    const boxHeight = NOTE_LINE_HEIGHT * (lines.length + 1) + 8;

    if (!columns.has(first.page)) columns.set(first.page, new MarginColumn(height));
    const column = columns.get(first.page)!;
    const noteX = Math.max(width - NOTE_WIDTH - 8, width * 0.55);
    const top = column.place(first.y + first.h + 4, boxHeight);

    page.drawRectangle({
      x: noteX,
      y: top - boxHeight,
      width: NOTE_WIDTH,
      height: boxHeight,
      color: rgb(1, 1, 1),
      opacity: 0.92,
      borderColor: rgb(colour.r, colour.g, colour.b),
      borderWidth: 0.7,
    });

    // Leader line from the annotated text to its note.
    page.drawLine({
      start: { x: first.x + first.w, y: first.y + first.h / 2 },
      end: { x: noteX, y: top - 8 },
      thickness: 0.4,
      color: rgb(colour.r, colour.g, colour.b),
      opacity: 0.55,
    });

    page.drawText(heading, {
      x: noteX + 5,
      y: top - NOTE_LINE_HEIGHT,
      size: NOTE_FONT_SIZE,
      font: bold,
      color: rgb(colour.r, colour.g, colour.b),
    });
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: noteX + 5,
        y: top - NOTE_LINE_HEIGHT * (i + 2),
        size: NOTE_FONT_SIZE,
        font,
        color: rgb(0.15, 0.15, 0.15),
      });
    });
  }

  if (options.includeSummary !== false) {
    drawSummary(pdf, font, bold, result, placed, unplaced);
  }

  return pdf.save();
}

function drawSummary(
  pdf: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  result: GradeResult,
  placed: Annotation[],
  unplaced: Annotation[],
): void {
  const size = { w: 595.28, h: 841.89 }; // A4
  let page = pdf.addPage([size.w, size.h]);
  let y = size.h - 50;
  const left = 45;
  const right = size.w - 45;

  const newPageIfNeeded = (needed: number) => {
    if (y - needed < 50) {
      page = pdf.addPage([size.w, size.h]);
      y = size.h - 50;
    }
  };

  const line = (
    text: string,
    opts: { font?: PDFFont; size?: number; colour?: [number, number, number]; indent?: number } = {},
  ) => {
    const fs = opts.size ?? 9;
    const f = opts.font ?? font;
    const [r, g, b] = opts.colour ?? [0.15, 0.15, 0.15];
    for (const wrapped of wrap(text, f, fs, right - left - (opts.indent ?? 0))) {
      newPageIfNeeded(fs + 4);
      page.drawText(wrapped, {
        x: left + (opts.indent ?? 0),
        y,
        size: fs,
        font: f,
        color: rgb(r, g, b),
      });
      y -= fs + 3;
    }
  };

  page.drawText("Marking summary", { x: left, y, size: 18, font: bold, color: rgb(0.1, 0.2, 0.35) });
  y -= 26;

  page.drawText(`${result.totalMarks} / ${result.maxMarks}`, {
    x: left,
    y,
    size: 24,
    font: bold,
    color: rgb(0.1, 0.2, 0.35),
  });
  page.drawText(
    `Confidence ${(result.confidence * 100).toFixed(0)}%   ${
      result.needsHumanReview ? "NEEDS TEACHER REVIEW" : "No review flags"
    }`,
    { x: left + 90, y: y + 4, size: 9, font: bold, color: result.needsHumanReview ? rgb(0.8, 0.35, 0) : rgb(0.11, 0.5, 0.3) },
  );
  y -= 18;
  line(
    `Graded by ${result.grader.provider} (${result.grader.model})${
      result.grader.degraded ? " - degraded mode" : ""
    } on ${new Date(result.createdAt).toLocaleString()}`,
    { size: 8, colour: [0.45, 0.45, 0.45] },
  );
  y -= 8;

  for (const question of result.questions) {
    newPageIfNeeded(60);
    line(`${question.title}  -  ${question.awardedMarks} / ${question.maxMarks}`, {
      font: bold,
      size: 11,
      colour: [0.1, 0.2, 0.35],
    });
    for (const criterion of question.criteria) {
      const mark = `${criterion.awardedMarks}/${criterion.maxMarks}`;
      line(`[${mark}] ${criterion.criterion}`, { size: 8.5, indent: 6 });
      line(criterion.feedback, { size: 8, indent: 18, colour: [0.35, 0.35, 0.35] });
      if (criterion.evidence) {
        line(`Evidence: "${criterion.evidence}"`, {
          size: 7.5,
          indent: 18,
          colour: [0.3, 0.4, 0.6],
        });
      }
      y -= 2;
    }
    y -= 8;
  }

  if (result.flags.length > 0) {
    newPageIfNeeded(40);
    line("Review flags", { font: bold, size: 11, colour: [0.8, 0.35, 0] });
    for (const flag of result.flags) {
      line(`- ${flag.message}`, { size: 8, indent: 6, colour: [0.4, 0.3, 0.2] });
    }
    y -= 8;
  }

  if (placed.length > 0) {
    newPageIfNeeded(40);
    line("Annotations on the paper", { font: bold, size: 11, colour: [0.1, 0.2, 0.35] });
    placed.forEach((a, i) => {
      line(`${i + 1}. [${LABELS[a.type]}] ${a.comment}`, { size: 8, indent: 6 });
      if (a.correction) {
        line(`Correction: ${a.correction}`, { size: 8, indent: 18, colour: [0.11, 0.5, 0.3] });
      }
    });
    y -= 8;
  }

  if (unplaced.length > 0) {
    newPageIfNeeded(40);
    line("Notes that could not be placed on the page", {
      font: bold,
      size: 11,
      colour: [0.8, 0.35, 0],
    });
    line(
      "These relate to points the student did not write, or to quotes that could not be located in the paper.",
      { size: 8, colour: [0.45, 0.45, 0.45] },
    );
    for (const a of unplaced) {
      line(`- [${LABELS[a.type]}] ${a.comment}`, { size: 8, indent: 6 });
      if (a.correction) {
        line(`Correction: ${a.correction}`, { size: 8, indent: 18, colour: [0.11, 0.5, 0.3] });
      }
    }
  }

  newPageIfNeeded(30);
  y -= 6;
  line("Overall", { font: bold, size: 11, colour: [0.1, 0.2, 0.35] });
  line(result.overallFeedback, { size: 8.5 });
}
