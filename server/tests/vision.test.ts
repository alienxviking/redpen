import { describe, expect, it } from "vitest";
import {
  documentFromVision,
  parseVisionPages,
  visionExtract,
  type VisionPage,
  type VisionTranscriber,
} from "../src/services/pdf/visionExtract.js";
import { anchorQuote } from "../src/services/grading/anchor.js";
import { gradeAnswer } from "../src/services/grading/grader.js";
import { MockGrader } from "../src/services/llm/mock.js";
import { readFixture, rubric } from "./helpers.js";

/**
 * Reading a handwritten or scanned paper.
 *
 * All of this runs against a stub transcriber, so the suite stays offline. What is
 * being tested is the part that has to be right whatever the model returns: the shapes
 * it arrives in, the coordinate conversion, and the fact that a transcription-sourced
 * document flows through anchoring and grading exactly like a text-layer one.
 */

const A4 = { width: 595.28, height: 841.89 };

function stubTranscriber(pages: VisionPage[] | (() => never)): VisionTranscriber {
  return {
    model: "stub-vision",
    async transcribe() {
      if (typeof pages === "function") pages();
      return pages as VisionPage[];
    },
  };
}

describe("reading the model's transcription", () => {
  it("accepts the documented shape", () => {
    const pages = parseVisionPages(
      JSON.stringify({
        pages: [{ page: 1, lines: [{ text: "Question 1", box_2d: [85, 93, 98, 194] }] }],
      }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines[0]!.text).toBe("Question 1");
    expect(pages[0]!.lines[0]!.box_2d).toEqual([85, 93, 98, 194]);
  });

  it("unwraps a box that arrived nested", () => {
    // Observed in practice: "box_2d": [[61, 94, 72, 528]]
    const pages = parseVisionPages(
      '{"pages":[{"page":1,"lines":[{"text":"Name: A Mehta","box_2d":[[61,94,72,528]]}]}]}',
    );
    expect(pages[0]!.lines[0]!.box_2d).toEqual([61, 94, 72, 528]);
  });

  it("accepts numbers sent as strings", () => {
    const pages = parseVisionPages(
      '{"pages":[{"page":1,"lines":[{"text":"x","box_2d":["10","20","30","40"]}]}]}',
    );
    expect(pages[0]!.lines[0]!.box_2d).toEqual([10, 20, 30, 40]);
  });

  it("treats a bare lines array as a single page", () => {
    const pages = parseVisionPages('{"lines":[{"text":"only page","box_2d":[1,2,3,4]}]}');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page).toBe(1);
  });

  it("reads JSON out of a fenced block or surrounding prose", () => {
    const body = '{"pages":[{"page":1,"lines":[{"text":"hi","box_2d":[1,2,3,4]}]}]}';
    expect(parseVisionPages("```json\n" + body + "\n```")[0]!.lines).toHaveLength(1);
    expect(parseVisionPages(`Here you go: ${body} Hope that helps.`)[0]!.lines).toHaveLength(1);
  });

  it("salvages the lines that arrived when the reply was truncated", () => {
    // A dense page can hit the token ceiling mid-object. Losing the tail is acceptable;
    // losing the whole page is not.
    const truncated =
      '{"pages":[{"page":1,"lines":[' +
      '{"text":"first line","box_2d":[10,20,30,400]},' +
      '{"text":"second line","box_2d":[40,20,60,400]},' +
      '{"text":"third line half-wri';
    const pages = parseVisionPages(truncated);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines.map((l) => l.text)).toEqual(["first line", "second line"]);
  });

  it("attributes salvaged lines to the right page", () => {
    const truncated =
      '{"pages":[' +
      '{"page":1,"lines":[{"text":"on page one","box_2d":[10,20,30,400]}]},' +
      '{"page":2,"lines":[{"text":"on page two","box_2d":[10,20,30,400]},{"text":"trunc';
    const pages = parseVisionPages(truncated);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[1]!.lines[0]!.text).toBe("on page two");
  });

  it("returns nothing for a reply with no transcription in it", () => {
    expect(parseVisionPages("I cannot read this page.")).toEqual([]);
    expect(parseVisionPages("")).toEqual([]);
    expect(parseVisionPages('{"pages":[]}')).toEqual([]);
  });
});

describe("converting boxes into positioned tokens", () => {
  it("flips the y axis and scales into PDF points", () => {
    // The model measures y downwards from the top; PDF space measures it upwards.
    const doc = documentFromVision(
      [{ page: 1, lines: [{ text: "Question 1", box_2d: [100, 100, 200, 500] }] }],
      [A4],
    )!;
    const token = doc.tokens[0]!;

    expect(token.x).toBeCloseTo(0.1 * A4.width, 1);
    expect(token.w).toBeCloseTo(0.4 * A4.width, 1);
    // ymax 200/1000 from the top => 0.8 of the height up from the bottom.
    expect(token.y).toBeCloseTo(0.8 * A4.height, 1);
    expect(token.h).toBeCloseTo(0.1 * A4.height, 1);
    expect(doc.source).toBe("vision");
    expect(doc.isBlank).toBe(false);
  });

  it("gives every token offsets that index back into the document text", () => {
    const doc = documentFromVision(
      [
        {
          page: 1,
          lines: [
            { text: "first", box_2d: [10, 10, 20, 200] },
            { text: "second", box_2d: [30, 10, 40, 200] },
          ],
        },
      ],
      [A4],
    )!;
    // This is the join key the whole annotation feature depends on.
    for (const token of doc.tokens) {
      expect(doc.text.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it("orders lines top to bottom regardless of the order they arrived in", () => {
    const doc = documentFromVision(
      [
        {
          page: 1,
          lines: [
            { text: "lower", box_2d: [500, 10, 520, 200] },
            { text: "upper", box_2d: [100, 10, 120, 200] },
          ],
        },
      ],
      [A4],
    )!;
    expect(doc.tokens.map((t) => t.text)).toEqual(["upper", "lower"]);
  });

  it("keeps boxes inside the page even when the model overshoots", () => {
    const doc = documentFromVision(
      [{ page: 1, lines: [{ text: "runs off", box_2d: [-50, -80, 1200, 1400] }] }],
      [A4],
    )!;
    const t = doc.tokens[0]!;
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.x + t.w).toBeLessThanOrEqual(A4.width + 0.01);
    expect(t.y + t.h).toBeLessThanOrEqual(A4.height + 0.01);
  });

  it("places multi-page transcriptions on the right pages", () => {
    const doc = documentFromVision(
      [
        { page: 1, lines: [{ text: "page one", box_2d: [10, 10, 20, 200] }] },
        { page: 2, lines: [{ text: "page two", box_2d: [10, 10, 20, 200] }] },
      ],
      [A4, A4],
    )!;
    expect(doc.pages).toHaveLength(2);
    expect(doc.tokens.map((t) => t.page)).toEqual([0, 1]);
  });

  it("returns null rather than an empty document", () => {
    expect(documentFromVision([], [A4])).toBeNull();
    expect(documentFromVision([{ page: 1, lines: [] }], [A4])).toBeNull();
    expect(documentFromVision([{ page: 1, lines: [{ text: "x", box_2d: [1, 2, 3, 4] }] }], []))
      .toBeNull();
  });
});

describe("the extractor's failure posture", () => {
  it("explains itself when no vision model is configured", async () => {
    const outcome = await visionExtract(Buffer.from("%PDF"), [A4], "application/pdf", null);
    expect(outcome.document).toBeNull();
    expect(outcome.problem).toMatch(/GEMINI_API_KEY/);
  });

  it("reports a transcription failure instead of throwing", async () => {
    const outcome = await visionExtract(
      Buffer.from("%PDF"),
      [A4],
      "application/pdf",
      stubTranscriber(() => {
        throw new Error("503 high demand");
      }),
    );
    expect(outcome.document).toBeNull();
    expect(outcome.problem).toContain("503");
  });

  it("reports an empty transcription instead of inventing text", async () => {
    const outcome = await visionExtract(
      Buffer.from("%PDF"),
      [A4],
      "application/pdf",
      stubTranscriber([{ page: 1, lines: [] }]),
    );
    expect(outcome.document).toBeNull();
    expect(outcome.problem).toBeTruthy();
  });
});

describe("a transcribed paper marks like any other", () => {
  /** The handwritten sentences a marker needs to find, with plausible line boxes. */
  const handwritten: VisionPage[] = [
    {
      page: 1,
      lines: [
        { text: "Question 1", box_2d: [80, 90, 95, 200] },
        {
          text: "In my circut the battery, switch, resistor, bulb and the amether are all",
          box_2d: [110, 90, 124, 880],
        },
        { text: "joined one after another in series in the main loop.", box_2d: [128, 90, 142, 700] },
        {
          text: "The voltmeter is also connected in series with the bulb so that it can",
          box_2d: [150, 90, 164, 870],
        },
        { text: "measure the voltage of the bulb.", box_2d: [168, 90, 182, 480] },
        {
          text: "If the resistance of the circut is increased then the current also increases.",
          box_2d: [200, 90, 214, 900],
        },
      ],
    },
  ];

  it("anchors quotes onto the transcribed lines", async () => {
    const doc = documentFromVision(handwritten, [A4])!;
    const anchor = anchorQuote(doc, "The voltmeter is also connected in series with the bulb");

    expect(anchor.anchored).toBe(true);
    expect(anchor.rects.length).toBeGreaterThan(0);
    expect(anchor.rects[0]!.page).toBe(0);
    // Boxes must land where the writing is, not at the top of the page.
    expect(anchor.rects[0]!.y).toBeLessThan(A4.height * 0.9);
    expect(anchor.rects[0]!.y).toBeGreaterThan(A4.height * 0.7);
  });

  it("grades it and flags that the marks came from a transcription", async () => {
    const doc = documentFromVision(handwritten, [A4])!;
    const { result, annotations } = await gradeAnswer({
      rubric: await rubric(),
      answerDoc: doc,
      answerPdf: await readFixture("student-answer.pdf"),
      answerFilename: "handwritten.pdf",
      documents: { answerId: "vision" },
      provider: new MockGrader(),
    });

    // The substantive error in the handwriting was found and boxed.
    const voltmeter = annotations.find((a) => /voltmeter/i.test(a.quote));
    expect(voltmeter).toBeDefined();
    expect(voltmeter!.anchored).toBe(true);
    expect(voltmeter!.rects.length).toBeGreaterThan(0);

    // And the grade is honest about where its words came from.
    const flag = result.flags.find((f) => f.code === "ocr_extraction");
    expect(flag).toBeDefined();
    expect(flag!.message).toMatch(/transcrib/i);
    expect(result.needsHumanReview).toBe(true);
  });

  it("does not flag a paper that had a real text layer", async () => {
    const { result } = await gradeAnswer({
      rubric: await rubric(),
      answerDoc: {
        ...documentFromVision(handwritten, [A4])!,
        source: "text-layer",
      },
      answerFilename: "typed.pdf",
      documents: { answerId: "typed" },
      provider: new MockGrader(),
    });
    expect(result.flags.some((f) => f.code === "ocr_extraction")).toBe(false);
  });
});
