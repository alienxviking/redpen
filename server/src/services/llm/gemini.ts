import { config } from "../../config.js";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "../grading/prompt.js";
import {
  type GradeRequest,
  type GraderProvider,
  type ProviderResponse,
  ProviderUnavailableError,
} from "./provider.js";

/**
 * Grading via Google's Gemini API, which has a genuinely free tier.
 *
 * Chosen over the other free options for one concrete reason: it accepts a PDF
 * directly, so the model can still *see* the circuit diagram and the demand/supply
 * graph. Two of the three questions are marked partly on a drawing, and a text-only
 * free model would quietly lose that capability while still appearing to work.
 *
 * Called over plain REST rather than through an SDK: it is a single endpoint, and the
 * provider interface already normalises errors and retries, so a dependency would buy
 * nothing here.
 *
 * Note what this deliberately does NOT do: it does not send a `responseSchema`.
 * Gemini's schema dialect does not cleanly express the nullable fields this grade
 * shape needs, and forcing it would mean weakening the contract. Instead it asks for
 * JSON and lets the existing tolerant parser and repair round-trip do their job - the
 * machinery that exists precisely for models that do not guarantee conformance.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiGrader implements GraderProvider {
  readonly name = "gemini" as const;
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model = config.geminiModel,
  ) {
    this.model = model;
  }

  async grade(request: GradeRequest): Promise<ProviderResponse> {
    return this.call(buildUserPrompt(request), request);
  }

  async repair(
    request: GradeRequest,
    badOutput: string,
    problem: string,
  ): Promise<ProviderResponse> {
    return this.call(buildRepairPrompt(request, badOutput, problem), request);
  }

  private async call(prompt: string, request: GradeRequest): Promise<ProviderResponse> {
    const parts: Array<Record<string, unknown>> = [];

    if (request.answerPdfBase64) {
      parts.push({
        inline_data: { mime_type: "application/pdf", data: request.answerPdfBase64 },
      });
    }
    parts.push({ text: prompt });

    const body = {
      systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        // Marking should be as reproducible as the model allows.
        temperature: 0,
        maxOutputTokens: config.maxTokens,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderUnavailableError("Gemini request timed out", "timeout", {
          cause: error,
        });
      }
      throw new ProviderUnavailableError("Could not reach the Gemini API", "network", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.describeFailure(response);
    }

    const payload = (await response.json()) as GeminiResponse;
    const candidate = payload.candidates?.[0];
    const finish = candidate?.finishReason;

    if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST") {
      throw new ProviderUnavailableError(
        `Gemini declined to grade this paper (${finish})`,
        "refusal",
      );
    }

    const raw = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    // A response cut off at the token ceiling is malformed by definition. Returning it
    // lets the caller's repair round-trip handle it rather than failing outright.
    return {
      raw,
      parsed: null,
      provider: this.name,
      model: this.model,
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  /** Turn an HTTP failure into something a person can act on. */
  private async describeFailure(response: Response): Promise<ProviderUnavailableError> {
    let detail = "";
    try {
      const body = (await response.json()) as GeminiResponse;
      detail = body.error?.message ?? "";
    } catch {
      // Non-JSON error body; the status alone will have to do.
    }

    switch (response.status) {
      case 400:
        return new ProviderUnavailableError(
          `Gemini rejected the request: ${detail || "bad request"}`,
          "unknown",
        );
      case 401:
      case 403:
        return new ProviderUnavailableError(
          `Gemini rejected the API key${detail ? `: ${detail}` : ""}`,
          "auth",
        );
      case 404: {
        // Much the most likely cause is a model name that is not available to this
        // key, so say which ones are.
        const available = await this.listModels().catch(() => [] as string[]);
        const hint =
          available.length > 0
            ? ` Models available to this key include: ${available.slice(0, 8).join(", ")}.`
            : "";
        return new ProviderUnavailableError(
          `Gemini has no model "${this.model}" for this key.${hint} Set GEMINI_MODEL to one of them.`,
          "unknown",
        );
      }
      case 429:
        return new ProviderUnavailableError(
          `Gemini free-tier rate limit reached${detail ? `: ${detail}` : ""}`,
          "rate_limit",
        );
      default:
        return new ProviderUnavailableError(
          `Gemini API error ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status >= 500 ? "server" : "unknown",
        );
    }
  }

  /** Model ids this key can actually use, for the 404 error message. */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${ENDPOINT}/models`, {
      headers: { "x-goog-api-key": this.apiKey },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }
}
