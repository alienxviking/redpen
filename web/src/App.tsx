import { useCallback, useEffect, useState } from "react";
import { AnnotationList } from "./components/AnnotationList.js";
import { PdfViewer } from "./components/PdfViewer.js";
import { ScorePanel } from "./components/ScorePanel.js";
import { UploadPanel } from "./components/UploadPanel.js";
import { api, ApiError } from "./lib/api.js";
import type {
  Annotation,
  AnnotationType,
  GradingRecord,
  Health,
  HistoryEntry,
  Rect,
} from "./lib/types.js";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [record, setRecord] = useState<GradingRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawingType, setDrawingType] = useState<AnnotationType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"upload" | "result">("upload");

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.history());
    } catch {
      // History is a convenience; a failure here must not block marking.
    }
  }, []);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => setHealth(null));
    void refreshHistory();
  }, [refreshHistory]);

  const open = useCallback(
    async (id: string) => {
      setError(null);
      setBusy(true);
      try {
        const loaded = await api.getGrading(id);
        setRecord(loaded);
        setSelectedId(null);
        setView("result");
        await refreshHistory();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "Could not load that grading.");
      } finally {
        setBusy(false);
      }
    },
    [refreshHistory],
  );

  /**
   * All annotation mutations funnel through here. Note what is absent: nothing
   * re-grades, and `record.result` is never rewritten - only the annotation layer.
   */
  const applyAnnotations = (annotations: Annotation[]) => {
    setRecord((current) => (current ? { ...current, annotations } : current));
  };

  const updateAnnotation = async (id: string, patch: Partial<Annotation>) => {
    if (!record) return;
    setBusy(true);
    try {
      const { annotations } = await api.patchAnnotation(record.result.id, id, {
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
        ...(patch.correction !== undefined ? { correction: patch.correction } : {}),
        ...(patch.quote !== undefined ? { quote: patch.quote } : {}),
        ...(patch.rects !== undefined ? { rects: patch.rects } : {}),
      });
      applyAnnotations(annotations);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not save that change.");
    } finally {
      setBusy(false);
    }
  };

  const moveAnnotation = (id: string, rects: Rect[]) => {
    void updateAnnotation(id, { rects });
  };

  const createAnnotation = async (rect: Rect) => {
    if (!record || !drawingType) return;
    setBusy(true);
    try {
      const { annotation, annotations } = await api.createAnnotation(record.result.id, {
        questionId: record.result.questions[0]?.questionId ?? "q1",
        type: drawingType,
        comment: "New note",
        rects: [rect],
      });
      applyAnnotations(annotations);
      setSelectedId(annotation.id);
      setDrawingType(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not add that annotation.");
    } finally {
      setBusy(false);
    }
  };

  const removeAnnotation = async (id: string) => {
    if (!record) return;
    setBusy(true);
    try {
      const { annotations } = await api.deleteAnnotation(record.result.id, id);
      applyAnnotations(annotations);
      setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not delete that annotation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>RedPen</h1>
          <span className="muted small">Explainable marking with on-page annotation</span>
        </div>

        <div className="header-actions">
          {health && (
            <span className={`badge ${health.degraded ? "warn" : "ok"}`} title={health.model}>
              {health.degraded ? "Offline grader" : `Model: ${health.model}`}
            </span>
          )}
          <button
            type="button"
            className={view === "upload" ? "active" : ""}
            onClick={() => setView("upload")}
          >
            New paper
          </button>
          {record && (
            <>
              <button
                type="button"
                className={view === "result" ? "active" : ""}
                onClick={() => setView("result")}
              >
                Marking
              </button>
              <a className="button primary" href={api.exportUrl(record.result.id)}>
                Export annotated PDF
              </a>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="error banner" onClick={() => setError(null)}>
          {error} <span className="muted small">(click to dismiss)</span>
        </div>
      )}

      {view === "upload" ? (
        <main className="layout-upload">
          <section className="card">
            <h2>Upload</h2>
            <UploadPanel
              busy={busy}
              setBusy={setBusy}
              onGraded={(id) => {
                void open(id);
              }}
            />
          </section>

          <section className="card">
            <h2>History</h2>
            {history.length === 0 && <p className="muted small">Nothing graded yet.</p>}
            <ul className="history">
              {history.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="history-row" onClick={() => void open(entry.id)}>
                    <span className="history-score">
                      {entry.totalMarks}/{entry.maxMarks}
                    </span>
                    <span className="history-name">{entry.answerFilename}</span>
                    <span className="muted small">
                      {new Date(entry.createdAt).toLocaleString()} · {entry.annotationCount} notes
                      {entry.needsHumanReview && " · needs review"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </main>
      ) : record ? (
        <main className="layout-result">
          <div className="column viewer-column">
            <PdfViewer
              fileUrl={api.documentUrl(record.result.documents.answerId)}
              annotations={record.annotations}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={moveAnnotation}
              onCreate={(rect) => void createAnnotation(rect)}
              drawingType={drawingType}
            />
          </div>

          <div className="column side-column">
            <AnnotationList
              annotations={record.annotations}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onUpdate={updateAnnotation}
              onDelete={removeAnnotation}
              drawingType={drawingType}
              onDrawingTypeChange={setDrawingType}
              busy={busy}
            />
            <ScorePanel
              result={record.result}
              annotations={record.annotations}
              onFocusAnnotation={setSelectedId}
            />
          </div>
        </main>
      ) : null}
    </div>
  );
}
