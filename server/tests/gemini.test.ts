import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiGrader } from "../src/services/llm/gemini.js";
import { ProviderUnavailableError } from "../src/services/llm/provider.js";
import { buildModelGrade, hasRubric, rubric } from "./helpers.js";

/**
 * The Gemini adapter, exercised against a stubbed fetch.
 *
 * These run without a key and without touching the network - what is being tested is
 * the mapping from HTTP reality to the provider contract, which is the part the rest
 * of the pipeline depends on.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

/** Await a call that must fail, and hand back the typed provider error. */
async function expectFailure(promise: Promise<unknown>): Promise<ProviderUnavailableError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ProviderUnavailableError);
  return outcome as ProviderUnavailableError;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function request() {
  const spec = await rubric();
  return {
    rubric: spec,
    answerText: "In my circut the battery, switch and bulb are joined in series.",
    answerPdfBase64: Buffer.from("%PDF-1.7 fake").toString("base64"),
  };
}

describe.skipIf(!hasRubric)("Gemini grader", () => {
  it("sends the answer PDF and the prompt, and returns the model's text", async () => {
    const spec = await rubric();
    const grade = buildModelGrade(spec, (_id, max) => max);

    const spy = stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      // The PDF must travel with the request, or diagram marking silently degrades.
      expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
      expect(typeof body.contents[0].parts[1].text).toBe("string");
      expect(body.systemInstruction.parts[0].text).toContain("examiner");
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      expect(body.generationConfig.temperature).toBe(0);
      return jsonResponse({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(grade) }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 800 },
      });
    });

    const grader = new GeminiGrader("test-key", "gemini-2.5-flash");
    const response = await grader.grade(await request());

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain("gemini-2.5-flash:generateContent");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "test-key" });

    expect(response.provider).toBe("gemini");
    expect(response.model).toBe("gemini-2.5-flash");
    expect(JSON.parse(response.raw).questions).toHaveLength(3);
    expect(response.usage).toEqual({ inputTokens: 1200, outputTokens: 800 });
  });

  it("joins multi-part responses", async () => {
    stubFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] } }],
      }),
    );
    const response = await new GeminiGrader("k").grade(await request());
    expect(response.raw).toBe('{"a":1}');
  });

  it("maps a rejected key to an auth failure", async () => {
    stubFetch(() => jsonResponse({ error: { message: "API key not valid" } }, 401));
    await expect(new GeminiGrader("bad").grade(await request())).rejects.toMatchObject({
      name: "ProviderUnavailableError",
      reason: "auth",
    });
  });

  it("maps the free-tier quota to a rate limit", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Quota exceeded" } }, 429));
    const error = await expectFailure(new GeminiGrader("k").grade(await request()));
    expect(error.reason).toBe("rate_limit");
    expect(error.message).toMatch(/rate limit/i);
  });

  it("maps a 5xx to a server failure so the pipeline degrades", async () => {
    stubFetch(() => jsonResponse({ error: { message: "backend error" } }, 503));
    await expect(new GeminiGrader("k").grade(await request())).rejects.toMatchObject({
      reason: "server",
    });
  });

  it("names the available models when the configured one does not exist", async () => {
    stubFetch((url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({
          models: [
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          ],
        });
      }
      return jsonResponse({ error: { message: "not found" } }, 404);
    });

    const error = await expectFailure(
      new GeminiGrader("k", "gemini-9-ultra").grade(await request()),
    );

    expect(error.message).toContain("gemini-9-ultra");
    expect(error.message).toContain("gemini-2.5-flash");
    // Embedding-only models are not offered as alternatives.
    expect(error.message).not.toContain("text-embedding");
  });

  it("treats a safety block as a refusal rather than a grade", async () => {
    stubFetch(() => jsonResponse({ candidates: [{ finishReason: "SAFETY" }] }));
    await expect(new GeminiGrader("k").grade(await request())).rejects.toMatchObject({
      reason: "refusal",
    });
  });

  it("maps a network failure to a network error", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(new GeminiGrader("k").grade(await request())).rejects.toMatchObject({
      reason: "network",
    });
  });

  it("maps an aborted request to a timeout", async () => {
    stubFetch(() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(new GeminiGrader("k").grade(await request())).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("returns truncated output rather than throwing, so repair can handle it", async () => {
    stubFetch(() =>
      jsonResponse({
        candidates: [
          { content: { parts: [{ text: '{"questions": [' }] }, finishReason: "MAX_TOKENS" },
        ],
      }),
    );
    const response = await new GeminiGrader("k").grade(await request());
    expect(response.raw).toBe('{"questions": [');
  });
});
