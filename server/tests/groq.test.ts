import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqGrader } from "../src/services/llm/groq.js";
import { ProviderUnavailableError } from "../src/services/llm/provider.js";
import { buildModelGrade, hasRubric, rubric } from "./helpers.js";

/**
 * The Groq adapter, exercised against a stubbed fetch - no key, no network.
 *
 * The most important test here is the last group: Groq cannot see the answer PDF, and
 * the adapter must make that visible in the prompt rather than let the model guess at
 * diagrams it was never shown.
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

function chat(content: string, finish = "stop"): Response {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 900, completion_tokens: 400 },
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

describe.skipIf(!hasRubric)("Groq grader", () => {
  it("posts an OpenAI-shaped chat completion and returns the content", async () => {
    const spec = await rubric();
    const grade = buildModelGrade(spec, (_id, max) => max);

    // The model is passed explicitly: a test must not depend on whatever GROQ_MODEL
    // happens to be set to in the developer's own .env file.
    const spy = stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("openai/gpt-oss-120b");
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toContain("examiner");
      expect(body.messages[1].role).toBe("user");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.temperature).toBe(0);
      return chat(JSON.stringify(grade));
    });

    const response = await new GroqGrader("test-key", "openai/gpt-oss-120b").grade(
      await request(),
    );

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-key",
    });

    expect(response.provider).toBe("groq");
    expect(JSON.parse(response.raw).questions).toHaveLength(3);
    expect(response.usage).toEqual({ inputTokens: 900, outputTokens: 400 });
  });

  it("can be pointed at any OpenAI-compatible endpoint", async () => {
    const spy = stubFetch(() => chat("{}"));
    await new GroqGrader("k", "some-model", "http://localhost:1234/v1/").grade(await request());
    expect(String(spy.mock.calls[0]![0])).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("maps a rejected key to an auth failure", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Invalid API Key" } }, 401));
    const error = await expectFailure(new GroqGrader("bad").grade(await request()));
    expect(error.reason).toBe("auth");
  });

  it("maps the free-tier quota to a rate limit", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Rate limit reached" } }, 429));
    const error = await expectFailure(new GroqGrader("k").grade(await request()));
    expect(error.reason).toBe("rate_limit");
  });

  it("maps a 5xx to a server failure so the pipeline degrades", async () => {
    stubFetch(() => jsonResponse({ error: { message: "over capacity" } }, 503));
    const error = await expectFailure(new GroqGrader("k").grade(await request()));
    expect(error.reason).toBe("server");
  });

  it("names the available models when a model id has been retired", async () => {
    stubFetch((url) => {
      if (url.endsWith("/models")) {
        return jsonResponse({
          data: [{ id: "llama-3.3-70b-versatile" }, { id: "openai/gpt-oss-120b" }],
        });
      }
      return jsonResponse({ error: { message: "model not found" } }, 404);
    });

    const error = await expectFailure(
      new GroqGrader("k", "mixtral-8x7b-retired").grade(await request()),
    );
    expect(error.message).toContain("mixtral-8x7b-retired");
    expect(error.message).toContain("llama-3.3-70b-versatile");
    expect(error.message).toContain("GROQ_MODEL");
  });

  it("maps a content filter to a refusal", async () => {
    stubFetch(() => chat("", "content_filter"));
    const error = await expectFailure(new GroqGrader("k").grade(await request()));
    expect(error.reason).toBe("refusal");
  });

  it("maps network and timeout failures", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect((await expectFailure(new GroqGrader("k").grade(await request()))).reason).toBe(
      "network",
    );

    stubFetch(() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    expect((await expectFailure(new GroqGrader("k").grade(await request()))).reason).toBe(
      "timeout",
    );
  });

  it("returns truncated output rather than throwing, so repair can handle it", async () => {
    stubFetch(() => chat('{"questions": [', "length"));
    const response = await new GroqGrader("k").grade(await request());
    expect(response.raw).toBe('{"questions": [');
  });
});

describe.skipIf(!hasRubric)("Groq is honest about not seeing the diagrams", () => {
  it("never sends the PDF, because the endpoint cannot read one", async () => {
    const spy = stubFetch(() => chat("{}"));
    await new GroqGrader("k").grade(await request());

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("JVBERi"); // base64 of "%PDF"
    expect(serialised).not.toContain("answerPdfBase64");
  });

  it("tells the model it cannot see diagrams and must flag them for review", async () => {
    const spy = stubFetch(() => chat("{}"));
    await new GroqGrader("k").grade(await request());

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    const prompt = body.messages[1].content as string;

    // This is the branch of the prompt that keeps a text-only grader honest.
    expect(prompt).toMatch(/Diagrams are NOT included/i);
    expect(prompt).toMatch(/lower the confidence/i);
    expect(prompt).toMatch(/human review/i);
    expect(prompt).not.toMatch(/attached above as a PDF/i);
  });
});

describe.skipIf(!hasRubric)("json_object compatibility", () => {
  it("mentions JSON in the messages, which OpenAI-compatible servers require", async () => {
    // Groq returns 400 for response_format json_object unless the word appears.
    const spy = stubFetch(() => chat("{}"));
    await new GroqGrader("k").grade(await request());

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    const messages = body.messages.map((m: { content: string }) => m.content).join("\n");
    expect(messages.toLowerCase()).toContain("json");
  });
});
