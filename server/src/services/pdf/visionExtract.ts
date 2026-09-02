import { config } from "../../config.js";
import type {
  ExtractedDocument,
  ExtractedPage,
  PositionedToken,
} from "../../domain/types.js";
import {
  RETRYABLE_STATUSES,
  RetryableHttpError,
  retryAfterSeconds,
  withRetry,
} from "../llm/retry.js";

/**
 * Reading a handwritten or scanned answer paper.
 *
 * A photographed or handwritten script has no text layer, so `extractPdf` finds nothing
 * and the pipeline would refuse to mark it. This module fills that gap by transcribing
 * the page image with a vision model that returns, for each line it reads, a bounding
 * box on the page.
 *
 * The point of returning boxes rather than just text is that it produces exactly the
 * same `ExtractedDocument` the text-layer path produces - text, per-page geometry, and
 * `PositionedToken[]` with offsets into that text. Everything downstream (quote
 * anchoring, on-page rectangles, the annotated export, the invariants) is unchanged and
 * unaware of where the words came from. That was the promise the token abstraction was
 * built on; this is it being cashed.
 *
 * Two honesty rules:
 *   - a transcription is evidence about the page, not the page. `source: "vision"`
 *     travels with the document so the grade can flag that its quotes came from OCR.
 *   - if transcription fails or comes back unusable, this returns null. The caller then
 *     keeps the blank result and asks for a human, rather than marking invented text.
 */

/** One line as the vision model read it. `box_2d` is [ymin, xmin, ymax, xmax], 0-1000. */
export interface VisionLine {
  text: string;
  box_2d: [number, number, number, number];
}

export interface VisionPage {
  /** 1-indexed, as the model is asked to report it. */
  page: number;
  lines: VisionLine[];
}

/** Injectable so the geometry can be tested without a network call. */
export interface VisionTranscriber {
  readonly model: string;
  transcribe(base64: string, mimeType: string): Promise<VisionPage[]>;
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

const PROMPT = `You are transcribing a scanned or handwritten exam answer paper so that it can be marked.

For EVERY page, read every line of the student's writing in order, top to bottom.

Return JSON only, in exactly this shape:
{"pages":[{"page":1,"lines":[{"text":"<one line exactly as written>","box_2d":[ymin,xmin,ymax,xmax]}]}]}

Rules that matter:
- Transcribe what is actually written, including spelling mistakes. Do NOT correct spelling, grammar or facts. A misspelling is evidence a marker needs to see.
- One entry per visual line of writing. Keep the reading order.
- box_2d is that line's bounding box as [ymin, xmin, ymax, xmax], each normalised to 0-1000 relative to the page, with y measured downwards from the top of the page. Be precise: these boxes are drawn back onto the page.
- Include headings and question numbers as their own lines.
- If the page contains a diagram or a graph, do not try to transcribe its shape. Instead emit one line per visible text label, positioned on that label, so the labels can still be marked.
- If a line is genuinely illegible, transcribe your best reading of it and keep the box. Do not invent content that is not on the page.
- Ignore printed page furniture such as pre-printed ruling or margin lines.`;

/** Transcribes with Gemini, which accepts a PDF or an image directly. */
export class GeminiTranscriber implements VisionTranscriber {
  readonly model: string;

  /** The model that actually produced the last transcription. */
  usedModel: string;

  constructor(
    private readonly apiKey: string,
    model = config.visionModel,
    private readonly fallbacks: string[] = config.visionFallbackModels,
  ) {
    this.model = model;
    this.usedModel = model;
  }

  /**
   * Try each model in turn, retrying transient failures within each.
   *
   * The free tier's 503s are per-model, not per-account: while one model is saturated
   * another usually answers immediately. Retrying one model harder does not help, so
   * this walks a short list instead.
   */
  async transcribe(base64: string, mimeType: string): Promise<VisionPage[]> {
    const models = [...new Set([this.model, ...this.fallbacks])];
    let lastError: unknown;

    for (const model of models) {
      try {
        const pages = await withRetry(() => this.attempt(base64, mimeType, model), {
          attempts: 2,
          baseDelayMs: 2000,
          onRetry: ({ delayMs, reason }) =>
            console.warn(
              `[gradesense] ${model} transcription failed (${reason}); retrying in ${Math.round(delayMs / 100) / 10}s`,
            ),
        });
        this.usedModel = model;
        if (model !== this.model) {
          console.warn(`[gradesense] transcribed with fallback model ${model}`);
        }
        return pages;
      } catch (error) {
        lastError = error;
        console.warn(
          `[gradesense] giving up on ${model}: ${error instanceof Error ? error.message.slice(0, 120) : error}`,
        );
      }
    }
    throw lastError ?? new Error("No vision model was reachable.");
  }

  private async attempt(
    base64: string,
    mimeType: string,
    model: string,
  ): Promise<VisionPage[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.visionTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mimeType, data: base64 } },
                { text: PROMPT },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            maxOutputTokens: config.maxTokens,
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = ((await response.json()) as { error?: { message?: string } }).error
          ?.message ?? "";
      } catch {
        // Status alone will have to do.
      }
      const message = `Vision transcription failed (${response.status}) ${detail}`.trim();
      if (RETRYABLE_STATUSES.has(response.status)) {
        throw new RetryableHttpError(message, response.status, retryAfterSeconds(response));
      }
      throw new Error(message);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
      throw new Error(`Vision transcription was declined (${candidate.finishReason})`);
    }

    const raw = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    return parseVisionPages(raw);
  }
}

/** Pull out the first balanced {...} block, ignoring braces inside strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Truncated at the token ceiling: salvage what closed cleanly.
  return null;
}

/**
 * Tolerantly read the model's reply. Same posture as the grading parser: accept bare
 * JSON, a fenced block, or JSON with prose around it, and accept a bare `lines` array
 * as a single page - smaller models drop the `pages` wrapper surprisingly often.
 */
export function parseVisionPages(raw: string): VisionPage[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  const candidates = [
    text,
    /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1],
    firstJsonObject(text),
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  for (const attempt of candidates) {
    try {
      const parsed = JSON.parse(attempt) as { pages?: unknown; lines?: unknown };
      const pages = Array.isArray(parsed.pages)
        ? parsed.pages
        : // A bare {"lines": [...]} is a single page.
          Array.isArray(parsed.lines)
          ? [{ page: 1, lines: parsed.lines }]
          : [];
      const clean: VisionPage[] = [];
      for (const page of pages) {
        const p = page as { page?: unknown; lines?: unknown };
        const lines = Array.isArray(p.lines) ? p.lines : [];
        const kept: VisionLine[] = [];
        for (const line of lines) {
          const l = line as { text?: unknown; box_2d?: unknown };
          if (typeof l.text !== "string" || !l.text.trim()) continue;
          const box = normaliseBox(l.box_2d);
          if (!box) continue;
          kept.push({ text: l.text, box_2d: box });
        }
        clean.push({ page: Number(p.page) || clean.length + 1, lines: kept });
      }
      if (clean.some((p) => p.lines.length > 0)) return clean;
    } catch {
      // Try the next shape.
    }
  }

  // Nothing parsed cleanly. Most often that means the reply was truncated at the token
  // ceiling, which on a dense page is likely rather than exotic - so recover the lines
  // that did arrive instead of throwing away a whole page of transcription.
  const salvaged = salvageLines(text);
  if (salvaged.some((p) => p.lines.length > 0)) {
    const count = salvaged.reduce((n, p) => n + p.lines.length, 0);
    console.warn(
      `[gradesense] transcription JSON was malformed or truncated; salvaged ${count} lines`,
    );
    return salvaged;
  }

  console.warn(
    `[gradesense] could not read a transcription out of ${text.length} chars: ${text.slice(0, 180)}`,
  );
  return [];
}

/**
 * Accept the shapes a box actually arrives in. Smaller models sometimes wrap it in an
 * extra array - `[[y, x, y, x]]` - and sometimes send the numbers as strings.
 */
function normaliseBox(value: unknown): [number, number, number, number] | null {
  let box: unknown = value;
  while (Array.isArray(box) && box.length === 1 && Array.isArray(box[0])) box = box[0];
  if (!Array.isArray(box) || box.length !== 4) return null;
  const nums = box.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/**
 * Last resort for malformed or truncated JSON: scrape the text/box pairs directly,
 * attributing each to the most recent `"page": N` marker before it.
 */
function salvageLines(text: string): VisionPage[] {
  const markers = [...text.matchAll(/"page"\s*:\s*(\d+)/g)].map((m) => ({
    at: m.index ?? 0,
    page: Number(m[1]),
  }));
  const lineRe =
    /"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"box_2d"\s*:\s*(\[[^[\]]*\]|\[\s*\[[^[\]]*\]\s*\])/g;

  const byPage = new Map<number, VisionLine[]>();
  for (const match of text.matchAll(lineRe)) {
    const at = match.index ?? 0;
    let page = 1;
    for (const marker of markers) {
      if (marker.at < at) page = marker.page;
      else break;
    }
    let value: string;
    let box: [number, number, number, number] | null;
    try {
      value = JSON.parse(`"${match[1]}"`) as string;
      box = normaliseBox(JSON.parse(match[2]!));
    } catch {
      continue;
    }
    if (!box || !value.trim()) continue;
    byPage.set(page, [...(byPage.get(page) ?? []), { text: value, box_2d: box }]);
  }

  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, lines]) => ({ page, lines }));
}

/**
 * Convert normalised line boxes into an ExtractedDocument.
 *
 * `pageSizes` comes from pdf.js, which reports page geometry even for a PDF with no
 * text layer - so the boxes land in real PDF points rather than guessed ones.
 */
export function documentFromVision(
  visionPages: VisionPage[],
  pageSizes: Array<{ width: number; height: number }>,
): ExtractedDocument | null {
  if (pageSizes.length === 0) return null;

  const byIndex = new Map<number, VisionLine[]>();
  for (const page of visionPages) {
    const index = Math.max(0, Math.round(page.page) - 1);
    byIndex.set(index, [...(byIndex.get(index) ?? []), ...page.lines]);
  }

  const pages: ExtractedPage[] = [];
  const tokens: PositionedToken[] = [];
  let full = "";

  pageSizes.forEach((size, index) => {
    const pageStart = full.length;
    let pageText = "";

    // Top-to-bottom, then left-to-right: the order a marker reads in.
    const lines = [...(byIndex.get(index) ?? [])].sort(
      (a, b) => a.box_2d[0] - b.box_2d[0] || a.box_2d[1] - b.box_2d[1],
    );

    for (const line of lines) {
      const [ymin, xmin, ymax, xmax] = line.box_2d;
      const x0 = clamp((Math.min(xmin, xmax) / 1000) * size.width, 0, size.width);
      const x1 = clamp((Math.max(xmin, xmax) / 1000) * size.width, 0, size.width);
      // The model measures y downwards from the top; PDF space measures it upwards.
      const top = clamp((Math.min(ymin, ymax) / 1000) * size.height, 0, size.height);
      const bottom = clamp((Math.max(ymin, ymax) / 1000) * size.height, 0, size.height);

      const start = pageStart + pageText.length;
      pageText += line.text;
      tokens.push({
        text: line.text,
        page: index,
        x: x0,
        y: size.height - bottom,
        w: Math.max(x1 - x0, 2),
        h: Math.max(bottom - top, 6),
        start,
        end: pageStart + pageText.length,
      });
      pageText += "\n";
    }

    full += pageText;
    pages.push({
      page: index,
      width: size.width,
      height: size.height,
      text: pageText,
      start: pageStart,
      end: full.length,
    });
    if (index < pageSizes.length - 1) full += "\f";
  });

  const charCount = full.replace(/\s/g, "").length;
  if (charCount === 0) return null;

  return { text: full, pages, tokens, charCount, isBlank: false, source: "vision" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The transcriber to use, or null when no vision-capable key is configured. */
export function defaultTranscriber(): VisionTranscriber | null {
  return config.geminiApiKey ? new GeminiTranscriber(config.geminiApiKey) : null;
}

export interface VisionExtractOutcome {
  document: ExtractedDocument | null;
  /** Why it did not work, for the upload response and the review flag. */
  problem?: string;
  model?: string;
}

/**
 * Try to read a paper that has no text layer. Never throws: a failure here means
 * "a human needs to look at this", which the caller expresses as a flag.
 */
export async function visionExtract(
  bytes: Buffer,
  pageSizes: Array<{ width: number; height: number }>,
  mimeType = "application/pdf",
  transcriber: VisionTranscriber | null = defaultTranscriber(),
): Promise<VisionExtractOutcome> {
  if (!transcriber) {
    return {
      document: null,
      problem:
        "No vision-capable model is configured (set GEMINI_API_KEY), so a paper with no text layer cannot be read.",
    };
  }

  try {
    const visionPages = await transcriber.transcribe(bytes.toString("base64"), mimeType);
    if (visionPages.length === 0) {
      return {
        document: null,
        problem: "The vision model returned no usable transcription.",
        model: transcriber.model,
      };
    }
    const document = documentFromVision(visionPages, pageSizes);
    if (!document) {
      return {
        document: null,
        problem: "The transcription contained no readable text.",
        model: transcriber.model,
      };
    }
    const used = (transcriber as { usedModel?: string }).usedModel ?? transcriber.model;
    return { document, model: used };
  } catch (error) {
    return {
      document: null,
      problem: error instanceof Error ? error.message : "Vision transcription failed.",
      model: transcriber.model,
    };
  }
}
