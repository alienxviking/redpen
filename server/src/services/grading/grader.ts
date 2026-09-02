import { randomUUID } from "node:crypto";
import { config, resolveProvider } from "../../config.js";
import type {
  ExtractedDocument,
  GradeResult,
  GradingRecord,
  ReviewFlag,
  RubricSpec,
} from "../../domain/types.js";
import { AnthropicGrader } from "../llm/anthropic.js";
import { GeminiGrader } from "../llm/gemini.js";
import { GroqGrader } from "../llm/groq.js";
import { MockGrader } from "../llm/mock.js";
import {
  ProviderUnavailableError,
  type GradeRequest,
  type GraderProvider,
} from "../llm/provider.js";
import { blankAnswerResult, parseModelOutput, reconcile, type Reconciled } from "./validate.js";

/**
 * The grading pipeline.
 *
 * Degradation ladder, in order:
 *   blank paper           -> short-circuit, zero marks, flagged for a human
 *   model call fails      -> deterministic offline grader, flagged as degraded
 *   output does not parse -> one repair round-trip, then the offline grader
 *
 * At no point does a failure surface as "graded successfully". Every step that is
 * not the happy path leaves a flag on the result.
 */

export interface GradeInput {
  rubric: RubricSpec;
  answerDoc: ExtractedDocument;
  answerFilename: string;
  answerPdf?: Buffer;
  questionPaperText?: string;
  modelAnswerText?: string;
  documents: { questionPaperId?: string; answerId: string; modelAnswerId?: string };
  /** Injectable for tests; defaults to the configured provider. */
  provider?: GraderProvider;
  /** Injectable for tests; defaults to the offline grader. */
  fallback?: GraderProvider;
}

export class GradingFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GradingFailedError";
  }
}

export function defaultProvider(): GraderProvider {
  switch (resolveProvider()) {
    case "anthropic":
      return new AnthropicGrader(config.apiKey);
    case "gemini":
      // resolveProvider only returns this when a key is present, but an explicit
      // GRADER_PROVIDER=gemini with no key should fail loudly, not silently mock.
      if (!config.geminiApiKey) {
        throw new GradingFailedError(
          "GRADER_PROVIDER=gemini but no GEMINI_API_KEY is set.",
        );
      }
      return new GeminiGrader(config.geminiApiKey);
    case "groq":
      if (!config.groqApiKey) {
        throw new GradingFailedError("GRADER_PROVIDER=groq but no GROQ_API_KEY is set.");
      }
      return new GroqGrader(config.groqApiKey);
    default:
      return new MockGrader();
  }
}

export async function gradeAnswer(input: GradeInput): Promise<GradingRecord> {
  const { rubric, answerDoc, answerFilename, documents } = input;
  const provider = input.provider ?? defaultProvider();
  const fallback = input.fallback ?? new MockGrader();

  const extraFlags: ReviewFlag[] = [];
  const extraWarnings: string[] = [];

  // Marks derived from a transcription are only as good as the transcription. Say so on
  // the result rather than letting OCR output pass as the student's own words.
  if (answerDoc.source === "vision") {
    extraFlags.push({
      code: "ocr_extraction",
      message:
        "This paper had no text layer, so the writing was transcribed from the page image before marking. Quotes and mark placements follow that transcription and should be checked against the original script.",
    });
  }

  // 1. Blank or near-blank: never send this to a model, and never call it a zero
  //    without saying so.
  if (answerDoc.isBlank || answerDoc.charCount < config.blankThreshold) {
    return assemble({
      rubric,
      reconciled: blankAnswerResult(rubric, answerDoc.charCount),
      grader: { provider: provider.name, model: provider.model, degraded: false },
      answerFilename,
      documents,
      extraFlags,
      extraWarnings,
    });
  }

  const request: GradeRequest = {
    rubric,
    answerText: answerDoc.text,
    ...(input.questionPaperText ? { questionPaperText: input.questionPaperText } : {}),
    ...(input.modelAnswerText ? { modelAnswerText: input.modelAnswerText } : {}),
    ...(input.answerPdf ? { answerPdfBase64: input.answerPdf.toString("base64") } : {}),
  };

  let active = provider;
  let degraded = false;
  let response;

  // 2. Call the model, falling back to the offline grader if it is unreachable.
  try {
    response = await active.grade(request);
  } catch (error) {
    if (!(error instanceof ProviderUnavailableError) || active.name === fallback.name) {
      throw new GradingFailedError(
        error instanceof Error ? error.message : "Grading failed",
        { cause: error },
      );
    }
    extraFlags.push({
      code: "model_unavailable",
      message: `The grading model was unavailable (${error.reason}: ${error.message}). This paper was graded by the offline pattern grader and must be checked by a teacher.`,
    });
    active = fallback;
    degraded = true;
    try {
      response = await fallback.grade(request);
    } catch (fallbackError) {
      throw new GradingFailedError("Both the grading model and the offline grader failed.", {
        cause: fallbackError,
      });
    }
  }

  // 3. Parse, with one repair round-trip before giving up on the model.
  let parsed = parseModelOutput(response.raw, response.parsed);

  if (!parsed.ok && active.repair) {
    extraWarnings.push(
      `The grader's first response was unusable (${parsed.problem}); a repair was requested.`,
    );
    try {
      const repaired = await active.repair(request, response.raw, parsed.problem ?? "");
      const reparsed = parseModelOutput(repaired.raw, repaired.parsed);
      if (reparsed.ok) {
        parsed = reparsed;
        response = repaired;
        extraFlags.push({
          code: "model_output_repaired",
          message:
            "The grader's first response was malformed and had to be regenerated. Worth a second look.",
        });
      }
    } catch (error) {
      extraWarnings.push(
        `The repair attempt also failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
  }

  if (!parsed.ok && active.name !== fallback.name) {
    extraFlags.push({
      code: "model_output_repaired",
      message: `The grading model returned output that could not be validated (${parsed.problem}). This paper was graded by the offline pattern grader instead.`,
    });
    active = fallback;
    degraded = true;
    const fallbackResponse = await fallback.grade(request);
    parsed = parseModelOutput(fallbackResponse.raw, fallbackResponse.parsed);
  }

  if (!parsed.ok || !parsed.data) {
    throw new GradingFailedError(
      `Could not obtain a valid grading result: ${parsed.problem ?? "unknown problem"}`,
    );
  }

  if (active.name === "mock") degraded = true;

  return assemble({
    rubric,
    reconciled: reconcile(rubric, parsed.data, answerDoc),
    grader: { provider: active.name, model: active.model, degraded },
    answerFilename,
    documents,
    extraFlags,
    extraWarnings,
  });
}

function assemble(args: {
  rubric: RubricSpec;
  reconciled: Reconciled;
  grader: GradeResult["grader"];
  answerFilename: string;
  documents: GradeResult["documents"];
  extraFlags: ReviewFlag[];
  extraWarnings: string[];
}): GradingRecord {
  const { reconciled, extraFlags, extraWarnings } = args;
  const flags = [...extraFlags, ...reconciled.flags];

  const result: GradeResult = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    rubricId: args.rubric.id,
    documents: args.documents,
    answerFilename: args.answerFilename,
    totalMarks: reconciled.totalMarks,
    maxMarks: reconciled.maxMarks,
    questions: reconciled.questions,
    confidence: reconciled.confidence,
    needsHumanReview: reconciled.needsHumanReview || flags.length > 0,
    flags,
    grader: args.grader,
    warnings: [...extraWarnings, ...reconciled.warnings],
    overallFeedback: reconciled.overallFeedback,
  };

  assertInvariants(result);
  return { result, annotations: reconciled.annotations };
}

/**
 * Last line of defence. These are the guarantees the assignment states as rules, so
 * they are checked on the way out rather than merely intended on the way in. A breach
 * here is a bug in this file, not bad model output, so it throws.
 */
export function assertInvariants(result: GradeResult): void {
  for (const question of result.questions) {
    const sum = question.criteria.reduce((a, c) => a + c.awardedMarks, 0);
    if (Math.abs(sum - question.awardedMarks) > 1e-9) {
      throw new GradingFailedError(
        `Invariant violated: ${question.questionId} total ${question.awardedMarks} != sum of rubric marks ${sum}`,
      );
    }
    if (question.awardedMarks > question.maxMarks + 1e-9) {
      throw new GradingFailedError(
        `Invariant violated: ${question.questionId} awarded ${question.awardedMarks} of ${question.maxMarks}`,
      );
    }
    for (const criterion of question.criteria) {
      if (criterion.awardedMarks < 0 || criterion.awardedMarks > criterion.maxMarks + 1e-9) {
        throw new GradingFailedError(
          `Invariant violated: ${criterion.rubricId} awarded ${criterion.awardedMarks} of ${criterion.maxMarks}`,
        );
      }
    }
  }

  const total = result.questions.reduce((a, q) => a + q.awardedMarks, 0);
  if (Math.abs(total - result.totalMarks) > 1e-9) {
    throw new GradingFailedError(
      `Invariant violated: paper total ${result.totalMarks} != sum of question marks ${total}`,
    );
  }
  if (result.totalMarks > result.maxMarks + 1e-9) {
    throw new GradingFailedError(
      `Invariant violated: ${result.totalMarks} awarded out of a maximum ${result.maxMarks}`,
    );
  }
}
