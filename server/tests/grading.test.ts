import { describe, expect, it } from "vitest";
import { assertInvariants, gradeAnswer } from "../src/services/grading/grader.js";
import { MockGrader } from "../src/services/llm/mock.js";
import type { GraderProvider } from "../src/services/llm/provider.js";
import {
  buildModelGrade,
  extractFixture,
  failingProvider,
  hasRubric,
  readFixture,
  rubric,
  stubProvider,
} from "./helpers.js";

/**
 * The scenarios the assignment asks for, end to end through the grading pipeline.
 * The offline grader stands in for the model so the numbers are deterministic and the
 * suite runs without a network call or an API key.
 */

async function grade(fixtureName: string, provider: GraderProvider = new MockGrader()) {
  const [answerDoc, answerPdf, spec] = await Promise.all([
    extractFixture(fixtureName),
    readFixture(fixtureName),
    rubric(),
  ]);
  return gradeAnswer({
    rubric: spec,
    answerDoc,
    answerPdf,
    answerFilename: fixtureName,
    documents: { answerId: "test" },
    provider,
  });
}

describe.skipIf(!hasRubric)("grading scenarios", () => {
  it("a fully correct answer scores full marks", async () => {
    const { result } = await grade("cases/answer-correct.pdf");

    expect(result.totalMarks).toBe(15);
    expect(result.maxMarks).toBe(15);
    expect(result.questions.every((q) => q.awardedMarks === q.maxMarks)).toBe(true);
    assertInvariants(result);
  });

  it("a partially correct answer scores the planted 6 of 15", async () => {
    const { result, annotations } = await grade("student-answer.pdf");

    // These are the marks the error key says the paper should earn.
    expect(result.totalMarks).toBe(6);
    expect(result.questions.map((q) => q.awardedMarks)).toEqual([2, 3, 1]);

    // The two substantive errors must be pointed at, on the page.
    const errors = annotations.filter((a) => a.type === "error" && a.anchored);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((a) => /voltmeter/i.test(a.quote))).toBe(true);
    expect(errors.every((a) => a.rects.length > 0)).toBe(true);
    assertInvariants(result);
  });

  it("an incorrect answer scores near zero and every error is evidenced", async () => {
    const { result, annotations } = await grade("cases/answer-incorrect.pdf");

    expect(result.totalMarks).toBeLessThanOrEqual(3);
    expect(result.needsHumanReview).toBe(true);
    for (const annotation of annotations.filter((a) => a.type === "error")) {
      expect(annotation.quote.length).toBeGreaterThan(0);
      expect(annotation.comment.length).toBeGreaterThan(0);
    }
    assertInvariants(result);
  });

  it("a blank answer scores zero, is flagged, and never reaches the model", async () => {
    let called = false;
    const watcher = {
      name: "anthropic" as const,
      model: "stub-model",
      async grade() {
        called = true;
        throw new Error("the model must not be called for a blank paper");
      },
    };

    const { result, annotations } = await grade("cases/answer-blank.pdf", watcher);

    expect(called).toBe(false);
    expect(result.totalMarks).toBe(0);
    expect(result.needsHumanReview).toBe(true);
    expect(result.flags.some((f) => f.code === "blank_answer")).toBe(true);
    expect(annotations).toHaveLength(0);
    // A blank page is not silently a zero: the flag explains it may need OCR.
    expect(result.flags[0]!.message).toMatch(/OCR|handwritten|manual/i);
  });

  it("OCR-style spelling errors cost no marks but are surfaced as annotations", async () => {
    const clean = await grade("cases/answer-correct.pdf");
    const damaged = await grade("cases/answer-ocr-errors.pdf");

    // Same answer, broken spelling. The marks must not move.
    expect(damaged.result.totalMarks).toBe(clean.result.totalMarks);

    const spelling = damaged.annotations.filter((a) => a.type === "spelling");
    expect(spelling.length).toBeGreaterThanOrEqual(5);
    expect(spelling.every((a) => a.anchored && a.rects.length > 0)).toBe(true);
    expect(spelling.some((a) => a.correction === "circuit")).toBe(true);
  });

  it("malformed model output is repaired on a second attempt", async () => {
    const spec = await rubric();
    const good = buildModelGrade(spec, (_id, max) => max);
    const provider = stubProvider(
      { raw: "Sure! The student did well overall. Marks: about 12 out of 15." },
      { repairWith: { raw: JSON.stringify(good) } },
    );

    const { result } = await grade("student-answer.pdf", provider);

    expect(result.totalMarks).toBe(15);
    expect(result.grader.degraded).toBe(false);
    expect(result.flags.some((f) => f.code === "model_output_repaired")).toBe(true);
    expect(result.warnings.some((w) => w.includes("repair"))).toBe(true);
    assertInvariants(result);
  });

  it("output that stays malformed falls back to the offline grader", async () => {
    const provider = stubProvider({ raw: "still not json" }, { repairWith: { raw: "nope" } });

    const { result } = await grade("student-answer.pdf", provider);

    expect(result.grader.provider).toBe("mock");
    expect(result.grader.degraded).toBe(true);
    expect(result.needsHumanReview).toBe(true);
    expect(result.flags.some((f) => f.code === "model_output_repaired")).toBe(true);
    // It still produced a usable, invariant-respecting grade.
    expect(result.totalMarks).toBe(6);
    assertInvariants(result);
  });

  it("an API failure degrades to the offline grader and says so", async () => {
    const { result } = await grade("student-answer.pdf", failingProvider("server"));

    expect(result.grader.provider).toBe("mock");
    expect(result.grader.degraded).toBe(true);
    expect(result.needsHumanReview).toBe(true);

    const flag = result.flags.find((f) => f.code === "model_unavailable");
    expect(flag).toBeDefined();
    expect(flag!.message).toContain("503");
    expect(result.totalMarks).toBe(6);
    assertInvariants(result);
  });

  it("marks above the maximum are corrected rather than reported", async () => {
    const spec = await rubric();
    // A model that awards 5 marks for every 1-mark rubric point: 75 out of 15.
    const overAward = buildModelGrade(spec, () => 5);
    const provider = stubProvider({ raw: JSON.stringify(overAward) });

    const { result } = await grade("student-answer.pdf", provider);

    expect(result.totalMarks).toBe(15);
    expect(result.totalMarks).toBeLessThanOrEqual(result.maxMarks);
    for (const question of result.questions) {
      expect(question.awardedMarks).toBeLessThanOrEqual(question.maxMarks);
      for (const criterion of question.criteria) {
        expect(criterion.awardedMarks).toBeLessThanOrEqual(criterion.maxMarks);
      }
    }
    expect(result.flags.some((f) => f.code === "marks_clamped")).toBe(true);
    assertInvariants(result);
  });

  it("marks the paper on reasoning, not on agreeing with the model answer", async () => {
    // Q2's rubric guidance is explicit that the opposite conclusion can score 5/5.
    const spec = await rubric();
    const q2 = spec.questions.find((q) => q.id === "q2")!;
    expect(q2.guidance).toMatch(/quality of reasoning/i);
    expect(q2.guidance).toMatch(/does NOT have to reach the same conclusion/i);
  });
});

describe.skipIf(!hasRubric)("invariants", () => {
  it("rejects a result whose total does not match its parts", async () => {
    const { result } = await grade("student-answer.pdf");
    const tampered = { ...result, totalMarks: result.totalMarks + 1 };
    expect(() => assertInvariants(tampered)).toThrow(/total/i);
  });

  it("rejects a result that awards more than the paper is worth", async () => {
    const { result } = await grade("student-answer.pdf");
    const tampered = structuredClone(result);
    tampered.questions[0]!.criteria[0]!.awardedMarks = 99;
    expect(() => assertInvariants(tampered)).toThrow();
  });
});
