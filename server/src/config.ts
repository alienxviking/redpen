import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file so it works under tsx and dist alike. */
export const ROOT = path.resolve(here, "..", "..");
export const SERVER_ROOT = path.resolve(here, "..");

/**
 * Load .env by absolute path rather than relying on the working directory.
 *
 * `npm run dev` starts the server through a workspace script, so the cwd is server/,
 * not the repo root - a bare `dotenv/config` would look in the wrong place and
 * silently find no keys, leaving the app on the offline grader while the user stares
 * at a .env that looks correct. Both locations are accepted; the first wins.
 */
dotenv.config({
  path: [path.join(SERVER_ROOT, ".env"), path.join(ROOT, ".env")],
  quiet: true,
});

export const DATA_DIR = process.env.GRADESENSE_DATA_DIR
  ? path.resolve(process.env.GRADESENSE_DATA_DIR)
  : path.join(SERVER_ROOT, "data");

export const FILES_DIR = path.join(DATA_DIR, "files");
export const EXPORTS_DIR = path.join(DATA_DIR, "exports");
export const DB_PATH = path.join(DATA_DIR, "db.json");

export const FIXTURES_DIR = path.join(ROOT, "fixtures");
export const DEFAULT_RUBRIC_PATH = path.join(FIXTURES_DIR, "provided", "rubric.json");

export type ProviderChoice = "auto" | "anthropic" | "gemini" | "groq" | "mock";
export type ProviderName = "anthropic" | "gemini" | "groq" | "mock";

export const config = {
  port: Number(process.env.PORT ?? 5174),
  apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  geminiApiKey:
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined,
  geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest",
  groqApiKey: process.env.GROQ_API_KEY?.trim() || undefined,
  groqModel: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
  /** Groq speaks the OpenAI wire format, so this also reaches OpenRouter, vLLM, etc. */
  groqBaseUrl: process.env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
  providerChoice: (process.env.GRADER_PROVIDER?.trim() || "auto") as ProviderChoice,
  model: process.env.GRADER_MODEL?.trim() || "claude-opus-5",
  /** Below this many non-whitespace characters an answer is treated as blank. */
  blankThreshold: Number(process.env.BLANK_THRESHOLD ?? 40),
  /** Per-request ceiling for the grading call. */
  maxTokens: Number(process.env.GRADER_MAX_TOKENS ?? 16000),
  requestTimeoutMs: Number(process.env.GRADER_TIMEOUT_MS ?? 120_000),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
};

/**
 * Which grader will actually run.
 *
 * `auto` prefers Claude, then Gemini (which has a free tier), then falls back to the
 * deterministic offline grader - so the app is always runnable by a reviewer who has
 * no key at all, and runs on a real model for anyone who has either.
 */
export function resolveProvider(): ProviderName {
  switch (config.providerChoice) {
    case "mock":
      return "mock";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "gemini";
    case "groq":
      return "groq";
    default:
      // Preference order is about capability, not cost. Claude and Gemini can both see
      // the answer PDF, so they can mark the two diagram questions; Groq is text-only
      // and therefore comes after them, ahead of the offline grader.
      if (config.apiKey) return "anthropic";
      if (config.geminiApiKey) return "gemini";
      if (config.groqApiKey) return "groq";
      return "mock";
  }
}
