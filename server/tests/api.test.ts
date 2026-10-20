import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { fixture, readFixture } from "./helpers.js";

/**
 * End-to-end over the HTTP API: upload, grade, edit the annotation layer, export.
 *
 * The data directory is redirected to a temp folder and the grader is pinned to the
 * offline provider, so the suite never touches the developer's data or the network
 * even if an API key happens to be present in the environment.
 */

let app: Express;
let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "redpen-test-"));
  process.env.REDPEN_DATA_DIR = dataDir;
  process.env.GRADER_PROVIDER = "mock";
  delete process.env.ANTHROPIC_API_KEY;
  // Also unset the vision key: a blank upload would otherwise transcribe over the
  // network, making the suite slow and non-deterministic.
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  const { createApp } = await import("../src/app.js");
  app = createApp();
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function uploadAnswer(name = "student-answer.pdf") {
  const response = await request(app)
    .post("/api/documents")
    .field("kind", "answer")
    .attach("file", fixture(name))
    .expect(201);
  return response.body.document as { id: string; filename: string; charCount: number };
}

describe("health and rubric", () => {
  it("reports which grader is in use", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.grader).toBe("mock");
    expect(response.body.degraded).toBe(true);
  });

  it("serves the rubric the marks are computed against", async () => {
    const response = await request(app).get("/api/rubric").expect(200);
    expect(response.body.rubric.maxMarks).toBe(15);
    expect(response.body.rubric.questions).toHaveLength(3);
  });
});

describe("uploads", () => {
  it("accepts a PDF and extracts its text", async () => {
    const document = await uploadAnswer();
    expect(document.filename).toBe("student-answer.pdf");
    expect(document.charCount).toBeGreaterThan(2000);
  });

  it("warns rather than fails when a PDF has no extractable text", async () => {
    const response = await request(app)
      .post("/api/documents")
      .field("kind", "answer")
      .attach("file", fixture("cases/answer-blank.pdf"))
      .expect(201);
    expect(response.body.document.isBlank).toBe(true);
    expect(response.body.warning).toMatch(/OCR/i);
  });

  it("rejects a file that is not a PDF", async () => {
    await request(app)
      .post("/api/documents")
      .field("kind", "answer")
      .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" })
      .expect(415);
  });

  it("rejects a request with no file", async () => {
    await request(app).post("/api/documents").field("kind", "answer").expect(400);
  });

  it("rejects an unknown document kind", async () => {
    await request(app)
      .post("/api/documents")
      .field("kind", "homework")
      .attach("file", fixture("student-answer.pdf"))
      .expect(400);
  });
});

describe("grading, annotation editing and export", () => {
  let gradingId: string;
  let answerId: string;

  it("grades an uploaded paper", async () => {
    const document = await uploadAnswer();
    answerId = document.id;

    const response = await request(app)
      .post("/api/gradings")
      .send({ answerId })
      .expect(201);

    const { result, annotations } = response.body;
    gradingId = result.id;

    expect(result.totalMarks).toBe(6);
    expect(result.maxMarks).toBe(15);
    expect(result.questions).toHaveLength(3);
    expect(annotations.length).toBeGreaterThan(5);
    // Every question reports its own marks, evidence and feedback.
    for (const question of result.questions) {
      expect(question.criteria).toHaveLength(5);
      for (const criterion of question.criteria) {
        expect(criterion.feedback.length).toBeGreaterThan(0);
      }
    }
  });

  it("returns 404 for a grading that does not exist", async () => {
    await request(app).get("/api/gradings/does-not-exist").expect(404);
  });

  it("returns 404 when grading a document that does not exist", async () => {
    await request(app).post("/api/gradings").send({ answerId: "nope" }).expect(404);
  });

  it("rejects a grading request with no answer", async () => {
    await request(app).post("/api/gradings").send({}).expect(400);
  });

  it("lists the grading in the history", async () => {
    const response = await request(app).get("/api/gradings").expect(200);
    const entry = response.body.gradings.find((g: { id: string }) => g.id === gradingId);
    expect(entry).toBeDefined();
    expect(entry.totalMarks).toBe(6);
    expect(entry.annotationCount).toBeGreaterThan(0);
  });

  it("edits an annotation's text without changing any marks", async () => {
    const before = (await request(app).get(`/api/gradings/${gradingId}`).expect(200)).body;
    const target = before.annotations[0];

    const response = await request(app)
      .patch(`/api/gradings/${gradingId}/annotations/${target.id}`)
      .send({ comment: "Rewritten by the teacher.", correction: "See page 42." })
      .expect(200);

    expect(response.body.annotation.comment).toBe("Rewritten by the teacher.");
    expect(response.body.annotation.edited).toBe(true);

    const after = (await request(app).get(`/api/gradings/${gradingId}`).expect(200)).body;
    expect(after.result.totalMarks).toBe(before.result.totalMarks);
    expect(after.result.questions).toEqual(before.result.questions);
    // The grade itself was not regenerated.
    expect(after.result.createdAt).toBe(before.result.createdAt);
  });

  it("moves an annotation to new coordinates", async () => {
    const before = (await request(app).get(`/api/gradings/${gradingId}`).expect(200)).body;
    const target = before.annotations[0];
    const moved = [{ page: 0, x: 100, y: 200, w: 180, h: 14 }];

    const response = await request(app)
      .patch(`/api/gradings/${gradingId}/annotations/${target.id}`)
      .send({ rects: moved })
      .expect(200);

    expect(response.body.annotation.rects).toEqual(moved);
    expect(response.body.annotation.anchored).toBe(true);
    expect(response.body.annotation.anchorScore).toBe(1);
  });

  it("re-locates an annotation when its quote is retyped", async () => {
    const before = (await request(app).get(`/api/gradings/${gradingId}`).expect(200)).body;
    const target = before.annotations.find((a: { anchored: boolean }) => a.anchored);

    const response = await request(app)
      .patch(`/api/gradings/${gradingId}/annotations/${target.id}`)
      .send({ quote: "there is a surplus in the market and the price starts falling" })
      .expect(200);

    expect(response.body.annotation.anchored).toBe(true);
    expect(response.body.annotation.rects.length).toBeGreaterThan(0);
  });

  it("adds a teacher's own annotation", async () => {
    const response = await request(app)
      .post(`/api/gradings/${gradingId}/annotations`)
      .send({
        questionId: "q1",
        type: "layout",
        comment: "Draw the diagram larger next time.",
        rects: [{ page: 0, x: 80, y: 300, w: 200, h: 20 }],
      })
      .expect(201);

    expect(response.body.annotation.origin).toBe("user");
    expect(response.body.annotation.type).toBe("layout");
  });

  it("rejects an annotation with no rectangle to draw", async () => {
    await request(app)
      .post(`/api/gradings/${gradingId}/annotations`)
      .send({ questionId: "q1", comment: "floating note", rects: [] })
      .expect(400);
  });

  it("deletes an annotation", async () => {
    const before = (await request(app).get(`/api/gradings/${gradingId}`).expect(200)).body;
    const target = before.annotations[before.annotations.length - 1];

    const response = await request(app)
      .delete(`/api/gradings/${gradingId}/annotations/${target.id}`)
      .expect(200);

    expect(response.body.annotations).toHaveLength(before.annotations.length - 1);
    expect(response.body.annotations.some((a: { id: string }) => a.id === target.id)).toBe(false);

    const after = (await request(app).get(`/api/gradings/${gradingId}`).expect(200)).body;
    expect(after.result.totalMarks).toBe(before.result.totalMarks);
  });

  it("exports an annotated PDF without touching the original", async () => {
    const originalBefore = await readFixture("student-answer.pdf");

    const response = await request(app)
      .get(`/api/gradings/${gradingId}/export`)
      .expect(200)
      .expect("Content-Type", /application\/pdf/);

    const exported = response.body as Buffer;
    expect(exported.subarray(0, 4).toString()).toBe("%PDF");
    // The annotated copy carries the marking, so it is necessarily larger.
    expect(exported.length).toBeGreaterThan(originalBefore.length);

    // The uploaded original on disk is byte-for-byte what was submitted.
    const stored = await request(app).get(`/api/documents/${answerId}/file`).expect(200);
    expect(Buffer.compare(stored.body as Buffer, originalBefore)).toBe(0);

    // And the source fixture was never written to.
    const originalAfter = await readFixture("student-answer.pdf");
    expect(Buffer.compare(originalBefore, originalAfter)).toBe(0);
  });

  it("keeps history readable after a restart", async () => {
    // A fresh app instance reads the same data directory from disk.
    const { resetStoreCache } = await import("../src/services/store/store.js");
    resetStoreCache();
    const { createApp } = await import("../src/app.js");
    const restarted = createApp();

    const response = await request(restarted).get(`/api/gradings/${gradingId}`).expect(200);
    expect(response.body.result.totalMarks).toBe(6);
  });
});
