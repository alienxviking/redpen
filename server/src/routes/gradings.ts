import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { loadRubric } from "../domain/rubric.js";
import { annotationCreateSchema, annotationPatchSchema } from "../domain/schema.js";
import type { Annotation } from "../domain/types.js";
import { GradingFailedError, gradeAnswer } from "../services/grading/grader.js";
import { anchorQuote } from "../services/grading/anchor.js";
import { buildAnnotatedPdf } from "../services/pdf/annotatePdf.js";
import {
  deleteGrading,
  getDocument,
  getGrading,
  listGradings,
  readDocumentBytes,
  readExtraction,
  saveGrading,
  updateAnnotations,
} from "../services/store/store.js";

export const gradingsRouter = Router();

const gradeRequestSchema = z.object({
  answerId: z.string().min(1),
  questionPaperId: z.string().optional(),
  modelAnswerId: z.string().optional(),
});

/** Grade an uploaded answer paper. */
gradingsRouter.post("/", async (req, res, next) => {
  try {
    const parsed = gradeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", detail: parsed.error.issues });
    }

    const answerDocument = await getDocument(parsed.data.answerId);
    if (!answerDocument) {
      return res.status(404).json({ error: "Answer document not found." });
    }

    const [rubric, answerDoc, answerPdf] = await Promise.all([
      loadRubric(),
      readExtraction(answerDocument),
      readDocumentBytes(answerDocument),
    ]);

    let questionPaperText: string | undefined;
    if (parsed.data.questionPaperId) {
      const qp = await getDocument(parsed.data.questionPaperId);
      if (qp) questionPaperText = (await readExtraction(qp)).text;
    }

    let modelAnswerText: string | undefined;
    if (parsed.data.modelAnswerId) {
      const ma = await getDocument(parsed.data.modelAnswerId);
      if (ma) modelAnswerText = (await readExtraction(ma)).text;
    }

    const record = await gradeAnswer({
      rubric,
      answerDoc,
      answerPdf,
      answerFilename: answerDocument.filename,
      ...(questionPaperText ? { questionPaperText } : {}),
      ...(modelAnswerText ? { modelAnswerText } : {}),
      documents: {
        answerId: answerDocument.id,
        ...(parsed.data.questionPaperId ? { questionPaperId: parsed.data.questionPaperId } : {}),
        ...(parsed.data.modelAnswerId ? { modelAnswerId: parsed.data.modelAnswerId } : {}),
      },
    });

    await saveGrading(record);
    res.status(201).json(record);
  } catch (error) {
    if (error instanceof GradingFailedError) {
      // The paper could not be graded at all. Say so plainly rather than returning a
      // partial or invented score.
      return res.status(502).json({
        error: "Grading failed and no usable result could be produced.",
        detail: error.message,
      });
    }
    next(error);
  }
});

gradingsRouter.get("/", async (_req, res, next) => {
  try {
    const records = await listGradings();
    res.json({
      gradings: records.map((r) => ({
        id: r.result.id,
        createdAt: r.result.createdAt,
        answerFilename: r.result.answerFilename,
        totalMarks: r.result.totalMarks,
        maxMarks: r.result.maxMarks,
        confidence: r.result.confidence,
        needsHumanReview: r.result.needsHumanReview,
        grader: r.result.grader,
        annotationCount: r.annotations.length,
      })),
    });
  } catch (error) {
    next(error);
  }
});

gradingsRouter.get("/:id", async (req, res, next) => {
  try {
    const record = await getGrading(String(req.params.id));
    if (!record) return res.status(404).json({ error: "Grading not found." });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

gradingsRouter.delete("/:id", async (req, res, next) => {
  try {
    const ok = await deleteGrading(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Grading not found." });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------- annotations */

/**
 * The annotation layer is edited independently of the grade. None of the routes
 * below touch marks, call a model, or invalidate the grading - that is the whole
 * point of storing annotations separately.
 */

gradingsRouter.get("/:id/annotations", async (req, res, next) => {
  try {
    const record = await getGrading(String(req.params.id));
    if (!record) return res.status(404).json({ error: "Grading not found." });
    res.json({ annotations: record.annotations });
  } catch (error) {
    next(error);
  }
});

gradingsRouter.post("/:id/annotations", async (req, res, next) => {
  try {
    const record = await getGrading(String(req.params.id));
    if (!record) return res.status(404).json({ error: "Grading not found." });

    const parsed = annotationCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid annotation", detail: parsed.error.issues });
    }

    const annotation: Annotation = {
      id: randomUUID(),
      questionId: parsed.data.questionId,
      rubricId: parsed.data.rubricId,
      type: parsed.data.type,
      quote: parsed.data.quote,
      comment: parsed.data.comment,
      correction: parsed.data.correction,
      rects: parsed.data.rects,
      anchorScore: 1,
      anchored: true,
      origin: "user",
      edited: false,
    };

    const annotations = await updateAnnotations(record.result.id, (current) => [
      ...current,
      annotation,
    ]);
    res.status(201).json({ annotation, annotations });
  } catch (error) {
    next(error);
  }
});

gradingsRouter.patch("/:id/annotations/:annotationId", async (req, res, next) => {
  try {
    const gradingId = String(req.params.id);
    const annotationId = String(req.params.annotationId);

    const record = await getGrading(gradingId);
    if (!record) return res.status(404).json({ error: "Grading not found." });
    const existing = record.annotations.find((a) => a.id === annotationId);
    if (!existing) return res.status(404).json({ error: "Annotation not found." });

    const parsed = annotationPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid patch", detail: parsed.error.issues });
    }
    const patch = parsed.data;

    // If the quote changed but no rectangles were supplied, re-locate the new quote
    // in the answer paper. This is a text search, not a re-grade.
    let rects = patch.rects ?? existing.rects;
    let anchored = existing.anchored;
    let anchorScore = existing.anchorScore;

    if (patch.quote !== undefined && patch.rects === undefined) {
      const answerDocument = await getDocument(record.result.documents.answerId);
      if (answerDocument) {
        const extraction = await readExtraction(answerDocument);
        const anchor = anchorQuote(extraction, patch.quote);
        if (anchor.anchored) {
          rects = anchor.rects;
          anchored = true;
          anchorScore = anchor.score;
        }
      }
    }
    if (patch.rects !== undefined) {
      anchored = patch.rects.length > 0;
      anchorScore = 1; // a human placed it
    }

    let updated: Annotation | undefined;
    const annotations = await updateAnnotations(gradingId, (current) =>
      current.map((a) => {
        if (a.id !== annotationId) return a;
        updated = {
          ...a,
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
          ...(patch.correction !== undefined ? { correction: patch.correction } : {}),
          ...(patch.quote !== undefined ? { quote: patch.quote } : {}),
          rects,
          anchored,
          anchorScore,
          edited: true,
        };
        return updated;
      }),
    );

    res.json({ annotation: updated, annotations });
  } catch (error) {
    next(error);
  }
});

gradingsRouter.delete("/:id/annotations/:annotationId", async (req, res, next) => {
  try {
    const gradingId = String(req.params.id);
    const annotationId = String(req.params.annotationId);
    const record = await getGrading(gradingId);
    if (!record) return res.status(404).json({ error: "Grading not found." });
    if (!record.annotations.some((a) => a.id === annotationId)) {
      return res.status(404).json({ error: "Annotation not found." });
    }
    const annotations = await updateAnnotations(gradingId, (current) =>
      current.filter((a) => a.id !== annotationId),
    );
    res.json({ annotations });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ export */

gradingsRouter.get("/:id/export", async (req, res, next) => {
  try {
    const record = await getGrading(String(req.params.id));
    if (!record) return res.status(404).json({ error: "Grading not found." });

    const answerDocument = await getDocument(record.result.documents.answerId);
    if (!answerDocument) {
      return res.status(409).json({ error: "The original answer paper is no longer available." });
    }

    const original = await readDocumentBytes(answerDocument);
    const annotated = await buildAnnotatedPdf(original, record.result, record.annotations, {
      includeSummary: req.query.summary !== "false",
    });

    const name = answerDocument.filename.replace(/\.pdf$/i, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(name)}-annotated.pdf"`,
    );
    res.send(Buffer.from(annotated));
  } catch (error) {
    next(error);
  }
});
