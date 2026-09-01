import { useRef, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import type { StoredDocument } from "../lib/types.js";

interface Props {
  onGraded(gradingId: string): void;
  busy: boolean;
  setBusy(value: boolean): void;
}

type Slot = "answer" | "question-paper" | "model-answer";

const SLOTS: Array<{ kind: Slot; label: string; hint: string; required: boolean }> = [
  {
    kind: "answer",
    label: "Student answer paper",
    hint: "The script to be marked. Required.",
    required: true,
  },
  {
    kind: "question-paper",
    label: "Question paper",
    hint: "Optional context for the grader.",
    required: false,
  },
  {
    kind: "model-answer",
    label: "Model answer / rubric",
    hint: "Optional. Marks always come from the loaded rubric.",
    required: false,
  },
];

export function UploadPanel({ onGraded, busy, setBusy }: Props) {
  const [documents, setDocuments] = useState<Partial<Record<Slot, StoredDocument>>>({});
  const [warnings, setWarnings] = useState<Partial<Record<Slot, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<Slot, HTMLInputElement | null>>>({});

  const upload = async (kind: Slot, file: File) => {
    setError(null);
    setBusy(true);
    try {
      const { document, warning } = await api.uploadDocument(file, kind);
      setDocuments((prev) => ({ ...prev, [kind]: document }));
      setWarnings((prev) => ({ ...prev, [kind]: warning }));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const grade = async () => {
    const answer = documents.answer;
    if (!answer) return;
    setError(null);
    setBusy(true);
    try {
      const record = await api.grade({
        answerId: answer.id,
        ...(documents["question-paper"] ? { questionPaperId: documents["question-paper"]!.id } : {}),
        ...(documents["model-answer"] ? { modelAnswerId: documents["model-answer"]!.id } : {}),
      });
      onGraded(record.result.id);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `${cause.message}${cause.detail ? ` — ${JSON.stringify(cause.detail)}` : ""}`
          : "Grading failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="upload-panel">
      {SLOTS.map((slot) => {
        const document = documents[slot.kind];
        return (
          <div className="upload-slot" key={slot.kind}>
            <div className="upload-slot-head">
              <strong>{slot.label}</strong>
              {slot.required && <span className="chip">required</span>}
            </div>
            <p className="muted small">{slot.hint}</p>

            <input
              type="file"
              accept="application/pdf,.pdf"
              ref={(element) => {
                inputs.current[slot.kind] = element;
              }}
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(slot.kind, file);
              }}
            />

            {document && (
              <p className="uploaded">
                ✓ {document.filename} — {document.pageCount} page(s),{" "}
                {document.charCount.toLocaleString()} characters
              </p>
            )}
            {warnings[slot.kind] && <p className="warn-text">{warnings[slot.kind]}</p>}
          </div>
        );
      })}

      {error && <p className="error">{error}</p>}

      <button type="button" className="primary big" disabled={!documents.answer || busy} onClick={grade}>
        {busy ? "Grading…" : "Grade this paper"}
      </button>
    </div>
  );
}
