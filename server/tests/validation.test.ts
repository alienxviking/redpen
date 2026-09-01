import { describe, expect, it } from "vitest";
import { parseModelOutput, reconcile } from "../src/services/grading/validate.js";
import { buildModelGrade, extractFixture, rubric } from "./helpers.js";

describe("parsing model output", () => {
  it("accepts a well-formed object that the SDK already parsed", async () => {
    const spec = await rubric();
    const grade = buildModelGrade(spec, (_id, max) => max);
    const outcome = parseModelOutput("", grade);
    expect(outcome.ok).toBe(true);
  });

  it("accepts bare JSON text", async () => {
    const spec = await rubric();
    const grade = buildModelGrade(spec, () => 0);
    expect(parseModelOutput(JSON.stringify(grade), null).ok).toBe(true);
  });

  it("accepts JSON wrapped in a markdown fence", async () => {
    const spec = await rubric();
    const grade = buildModelGrade(spec, () => 0);
    const raw = "Here is the grading:\n```json\n" + JSON.stringify(grade) + "\n```\nHope that helps.";
    expect(parseModelOutput(raw, null).ok).toBe(true);
  });

  it("accepts JSON buried in prose with braces inside strings", async () => {
    const spec = await rubric();
    const grade = buildModelGrade(spec, () => 0);
    grade.overallFeedback = 'The student wrote "{not json}" here.';
    const raw = `Certainly. ${JSON.stringify(grade)} Let me know if you need more.`;
    const outcome = parseModelOutput(raw, null);
    expect(outcome.ok).toBe(true);
    expect(outcome.data?.overallFeedback).toContain("{not json}");
  });

  it("reports a problem for output that is not JSON at all", () => {
    const outcome = parseModelOutput("I am unable to grade this paper.", null);
    expect(outcome.ok).toBe(false);
    expect(outcome.problem).toBeTruthy();
  });

  it("reports a problem for JSON of the wrong shape", () => {
    const outcome = parseModelOutput(JSON.stringify({ score: 12, comment: "good" }), null);
    expect(outcome.ok).toBe(false);
    expect(outcome.problem).toContain("questions");
  });

  it("reports a problem for a truncated response", async () => {
    const spec = await rubric();
    const raw = JSON.stringify(buildModelGrade(spec, () => 1)).slice(0, 200);
    expect(parseModelOutput(raw, null).ok).toBe(false);
  });
});

describe("reconciling a grade against the rubric", () => {
  it("recomputes totals from the rubric points rather than trusting the model", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");
    const grade = buildModelGrade(spec, (id) => (id.endsWith("r1") ? 1 : 0));

    const result = reconcile(spec, grade, doc);

    expect(result.maxMarks).toBe(15);
    expect(result.totalMarks).toBe(3); // one r1 per question
    expect(result.questions.every((q) => q.awardedMarks === 1)).toBe(true);
  });

  it("clamps marks awarded above a rubric point's maximum", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");
    const grade = buildModelGrade(spec, () => 9); // every 1-mark point given 9

    const result = reconcile(spec, grade, doc);

    expect(result.totalMarks).toBe(15);
    expect(result.totalMarks).toBeLessThanOrEqual(result.maxMarks);
    expect(result.flags.some((f) => f.code === "marks_clamped")).toBe(true);
    expect(result.warnings.some((w) => w.includes("clamped"))).toBe(true);
    expect(result.needsHumanReview).toBe(true);
  });

  it("floors negative marks at zero", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");
    const result = reconcile(spec, buildModelGrade(spec, () => -4), doc);

    expect(result.totalMarks).toBe(0);
    for (const question of result.questions) {
      for (const criterion of question.criteria) {
        expect(criterion.awardedMarks).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("fills in rubric points the model skipped and flags the gap", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");
    const grade = buildModelGrade(spec, (_id, max) => max);
    // The model returned only two of the five points for Q1.
    grade.questions[0]!.criteria = grade.questions[0]!.criteria.slice(0, 2);

    const result = reconcile(spec, grade, doc);

    expect(result.questions[0]!.criteria).toHaveLength(5);
    expect(result.questions[0]!.awardedMarks).toBe(2);
    expect(result.flags.some((f) => f.code === "criteria_missing")).toBe(true);
    expect(result.needsHumanReview).toBe(true);
  });

  it("discards marks for rubric ids that do not exist", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");
    const grade = buildModelGrade(spec, () => 0);
    grade.questions[0]!.criteria.push({
      rubricId: "q1.r99",
      awardedMarks: 5,
      verdict: "correct",
      evidence: "invented",
      feedback: "invented",
    });

    const result = reconcile(spec, grade, doc);

    expect(result.totalMarks).toBe(0);
    expect(result.warnings.some((w) => w.includes("q1.r99"))).toBe(true);
  });

  it("lowers confidence when evidence cannot be found in the paper", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");

    const grounded = buildModelGrade(spec, () => 0);
    grounded.questions[0]!.annotations = [
      {
        rubricId: "q1.r2",
        type: "error",
        quote: "The voltmeter is also connected in series with the bulb",
        comment: "Wrong.",
        correction: "In parallel across the bulb.",
      },
    ];

    const invented = buildModelGrade(spec, () => 0);
    invented.questions[0]!.annotations = [
      {
        rubricId: "q1.r2",
        type: "error",
        quote: "The mitochondrion is the powerhouse of the cell",
        comment: "Wrong.",
        correction: "Not relevant.",
      },
    ];

    const groundedResult = reconcile(spec, grounded, doc);
    const inventedResult = reconcile(spec, invented, doc);

    expect(groundedResult.annotations[0]!.anchored).toBe(true);
    expect(inventedResult.annotations[0]!.anchored).toBe(false);
    expect(inventedResult.confidence).toBeLessThan(groundedResult.confidence);
    expect(inventedResult.flags.some((f) => f.code === "unanchored_evidence")).toBe(true);
  });

  it("flags marks awarded with no supporting quote", async () => {
    const spec = await rubric();
    const doc = await extractFixture("student-answer.pdf");
    const grade = buildModelGrade(spec, (_id, max) => max);
    for (const question of grade.questions) {
      for (const criterion of question.criteria) criterion.evidence = null;
    }

    const result = reconcile(spec, grade, doc);
    expect(result.flags.some((f) => f.code === "no_evidence")).toBe(true);
  });
});
