import { randomUUID } from "node:crypto";
import { modelGradeSchema, type ModelGrade } from "../../domain/schema.js";
import type {
  Annotation,
  CriterionResult,
  ExtractedDocument,
  QuestionResult,
  ReviewFlag,
  RubricSpec,
} from "../../domain/types.js";
import { anchorQuote } from "./anchor.js";

/**
 * Everything the model says passes through here before it becomes a grade.
 *
 * The rule of this module: the model's *judgements* are trusted, its *arithmetic and
 * bookkeeping are not*. Totals are always recomputed, marks are always clamped, rubric
 * coverage is always completed, and every departure from what the model said is
 * recorded as a warning so a teacher can see what was adjusted.
 */

export interface ParseOutcome {
  ok: boolean;
  data?: ModelGrade;
  problem?: string;
}

/**
 * Tolerantly turn a model response into a validated ModelGrade.
 * Handles: an already-parsed object, bare JSON, fenced JSON, and JSON with prose
 * wrapped around it - the four shapes malformed output actually takes in practice.
 */
export function parseModelOutput(raw: string, preparsed: unknown | null): ParseOutcome {
  const candidates: unknown[] = [];

  if (preparsed !== null && preparsed !== undefined) candidates.push(preparsed);

  const text = (raw ?? "").trim();
  if (text.length > 0) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const attempts = [text, fenced?.[1], extractBalancedObject(text)].filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    for (const attempt of attempts) {
      try {
        candidates.push(JSON.parse(attempt));
      } catch {
        // Not JSON; try the next shape.
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, problem: "The response contained no JSON object at all." };
  }

  let lastProblem = "Unknown validation failure.";
  for (const candidate of candidates) {
    const parsed = modelGradeSchema.safeParse(candidate);
    if (parsed.success) return { ok: true, data: parsed.data };
    lastProblem = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return { ok: false, problem: lastProblem };
}

/** Pull out the first balanced {...} block, ignoring braces inside strings. */
function extractBalancedObject(text: string): string | null {
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
  return null;
}

/* --------------------------------------------------------------- reconciling */

export interface Reconciled {
  questions: QuestionResult[];
  annotations: Annotation[];
  totalMarks: number;
  maxMarks: number;
  confidence: number;
  needsHumanReview: boolean;
  flags: ReviewFlag[];
  warnings: string[];
  overallFeedback: string;
}

const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Marks are awarded in halves at finest; anything else is noise from the model. */
function roundMark(value: number): number {
  return Math.round(value * 2) / 2;
}

export function reconcile(
  rubric: RubricSpec,
  grade: ModelGrade,
  answerDoc: ExtractedDocument,
): Reconciled {
  const warnings: string[] = [];
  const flags: ReviewFlag[] = [];
  const annotations: Annotation[] = [];
  const byQuestionId = new Map(grade.questions.map((q) => [q.questionId, q]));

  let clampedAny = false;
  let filledAny = false;
  let unsupportedAward = false;

  const seenQuestionIds = new Set(rubric.questions.map((q) => q.id));
  for (const q of grade.questions) {
    if (!seenQuestionIds.has(q.questionId)) {
      warnings.push(`Discarded result for unknown question id "${q.questionId}".`);
    }
  }

  const questions: QuestionResult[] = rubric.questions.map((rq) => {
    const modelQuestion = byQuestionId.get(rq.id);
    const modelCriteria = new Map(
      (modelQuestion?.criteria ?? []).map((c) => [c.rubricId, c]),
    );

    for (const returned of modelQuestion?.criteria ?? []) {
      if (!rq.criteria.some((c) => c.id === returned.rubricId)) {
        warnings.push(
          `Discarded marks for unknown rubric id "${returned.rubricId}" on ${rq.id}.`,
        );
      }
    }

    const criteria: CriterionResult[] = rq.criteria.map((rc) => {
      const returned = modelCriteria.get(rc.id);

      if (!returned) {
        filledAny = true;
        warnings.push(
          `Rubric point ${rc.id} was not marked by the model; recorded as 0 and flagged.`,
        );
        return {
          rubricId: rc.id,
          criterion: rc.criterion,
          maxMarks: rc.maxMarks,
          awardedMarks: 0,
          verdict: "missing",
          evidence: null,
          feedback: "Not marked by the grader. A teacher must mark this point manually.",
        };
      }

      const requested = roundMark(returned.awardedMarks);
      const awarded = clamp(requested, 0, rc.maxMarks);
      if (Math.abs(requested - awarded) > 1e-9) {
        clampedAny = true;
        warnings.push(
          `${rc.id}: model awarded ${returned.awardedMarks} of a maximum ${rc.maxMarks}; clamped to ${awarded}.`,
        );
      }

      if (awarded > 0 && !returned.evidence) {
        unsupportedAward = true;
        warnings.push(`${rc.id}: marks awarded without quoting any evidence.`);
      }

      return {
        rubricId: rc.id,
        criterion: rc.criterion,
        maxMarks: rc.maxMarks,
        awardedMarks: awarded,
        verdict: returned.verdict,
        evidence: returned.evidence,
        feedback: returned.feedback,
      };
    });

    // The question total is derived, never taken from the model.
    const awardedMarks = criteria.reduce((sum, c) => sum + c.awardedMarks, 0);

    for (const annotation of modelQuestion?.annotations ?? []) {
      const anchor = anchorQuote(answerDoc, annotation.quote);
      annotations.push({
        id: randomUUID(),
        questionId: rq.id,
        rubricId:
          annotation.rubricId && rq.criteria.some((c) => c.id === annotation.rubricId)
            ? annotation.rubricId
            : null,
        type: annotation.type,
        quote: annotation.quote,
        comment: annotation.comment,
        correction: annotation.correction,
        rects: anchor.rects,
        anchorScore: anchor.score,
        anchored: anchor.anchored,
        origin: "model",
        edited: false,
      });
    }

    return {
      questionId: rq.id,
      title: rq.title,
      maxMarks: rq.maxMarks,
      awardedMarks,
      criteria,
      correctPoints: modelQuestion?.correctPoints ?? [],
      missingPoints: modelQuestion?.missingPoints ?? [],
      incorrectPoints: modelQuestion?.incorrectPoints ?? [],
      confidence: clamp(modelQuestion?.confidence ?? 0.4, 0, 1),
    };
  });

  const totalMarks = questions.reduce((sum, q) => sum + q.awardedMarks, 0);
  const maxMarks = rubric.questions.reduce((sum, q) => sum + q.maxMarks, 0);

  /* ------------------------------------------------------------- confidence */

  let confidence =
    questions.length > 0
      ? questions.reduce((sum, q) => sum + q.confidence, 0) / questions.length
      : 0;

  // Annotations that could not be placed on the page are the clearest signal that
  // the model and the actual paper have drifted apart.
  const placeable = annotations.filter((a) => a.quote.trim().length >= 3);
  const unanchored = placeable.filter((a) => !a.anchored);
  if (placeable.length > 0 && unanchored.length > 0) {
    const ratio = unanchored.length / placeable.length;
    confidence *= 1 - 0.3 * ratio;
    flags.push({
      code: "unanchored_evidence",
      message: `${unanchored.length} of ${placeable.length} annotation quotes could not be located in the answer paper and are shown in the page margin.`,
    });
  }

  if (clampedAny) {
    confidence -= 0.1;
    flags.push({
      code: "marks_clamped",
      message: "The grader awarded more marks than a rubric point allows; the marks were clamped.",
    });
  }
  if (filledAny) {
    confidence -= 0.15;
    flags.push({
      code: "criteria_missing",
      message: "The grader did not return a mark for every rubric point.",
    });
  }
  if (unsupportedAward) {
    confidence -= 0.05;
    flags.push({
      code: "no_evidence",
      message: "At least one rubric point was awarded without a supporting quote.",
    });
  }

  confidence = Number(clamp(confidence, 0, 1).toFixed(3));

  if (grade.needsHumanReview) {
    flags.push({
      code: "low_confidence",
      message: grade.reviewReason ?? "The grader asked for this paper to be reviewed.",
    });
  } else if (confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    flags.push({
      code: "low_confidence",
      message: `Overall confidence ${confidence} is below the ${REVIEW_CONFIDENCE_THRESHOLD} review threshold.`,
    });
  }

  const needsHumanReview = flags.length > 0;

  return {
    questions,
    annotations,
    totalMarks,
    maxMarks,
    confidence,
    needsHumanReview,
    flags,
    warnings,
    overallFeedback: grade.overallFeedback,
  };
}

/** The result produced for an answer paper with no readable text at all. */
export function blankAnswerResult(rubric: RubricSpec, charCount = 0): Reconciled {
  const detail =
    charCount === 0
      ? "No machine-readable text was found in the answer paper."
      : `Only ${charCount} characters of text were found in the answer paper, which is too little to mark.`;
  const questions: QuestionResult[] = rubric.questions.map((rq) => ({
    questionId: rq.id,
    title: rq.title,
    maxMarks: rq.maxMarks,
    awardedMarks: 0,
    criteria: rq.criteria.map((rc) => ({
      rubricId: rc.id,
      criterion: rc.criterion,
      maxMarks: rc.maxMarks,
      awardedMarks: 0,
      verdict: "missing" as const,
      evidence: null,
      feedback: "No answer was submitted for this question.",
    })),
    correctPoints: [],
    missingPoints: rq.criteria.map((c) => c.criterion),
    incorrectPoints: [],
    confidence: 1,
  }));

  return {
    questions,
    annotations: [],
    totalMarks: 0,
    maxMarks: rubric.questions.reduce((sum, q) => sum + q.maxMarks, 0),
    // We are certain the page is empty; we are not certain that means zero, because a
    // scanned or handwritten paper also extracts to nothing.
    confidence: 1,
    needsHumanReview: true,
    flags: [
      {
        code: "blank_answer",
        message: `${detail} If this is a scan or a handwritten script it needs OCR or manual marking rather than a zero.`,
      },
    ],
    warnings: [],
    overallFeedback:
      "The answer paper contains no extractable text, so no marks could be awarded. This paper requires a human to confirm whether it is genuinely blank.",
  };
}
