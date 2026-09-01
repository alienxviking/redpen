import { createRequire } from "node:module";
import type {
  ExtractedDocument,
  ExtractedPage,
  PositionedToken,
} from "../../domain/types.js";

/**
 * Positioned text extraction.
 *
 * The whole annotation feature rests on this: we need not just *what* the student
 * wrote but *where each run of characters sits on the page*, so that an evidence
 * quote coming back from the grader can be turned into real rectangles.
 *
 * We therefore keep, for every text run pdf.js reports, its bounding box in PDF
 * user space (origin bottom-left) alongside the offsets of that run inside the
 * flat document text we send to the model. Those offsets are the join key.
 */

const require = createRequire(import.meta.url);

/** Minimal shape of the bits of pdf.js we use, so we don't fight its types. */
interface PdfTextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  hasEOL?: boolean;
}

type PdfjsModule = {
  getDocument: (params: Record<string, unknown>) => { promise: Promise<PdfDoc> };
};
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // The legacy build is the one that runs under plain Node without a DOM.
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfjsModule>;
  }
  return pdfjsPromise;
}

function standardFontDataUrl(): string {
  const entry = require.resolve("pdfjs-dist/package.json");
  return entry.replace(/package\.json$/, "standard_fonts/");
}

/** pdf.js gives a baseline origin; turn it into a box with a little descender room. */
function tokenBox(item: PdfTextItem): { x: number; y: number; w: number; h: number } {
  const t = item.transform;
  const x = t[4] ?? 0;
  const baseline = t[5] ?? 0;
  const h = Math.abs(item.height) || Math.abs(t[3] ?? 10) || 10;
  const descender = h * 0.25;
  return { x, y: baseline - descender, w: Math.abs(item.width), h: h + descender };
}

function isTextItem(v: unknown): v is PdfTextItem {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PdfTextItem).str === "string" &&
    Array.isArray((v as PdfTextItem).transform)
  );
}

export async function extractPdf(data: Uint8Array | Buffer): Promise<ExtractedDocument> {
  const pdfjs = await loadPdfjs();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  const doc = await pdfjs.getDocument({
    // pdf.js can detach the buffer it is handed, so give it a private copy.
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    standardFontDataUrl: standardFontDataUrl(),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const pages: ExtractedPage[] = [];
  const tokens: PositionedToken[] = [];
  let full = "";

  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const pageStart = full.length;
      let pageText = "";
      let prevBottom: number | null = null;

      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        const str = raw.str;
        const box = tokenBox(raw);

        // pdf.js emits runs, not lines. Insert a newline when the baseline moves to a
        // new line, and a space when two runs on the same line are visually separated.
        if (pageText.length > 0) {
          const movedLine = prevBottom !== null && Math.abs(prevBottom - box.y) > box.h * 0.6;
          if (movedLine) {
            pageText += "\n";
          } else if (!/\s$/.test(pageText) && !/^\s/.test(str) && str.length > 0) {
            pageText += " ";
          }
        }

        if (str.length > 0) {
          const start = pageStart + pageText.length;
          pageText += str;
          tokens.push({
            text: str,
            page: p - 1,
            ...box,
            start,
            end: pageStart + pageText.length,
          });
        }
        if (raw.hasEOL) {
          pageText += "\n";
        }
        prevBottom = box.y;
      }

      full += pageText;
      pages.push({
        page: p - 1,
        width: viewport.width,
        height: viewport.height,
        text: pageText,
        start: pageStart,
        end: full.length,
      });

      if (p < doc.numPages) full += "\f";
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }

  const charCount = full.replace(/\s/g, "").length;

  return {
    text: full,
    pages,
    tokens,
    charCount,
    // A scanned/handwritten paper extracts to nothing; callers treat that as blank
    // and route it to human review rather than pretending to have graded it.
    isBlank: charCount === 0,
  };
}

/** The tokens whose character range overlaps [start, end). */
export function tokensInRange(
  doc: ExtractedDocument,
  start: number,
  end: number,
): PositionedToken[] {
  return doc.tokens.filter((t) => t.end > start && t.start < end);
}
