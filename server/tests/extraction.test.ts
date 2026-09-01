import { describe, expect, it } from "vitest";
import { extractFixture } from "./helpers.js";
import { anchorQuote } from "../src/services/grading/anchor.js";

describe("PDF text extraction", () => {
  it("extracts text with a bounding box for every run", async () => {
    const doc = await extractFixture("student-answer.pdf");

    expect(doc.pages.length).toBe(2);
    expect(doc.charCount).toBeGreaterThan(2000);
    expect(doc.isBlank).toBe(false);
    expect(doc.tokens.length).toBeGreaterThan(10);

    for (const token of doc.tokens) {
      expect(token.w).toBeGreaterThan(0);
      expect(token.h).toBeGreaterThan(0);
      expect(token.page).toBeGreaterThanOrEqual(0);
      // Offsets must index back into the flat document text, or annotations cannot
      // be placed at all.
      expect(doc.text.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it("reports a paper with no text as blank rather than as an empty answer", async () => {
    const doc = await extractFixture("cases/answer-blank.pdf");
    expect(doc.isBlank).toBe(true);
    expect(doc.charCount).toBe(0);
    expect(doc.tokens).toHaveLength(0);
  });

  it("rejects a file that is not a PDF", async () => {
    await expect(
      (await import("../src/services/pdf/extractText.js")).extractPdf(
        Buffer.from("this is not a pdf"),
      ),
    ).rejects.toThrow();
  });
});

describe("quote anchoring", () => {
  it("locates an exact quote and returns rectangles on the right page", async () => {
    const doc = await extractFixture("student-answer.pdf");
    const anchor = anchorQuote(doc, "The voltmeter is also connected in series with the bulb");

    expect(anchor.anchored).toBe(true);
    expect(anchor.score).toBe(1);
    expect(anchor.rects.length).toBeGreaterThan(0);
    expect(anchor.rects[0]!.page).toBe(0);
    expect(anchor.rects[0]!.w).toBeGreaterThan(0);
  });

  it("still locates a quote whose line breaks were collapsed", async () => {
    const doc = await extractFixture("student-answer.pdf");
    // A quote copied by the model arrives as one line; in the PDF it wraps.
    const anchor = anchorQuote(
      doc,
      "there is a shortage in the market and the price starts rising",
    );
    expect(anchor.anchored).toBe(true);
    expect(anchor.rects.length).toBeGreaterThan(0);
  });

  it("tolerates a quote the model silently re-spelled", async () => {
    const doc = await extractFixture("student-answer.pdf");
    // The paper says "circut"; the model quotes it as "circuit".
    const anchor = anchorQuote(doc, "In my circuit the battery, switch, resistor, bulb");
    expect(anchor.anchored).toBe(true);
    expect(anchor.score).toBeGreaterThan(0.8);
    expect(anchor.score).toBeLessThan(1);
  });

  it("reports failure instead of guessing when the quote is not in the paper", async () => {
    const doc = await extractFixture("student-answer.pdf");
    const anchor = anchorQuote(
      doc,
      "Photosynthesis converts light energy into chemical energy in the chloroplast",
    );
    expect(anchor.anchored).toBe(false);
    expect(anchor.rects).toHaveLength(0);
  });

  it("returns nothing for an empty quote rather than anchoring at position zero", async () => {
    const doc = await extractFixture("student-answer.pdf");
    expect(anchorQuote(doc, "").anchored).toBe(false);
    expect(anchorQuote(doc, "  ").anchored).toBe(false);
  });
});
