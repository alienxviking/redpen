import { useEffect, useState } from "react";
import type { Annotation, AnnotationType } from "../lib/types.js";
import { ANNOTATION_COLOURS, ANNOTATION_LABELS } from "../lib/types.js";

/**
 * The annotation layer as a list, with an inline editor for the selected note.
 *
 * Every edit here is a PATCH against the annotation alone. Nothing in this component
 * can change a mark or trigger a re-grade - that separation is the requirement.
 */

const TYPES: AnnotationType[] = ["error", "missing", "spelling", "layout", "praise"];

interface Props {
  annotations: Annotation[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onUpdate(id: string, patch: Partial<Annotation>): Promise<void>;
  onDelete(id: string): Promise<void>;
  drawingType: AnnotationType | null;
  onDrawingTypeChange(type: AnnotationType | null): void;
  busy: boolean;
}

export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
  onUpdate,
  onDelete,
  drawingType,
  onDrawingTypeChange,
  busy,
}: Props) {
  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="annotation-panel">
      <div className="annotation-toolbar">
        <h3>Annotations ({annotations.length})</h3>
        <div className="add-controls">
          <label className="muted small" htmlFor="draw-type">
            Add
          </label>
          <select
            id="draw-type"
            value={drawingType ?? ""}
            onChange={(event) =>
              onDrawingTypeChange((event.target.value || null) as AnnotationType | null)
            }
          >
            <option value="">off</option>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {ANNOTATION_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {annotations.length === 0 && <p className="muted small">No annotations on this paper.</p>}

      <ul className="annotation-items">
        {annotations.map((annotation) => (
          <li
            key={annotation.id}
            className={`annotation-item${annotation.id === selectedId ? " selected" : ""}`}
            onClick={() => onSelect(annotation.id)}
          >
            <span className="dot" style={{ background: ANNOTATION_COLOURS[annotation.type] }} />
            <div className="annotation-item-body">
              <div className="annotation-item-head">
                <strong>{ANNOTATION_LABELS[annotation.type]}</strong>
                {!annotation.anchored && (
                  <span className="chip" title="This note could not be placed on the page">
                    margin note
                  </span>
                )}
                {annotation.origin === "user" && <span className="chip">yours</span>}
                {annotation.edited && <span className="chip">edited</span>}
              </div>
              <p className="annotation-comment">{annotation.comment}</p>
              {annotation.quote && <p className="annotation-quote">“{annotation.quote}”</p>}
            </div>
          </li>
        ))}
      </ul>

      {selected && (
        <AnnotationEditor
          key={selected.id}
          annotation={selected}
          busy={busy}
          onUpdate={(patch) => onUpdate(selected.id, patch)}
          onDelete={() => onDelete(selected.id)}
        />
      )}
    </div>
  );
}

function AnnotationEditor({
  annotation,
  onUpdate,
  onDelete,
  busy,
}: {
  annotation: Annotation;
  onUpdate(patch: Partial<Annotation>): Promise<void>;
  onDelete(): Promise<void>;
  busy: boolean;
}) {
  const [type, setType] = useState(annotation.type);
  const [comment, setComment] = useState(annotation.comment);
  const [correction, setCorrection] = useState(annotation.correction ?? "");
  const [quote, setQuote] = useState(annotation.quote);
  const [saved, setSaved] = useState(false);

  // Dragging a box on the page updates the annotation underneath us; keep the form
  // in step without discarding whatever the teacher is currently typing.
  useEffect(() => {
    setType(annotation.type);
  }, [annotation.type]);

  const dirty =
    type !== annotation.type ||
    comment !== annotation.comment ||
    correction !== (annotation.correction ?? "") ||
    quote !== annotation.quote;

  const save = async () => {
    await onUpdate({
      type,
      comment,
      correction: correction.trim() === "" ? null : correction,
      quote,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="annotation-editor">
      <h4>Edit annotation</h4>

      <label>
        Type
        <select value={type} onChange={(e) => setType(e.target.value as AnnotationType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {ANNOTATION_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <label>
        Comment
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>

      <label>
        Correction
        <textarea
          rows={2}
          value={correction}
          placeholder="What the student should have written"
          onChange={(e) => setCorrection(e.target.value)}
        />
      </label>

      <label>
        Quoted text
        <textarea rows={2} value={quote} onChange={(e) => setQuote(e.target.value)} />
        <span className="muted small">
          Changing the quote re-locates the box in the paper. It does not re-grade.
        </span>
      </label>

      <div className="editor-actions">
        <button type="button" className="primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onDelete}>
          Delete
        </button>
      </div>

      <p className="muted small">
        Drag the box on the page to move it, or its corner handle to resize.
        {annotation.anchored
          ? ` Located automatically (match ${Math.round(annotation.anchorScore * 100)}%).`
          : " This note has no position, so it is listed on the summary sheet."}
      </p>
    </div>
  );
}
