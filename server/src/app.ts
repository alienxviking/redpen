import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config, resolveProvider, type ProviderName } from "./config.js";
import { documentsRouter, rubricRouter } from "./routes/documents.js";
import { gradingsRouter } from "./routes/gradings.js";

/** The model id the configured grader will actually use. */
function activeModelName(provider: ProviderName): string {
  if (provider === "anthropic") return config.model;
  if (provider === "gemini") return config.geminiModel;
  if (provider === "groq") return config.groqModel;
  return "offline-heuristic-v1";
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    const grader = resolveProvider();
    res.json({
      ok: true,
      grader,
      // Report the model that will actually run, not whichever one is configured.
      model: activeModelName(grader),
      // Surfaced so the UI can tell the user it is running on the offline grader
      // instead of silently presenting heuristic marks as model marks.
      degraded: grader === "mock",
    });
  });

  app.use("/api/documents", documentsRouter);
  app.use("/api/rubric", rubricRouter);
  app.use("/api/gradings", gradingsRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: `Upload rejected: ${error.message}` });
    }
    console.error("[gradesense] unhandled error:", error);
    res.status(500).json({
      error: "Internal server error",
      detail: error instanceof Error ? error.message : String(error),
    });
  });

  return app;
}
