import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { gradeAnswer } from "../src/services/grading/grader.js";
import { MockGrader } from "../src/services/llm/mock.js";
import { buildAnnotatedPdf } from "../src/services/pdf/annotatePdf.js";
import { extractPdf } from "../src/services/pdf/extractText.js";
import { extractFixture, readFixture, rubric } from "./helpers.js";

async function gradedExample() {
  const [answerDoc, answerPdf, spec] = await Promise.all([
    extractFixture("student-answer.pdf"),
    readFixture("student-answer.pdf"),
    rubric(),
  ]);
  const record = await gradeAnswer({
    rubric: spec,
    answerDoc,
    answerPdf,
    answerFilename: "student-answer.pdf",
    documents: { answerId: "test" },
    provider: new MockGrader(),
  });
  return { ...record, answerPdf, answerDoc };
}

describe("annotated PDF export", () => {
  it("draws every located annotation inside the bounds of its page", async () => {
    const { annotations, answerDoc } = await gradedExample();
    const placed = annotations.filter((a) => a.anchored);
    expect(placed.length).toBeGreaterThan(5);

    for (const annotation of placed) {
      for (const rect of annotation.rects) {
        const page = answerDoc.pages[rect.page];
        expect(page, `annotation on page ${rect.page} which does not exist`).toBeDefined();
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(page!.width + 1);
        expect(rect.y + rect.h).toBeLessThanOrEqual(page!.height + 1);
        expect(rect.w).toBeGreaterThan(0);
        expect(rect.h).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the student's pages and appends a summary", async () => {
    const { result, annotations, answerPdf } = await gradedExample();
    const original = await PDFDocument.load(new Uint8Array(answerPdf));

    const annotated = await buildAnnotatedPdf(answerPdf, result, annotations);
    const output = await PDFDocument.load(annotated);

    expect(output.getPageCount()).toBeGreaterThan(original.getPageCount());
    // Original page geometry is preserved, so the marking sits over the real text.
    expect(output.getPage(0).getSize()).toEqual(original.getPage(0).getSize());
  });

  it("writes the marks, the evidence and the corrections into the summary", async () => {
    const { result, annotations, answerPdf } = await gradedExample();
    const annotated = await buildAnnotatedPdf(answerPdf, result, annotations);

    const text = (await extractPdf(annotated)).text.replace(/\s+/g, " ");

    expect(text).toContain("Marking summary");
    expect(text).toContain("6 / 15");
    expect(text).toContain("Q1 - Science");
    expect(text).toContain("Q3 - Economics");
    expect(text).toContain("NEEDS TEACHER REVIEW");
    // A correction the student can act on, not just a mark.
    expect(text).toMatch(/voltmeter must be connected in parallel/i);
    // Points that could not be boxed are still reported, not dropped.
    expect(text).toContain("Notes that could not be placed");
  });

  it("can export without the summary sheet", async () => {
    const { result, annotations, answerPdf } = await gradedExample();
    const original = await PDFDocument.load(new Uint8Array(answerPdf));
    const annotated = await buildAnnotatedPdf(answerPdf, result, annotations, {
      includeSummary: false,
    });
    const output = await PDFDocument.load(annotated);
    expect(output.getPageCount()).toBe(original.getPageCount());
  });

  it("never modifies the bytes it was given", async () => {
    const { result, annotations, answerPdf } = await gradedExample();
    const copy = Buffer.from(answerPdf);
    await buildAnnotatedPdf(answerPdf, result, annotations);
    expect(Buffer.compare(answerPdf, copy)).toBe(0);
  });

  it("exports a paper that has no annotations at all", async () => {
    const { result, answerPdf } = await gradedExample();
    const annotated = await buildAnnotatedPdf(answerPdf, result, []);
    expect(Buffer.from(annotated).subarray(0, 4).toString()).toBe("%PDF");
  });
});
