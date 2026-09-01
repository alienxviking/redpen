import type { RubricSpec } from "../../domain/types.js";

/**
 * Everything the grader needs to know about "the model", behind one small interface.
 *
 * Two implementations ship: the real Anthropic call and a deterministic mock. The
 * mock is not just a test double - it is the fallback that keeps the product usable
 * when no API key is configured or the API is down, which is what the reliability
 * requirement actually demands.
 */

export interface GradeRequest {
  rubric: RubricSpec;
  /** Machine-extracted text of the answer. Quotes must come from this exact string. */
  answerText: string;
  questionPaperText?: string;
  /**
   * Text of an uploaded model-answer/rubric paper, used as extra reference context.
   * The marks themselves always come from the structured rubric, never from this.
   */
  modelAnswerText?: string;
  /**
   * The answer paper itself, base64-encoded. Two of the three questions are marked
   * partly on a diagram, which no amount of text extraction will reveal, so when the
   * provider supports document input we send the PDF alongside the text.
   */
  answerPdfBase64?: string;
}

export interface ProviderResponse {
  /** Raw text the model produced, kept for debugging and for the repair path. */
  raw: string;
  /** Pre-parsed object when the provider could validate it itself; else null. */
  parsed: unknown | null;
  provider: "anthropic" | "gemini" | "groq" | "mock";
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface GraderProvider {
  readonly name: "anthropic" | "gemini" | "groq" | "mock";
  readonly model: string;
  grade(request: GradeRequest): Promise<ProviderResponse>;
  /** Ask the provider to fix output that failed our schema check. */
  repair?(request: GradeRequest, badOutput: string, problem: string): Promise<ProviderResponse>;
}

/** Thrown when the model could not be reached or refused to answer. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "auth"
      | "rate_limit"
      | "timeout"
      | "server"
      | "refusal"
      | "network"
      | "unknown",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}
