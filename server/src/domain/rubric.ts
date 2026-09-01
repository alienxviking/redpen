import fs from "node:fs/promises";
import { DEFAULT_RUBRIC_PATH } from "../config.js";
import { rubricSpecSchema } from "./schema.js";
import type { RubricSpec } from "./types.js";

/**
 * Rubric loading.
 *
 * The rubric is an *input* to the tool, not something baked into it: the shipped
 * rubric.json is the machine-readable transcription of the supplied model-answer
 * paper, and a different paper only needs a different file. It is validated on load,
 * including the arithmetic check that criteria sum to each question's maximum - a
 * rubric that does not add up would make the "total equals the sum of parts"
 * guarantee meaningless.
 */

let cached: { path: string; spec: RubricSpec } | null = null;

export async function loadRubric(rubricPath = DEFAULT_RUBRIC_PATH): Promise<RubricSpec> {
  if (cached && cached.path === rubricPath) return cached.spec;

  let raw: string;
  try {
    raw = await fs.readFile(rubricPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read rubric at ${rubricPath}`, { cause: error });
  }

  return parseRubric(raw, rubricPath);
}

export function parseRubric(raw: string, sourcePath = "(inline)"): RubricSpec {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Rubric at ${sourcePath} is not valid JSON`, { cause: error });
  }

  const parsed = rubricSpecSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Rubric at ${sourcePath} is invalid - ${detail}`);
  }

  const spec = parsed.data as RubricSpec;
  cached = { path: sourcePath, spec };
  return spec;
}

export function clearRubricCache(): void {
  cached = null;
}
