import { config } from "../../config.js";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "../grading/prompt.js";
import {
  type GradeRequest,
  type GraderProvider,
  type ProviderResponse,
  ProviderUnavailableError,
} from "./provider.js";

/**
 * Grading via Groq - free, and far faster than the alternatives.
 *
 * Groq speaks the OpenAI chat-completions wire format, so `GROQ_BASE_URL` also points
 * this adapter at OpenRouter, Together, or a local vLLM / LM Studio server without
 * any code change. Groq is simply the default because it is free and quick.
 *
 * The honest caveat, and the reason this is not preferred over Gemini: Groq's API
 * accepts no PDF, and its production models are text-only. Two of the three questions
 * on this paper are marked partly on a drawing.
 *
 * That is handled rather than hidden. `buildUserPrompt` is deliberately called WITHOUT
 * the PDF, which switches the prompt to the branch that tells the model it cannot see
 * the diagrams and instructs it to say so, lower its confidence, and flag those
 * questions for human review. The result is a lower, clearly-reasoned score rather
 * than a confident guess about a diagram nobody showed it.
 */

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export class GroqGrader implements GraderProvider {
  readonly name = "groq" as const;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    model = config.groqModel,
    baseUrl = config.groqBaseUrl,
  ) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Which endpoint is actually being used, for error messages and logs. */
  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  async grade(request: GradeRequest): Promise<ProviderResponse> {
    return this.call(buildUserPrompt(withoutPdf(request)));
  }

  async repair(
    request: GradeRequest,
    badOutput: string,
    problem: string,
  ): Promise<ProviderResponse> {
    return this.call(buildRepairPrompt(withoutPdf(request), badOutput, problem));
  }

  private async call(prompt: string): Promise<ProviderResponse> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: prompt },
      ],
      // Groq honours this on its instruct models. Where a server does not, the
      // tolerant parser and the repair round-trip still recover the grade.
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: config.maxTokens,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderUnavailableError(`${this.host} request timed out`, "timeout", {
          cause: error,
        });
      }
      throw new ProviderUnavailableError(`Could not reach ${this.host}`, "network", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.describeFailure(response);
    }

    const payload = (await response.json()) as ChatResponse;
    const choice = payload.choices?.[0];

    if (choice?.finish_reason === "content_filter") {
      throw new ProviderUnavailableError(
        `${this.host} declined to grade this paper (content filter)`,
        "refusal",
      );
    }

    // A response cut off at the token ceiling is malformed by definition. Returning it
    // lets the caller's repair round-trip deal with it rather than failing outright.
    return {
      raw: choice?.message?.content ?? "",
      parsed: null,
      provider: this.name,
      model: this.model,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }

  /** Turn an HTTP failure into something a person can act on. */
  private async describeFailure(response: Response): Promise<ProviderUnavailableError> {
    let detail = "";
    try {
      const body = (await response.json()) as ChatResponse;
      detail = body.error?.message ?? "";
    } catch {
      // Non-JSON error body; the status alone will have to do.
    }

    switch (response.status) {
      case 401:
      case 403:
        return new ProviderUnavailableError(
          `${this.host} rejected the API key${detail ? `: ${detail}` : ""}`,
          "auth",
        );
      case 404: {
        // Groq retires model ids fairly often, so name the ones that do work.
        const available = await this.listModels().catch(() => [] as string[]);
        const hint =
          available.length > 0
            ? ` Models available to this key include: ${available.slice(0, 8).join(", ")}.`
            : "";
        return new ProviderUnavailableError(
          `${this.host} has no model "${this.model}".${hint} Set GROQ_MODEL to one of them.`,
          "unknown",
        );
      }
      case 413:
        return new ProviderUnavailableError(
          `${this.host} rejected the request as too large${detail ? `: ${detail}` : ""}`,
          "unknown",
        );
      case 429:
        return new ProviderUnavailableError(
          `${this.host} rate limit reached${detail ? `: ${detail}` : ""}`,
          "rate_limit",
        );
      default:
        return new ProviderUnavailableError(
          `${this.host} error ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status >= 500 ? "server" : "unknown",
        );
    }
  }

  /** Model ids this key can use, for the 404 error message. */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }
}

/**
 * Drop the PDF from the request. Removing it is precisely what makes the prompt tell
 * the model it is working from extracted text alone - see the note at the top.
 */
function withoutPdf(request: GradeRequest): GradeRequest {
  const { answerPdfBase64: _unusedByThisProvider, ...rest } = request;
  return rest;
}
