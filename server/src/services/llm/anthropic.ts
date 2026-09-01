import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../../config.js";
import { modelGradeSchema } from "../../domain/schema.js";
import { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from "../grading/prompt.js";
import {
  type GradeRequest,
  type GraderProvider,
  type ProviderResponse,
  ProviderUnavailableError,
} from "./provider.js";

/**
 * The real grader.
 *
 * Structured outputs (`output_config.format`) do most of the work of keeping the
 * response parseable, but we deliberately do NOT trust it blindly: `parsed_output`
 * can come back null, and the caller re-validates and repairs regardless. Belt and
 * braces, because a malformed grade that silently becomes a score is the exact
 * failure this tool exists to prevent.
 */
export class AnthropicGrader implements GraderProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey?: string, model = config.model) {
    this.model = model;
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      maxRetries: 2, // SDK retries 408/409/429/5xx and connection errors
      timeout: config.requestTimeoutMs,
    });
  }

  async grade(request: GradeRequest): Promise<ProviderResponse> {
    return this.call(buildSystemPrompt(), userContent(request, buildUserPrompt(request)));
  }

  async repair(
    request: GradeRequest,
    badOutput: string,
    problem: string,
  ): Promise<ProviderResponse> {
    return this.call(
      buildSystemPrompt(),
      userContent(request, buildRepairPrompt(request, badOutput, problem)),
    );
  }

  private async call(
    system: string,
    user: Anthropic.ContentBlockParam[],
  ): Promise<ProviderResponse> {
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: config.maxTokens,
        system: [
          // The rubric-independent instructions are stable across every paper we
          // grade, so cache them and pay full price only for the paper itself.
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: zodOutputFormat(modelGradeSchema),
        },
        messages: [{ role: "user", content: user }],
      });

      if (response.stop_reason === "refusal") {
        throw new ProviderUnavailableError(
          `Model declined to grade this paper (${response.stop_details?.category ?? "unknown"})`,
          "refusal",
        );
      }

      const raw = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      return {
        raw,
        parsed: response.parsed_output ?? null,
        provider: this.name,
        model: this.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      throw classify(error);
    }
  }
}

/**
 * The answer paper goes in as a PDF document block ahead of the instructions, so the
 * model can actually look at the circuit diagram and the demand/supply graph. The
 * extracted text still travels with it - that is the string quotes are matched against.
 */
function userContent(
  request: GradeRequest,
  prompt: string,
): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (request.answerPdfBase64) {
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: request.answerPdfBase64,
      },
      title: "Student answer paper",
    });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

/** Map SDK exceptions onto the reasons the rest of the app cares about. */
function classify(error: unknown): Error {
  if (error instanceof ProviderUnavailableError) return error;

  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderUnavailableError("Anthropic rejected the API key", "auth", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderUnavailableError("Rate limited by Anthropic", "rate_limit", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderUnavailableError("Grading request timed out", "timeout", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderUnavailableError("Could not reach Anthropic", "network", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new ProviderUnavailableError(
      `Anthropic API error ${status}: ${error.message}`,
      status >= 500 ? "server" : "unknown",
      { cause: error },
    );
  }
  return new ProviderUnavailableError(
    error instanceof Error ? error.message : "Unknown grading failure",
    "unknown",
    { cause: error },
  );
}
