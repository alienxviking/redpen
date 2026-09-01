import type {
  Annotation,
  AnnotationType,
  GradingRecord,
  Health,
  HistoryEntry,
  Rect,
  StoredDocument,
} from "./types.js";

/**
 * Typed client for the grading API.
 *
 * Every call surfaces the server's own error message rather than a generic failure -
 * a teacher needs to know *why* a paper would not grade, not just that it did not.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let detail: unknown;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") message = body.error;
      detail = body?.detail;
    } catch {
      // Non-JSON error body; keep the status-based message.
    }
    throw new ApiError(message, response.status, detail);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async health(): Promise<Health> {
    return json(await fetch("/api/health"));
  },

  async uploadDocument(
    file: File,
    kind: StoredDocument["kind"],
  ): Promise<{ document: StoredDocument; warning?: string }> {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file);
    return json(await fetch("/api/documents", { method: "POST", body: form }));
  },

  async grade(input: {
    answerId: string;
    questionPaperId?: string;
    modelAnswerId?: string;
  }): Promise<GradingRecord> {
    return json(
      await fetch("/api/gradings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },

  async history(): Promise<HistoryEntry[]> {
    const body = await json<{ gradings: HistoryEntry[] }>(await fetch("/api/gradings"));
    return body.gradings;
  },

  async getGrading(id: string): Promise<GradingRecord> {
    return json(await fetch(`/api/gradings/${id}`));
  },

  async patchAnnotation(
    gradingId: string,
    annotationId: string,
    patch: Partial<{
      type: AnnotationType;
      comment: string;
      correction: string | null;
      quote: string;
      rects: Rect[];
    }>,
  ): Promise<{ annotation: Annotation; annotations: Annotation[] }> {
    return json(
      await fetch(`/api/gradings/${gradingId}/annotations/${annotationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },

  async createAnnotation(
    gradingId: string,
    body: {
      questionId: string;
      type: AnnotationType;
      comment: string;
      correction?: string | null;
      quote?: string;
      rects: Rect[];
    },
  ): Promise<{ annotation: Annotation; annotations: Annotation[] }> {
    return json(
      await fetch(`/api/gradings/${gradingId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async deleteAnnotation(
    gradingId: string,
    annotationId: string,
  ): Promise<{ annotations: Annotation[] }> {
    return json(
      await fetch(`/api/gradings/${gradingId}/annotations/${annotationId}`, {
        method: "DELETE",
      }),
    );
  },

  documentUrl(documentId: string): string {
    return `/api/documents/${documentId}/file`;
  },

  exportUrl(gradingId: string): string {
    return `/api/gradings/${gradingId}/export`;
  },
};
