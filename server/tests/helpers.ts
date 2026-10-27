import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUBRIC_PATH } from "../src/config.js";
import type { ModelGrade } from "../src/domain/schema.js";
import type { ExtractedDocument, RubricSpec } from "../src/domain/types.js";
import { loadRubric } from "../src/domain/rubric.js";
import { extractPdf } from "../src/services/pdf/extractText.js";
import {
  ProviderUnavailableError,
  type GradeRequest,
  type GraderProvider,
  type ProviderResponse,
} from "../src/services/llm/provider.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "..", "..", "fixtures");

/**
 * Whether the supplied rubric is here. `fixtures/provided/` is not published (see the
 * README), so on a fresh clone the tests that mark against it are skipped rather than
 * failed, and everything that does not need it still runs.
 */
export const hasRubric = existsSync(DEFAULT_RUBRIC_PATH);

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

export async function readFixture(name: string): Promise<Buffer> {
  return fs.readFile(fixture(name));
}

export async function extractFixture(name: string): Promise<ExtractedDocument> {
  return extractPdf(await readFixture(name));
}

export async function rubric(): Promise<RubricSpec> {
  return loadRubric();
}

/** A provider that returns whatever we hand it, for exercising the parsing path. */
export function stubProvider(
  response: Partial<ProviderResponse> & { raw: string },
  options: { repairWith?: Partial<ProviderResponse> & { raw: string } } = {},
): GraderProvider {
  const base = {
    parsed: null,
    provider: "anthropic" as const,
    model: "stub-model",
  };
  const provider: GraderProvider = {
    name: "anthropic",
    model: "stub-model",
    async grade() {
      return { ...base, ...response };
    },
  };
  if (options.repairWith) {
    provider.repair = async () => ({ ...base, ...options.repairWith! });
  }
  return provider;
}

/** A provider that always fails, for exercising the degradation path. */
export function failingProvider(
  reason: ConstructorParameters<typeof ProviderUnavailableError>[1] = "server",
): GraderProvider {
  return {
    name: "anthropic",
    model: "stub-model",
    async grade(): Promise<ProviderResponse> {
      throw new ProviderUnavailableError("Anthropic API error 503: overloaded", reason);
    },
    async repair(): Promise<ProviderResponse> {
      throw new ProviderUnavailableError("Anthropic API error 503: overloaded", reason);
    },
  };
}

/**
 * Build a well-formed model grade for a rubric, awarding `marksFor` per criterion.
 * Used to isolate the validation layer from any particular model behaviour.
 */
export function buildModelGrade(
  spec: RubricSpec,
  marksFor: (rubricId: string, maxMarks: number) => number,
  overrides: Partial<ModelGrade> = {},
): ModelGrade {
  return {
    questions: spec.questions.map((q) => ({
      questionId: q.id,
      criteria: q.criteria.map((c) => ({
        rubricId: c.id,
        awardedMarks: marksFor(c.id, c.maxMarks),
        verdict: marksFor(c.id, c.maxMarks) > 0 ? ("correct" as const) : ("missing" as const),
        evidence: marksFor(c.id, c.maxMarks) > 0 ? "in series in the main loop" : null,
        feedback: `Feedback for ${c.id}`,
      })),
      correctPoints: [],
      missingPoints: [],
      incorrectPoints: [],
      annotations: [],
      confidence: 0.9,
    })),
    overallFeedback: "Stub feedback.",
    needsHumanReview: false,
    reviewReason: null,
    ...overrides,
  };
}

export function asRequest(spec: RubricSpec, answerText: string): GradeRequest {
  return { rubric: spec, answerText };
}
