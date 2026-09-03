import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { loadRubric } from "../domain/rubric.js";
import { extractPdf } from "../services/pdf/extractText.js";
import { assessTextLayer } from "../services/pdf/textQuality.js";
import { visionExtract } from "../services/pdf/visionExtract.js";
import {
  getDocument,
  listDocuments,
  readDocumentBytes,
  saveDocument,
} from "../services/store/store.js";
import type { StoredDocument } from "../domain/types.js";

const KINDS = new Set<StoredDocument["kind"]>(["question-paper", "answer", "model-answer"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

export const documentsRouter = Router();

/**
 * Upload a PDF and extract its positioned text immediately.
 *
 * Extraction happens at upload rather than at grading time so that a file which
 * cannot be read is rejected while the user is still looking at the upload screen,
 * and so the same extraction is reused by grading, re-anchoring and export.
 */
documentsRouter.post("/", upload.single("file"), async (req, res, next) => {
  try {
    const file = req.file;
    const kind = String(req.body?.kind ?? "answer") as StoredDocument["kind"];

    if (!file) {
      return res.status(400).json({ error: "No file uploaded. Send a PDF as the 'file' field." });
    }
    if (!KINDS.has(kind)) {
      return res.status(400).json({ error: `Unknown document kind "${kind}".` });
    }
    if (file.mimetype !== "application/pdf" && !file.originalname.toLowerCase().endsWith(".pdf")) {
      return res.status(415).json({ error: "Only PDF files are supported." });
    }

    let extraction;
    try {
      extraction = await extractPdf(file.buffer);
    } catch (error) {
      return res.status(422).json({
        error: "That file could not be read as a PDF.",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    /*
     * A scan or a handwritten script needs reading from the page image rather than the
     * text layer. Two cases qualify, and the second is the one that bites: a page with
     * no text at all, and a page whose text layer is present but untrustworthy - phone
     * scanner apps embed their own OCR, so a handwritten script arrives already
     * "transcribed" into garbage that would otherwise be marked as if the student wrote
     * it. `forceVision` lets a user insist regardless.
     *
     * The vision extractor returns the same positioned-token structure as the text-layer
     * path, so nothing downstream changes. pdf.js still reports real page geometry here,
     * which is what keeps the transcribed boxes honest.
     */
    const quality = assessTextLayer(extraction.text);
    const forceVision = String(req.body?.forceVision ?? "") === "true";
    let visionProblem: string | undefined;
    let transcribed = false;
    let transcribeReason: string | undefined;

    if (extraction.isBlank) {
      transcribeReason = "the page has no text layer";
    } else if (forceVision) {
      transcribeReason = "transcription was requested explicitly";
    } else if (quality.unreliable) {
      transcribeReason = `the embedded text layer looks unreliable (${quality.reasons.join("; ")})`;
    }

    if (transcribeReason) {
      const outcome = await visionExtract(
        file.buffer,
        extraction.pages.map((p) => ({ width: p.width, height: p.height })),
        file.mimetype || "application/pdf",
      );
      if (outcome.document) {
        extraction = outcome.document;
        transcribed = true;
      } else {
        visionProblem = outcome.problem;
      }
    }

    const doc = await saveDocument({
      kind,
      filename: file.originalname,
      mimeType: file.mimetype || "application/pdf",
      bytes: file.buffer,
      extraction,
    });

    res.status(201).json({
      document: doc,
      transcribed,
      textLayerScore: quality.score,
      warning: transcribed
        ? `Read from the page image because ${transcribeReason}. ${extraction.tokens.length} lines were transcribed; marks will be based on that transcription and flagged for review.`
        : doc.isBlank
          ? `No text could be extracted from this PDF.${visionProblem ? ` ${visionProblem}` : ""} It will need OCR or manual marking.`
          : transcribeReason
            ? `This paper's text layer looks unreliable and it could not be transcribed either.${visionProblem ? ` ${visionProblem}` : ""} Marks would be based on poor text - check the paper by hand.`
            : undefined,
    });
  } catch (error) {
    next(error);
  }
});

documentsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ documents: await listDocuments() });
  } catch (error) {
    next(error);
  }
});

/** The raw PDF, used by the viewer in the web app. */
documentsRouter.get("/:id/file", async (req, res, next) => {
  try {
    const doc = await getDocument(String(req.params.id));
    if (!doc) return res.status(404).json({ error: "Document not found." });
    const bytes = await readDocumentBytes(doc);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename)}"`);
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

export const rubricRouter = Router();

rubricRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ rubric: await loadRubric() });
  } catch (error) {
    next(error);
  }
});
