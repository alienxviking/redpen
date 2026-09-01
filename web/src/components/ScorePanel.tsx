import type { Annotation, GradeResult, QuestionResult } from "../lib/types.js";

/**
 * The explanation half of the product. A score on its own is not reviewable, so every
 * rubric point shows its mark, the verdict, the quote it was based on and what the
 * student would have to do differently.
 */

const VERDICT_LABEL: Record<string, string> = {
  correct: "Correct",
  partial: "Partly correct",
  incorrect: "Incorrect",
  missing: "Not addressed",
};

interface Props {
  result: GradeResult;
  annotations: Annotation[];
  onFocusAnnotation(id: string): void;
}

export function ScorePanel({ result, annotations, onFocusAnnotation }: Props) {
  const percent = result.maxMarks > 0 ? (result.totalMarks / result.maxMarks) * 100 : 0;

  return (
    <div className="score-panel">
      <div className="score-header">
        <div>
          <div className="score-total">
            {result.totalMarks}
            <span className="score-max"> / {result.maxMarks}</span>
          </div>
          <div className="muted small">{result.answerFilename}</div>
        </div>
        <div className="score-meta">
          <ConfidenceBadge value={result.confidence} needsReview={result.needsHumanReview} />
          <div className="muted small">
            {result.grader.provider === "mock" ? "Offline grader" : result.grader.model}
            {result.grader.degraded && " · degraded"}
          </div>
        </div>
      </div>

      <div className="score-bar">
        <div className="score-bar-fill" style={{ width: `${percent}%` }} />
      </div>

      {result.flags.length > 0 && (
        <section className="flags">
          <h3>Review flags</h3>
          <ul>
            {result.flags.map((flag, i) => (
              <li key={i}>
                <code>{flag.code}</code> {flag.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.warnings.length > 0 && (
        <details className="warnings">
          <summary>{result.warnings.length} adjustment(s) made to the grader's output</summary>
          <ul>
            {result.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      {result.questions.map((question) => (
        <section className="question" key={question.questionId}>
          <header>
            <h3>{question.title}</h3>
            <span className="question-marks">
              {question.awardedMarks} / {question.maxMarks}
            </span>
          </header>

          <PointsSummary question={question} />

          <ul className="criteria">
            {question.criteria.map((criterion) => {
              const related = annotations.filter((a) => a.rubricId === criterion.rubricId);
              return (
                <li key={criterion.rubricId} className={`criterion ${criterion.verdict}`}>
                  <div className="criterion-head">
                    <span className="criterion-mark">
                      {criterion.awardedMarks}/{criterion.maxMarks}
                    </span>
                    <span className="criterion-text">{criterion.criterion}</span>
                    <span className={`verdict ${criterion.verdict}`}>
                      {VERDICT_LABEL[criterion.verdict] ?? criterion.verdict}
                    </span>
                  </div>

                  <p className="feedback">{criterion.feedback}</p>

                  {criterion.evidence && (
                    <blockquote className="evidence">“{criterion.evidence}”</blockquote>
                  )}

                  {related.length > 0 && (
                    <div className="criterion-links">
                      {related.map((annotation) => (
                        <button
                          type="button"
                          key={annotation.id}
                          className="link"
                          onClick={() => onFocusAnnotation(annotation.id)}
                        >
                          {annotation.anchored ? "Show on paper" : "Note (not on page)"}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section className="overall">
        <h3>Overall</h3>
        <p>{result.overallFeedback}</p>
      </section>
    </div>
  );
}

/**
 * The at-a-glance version of the question: what the student got right, what they left
 * out, and what they got wrong. The per-criterion list below carries the detail, but a
 * teacher scanning a stack of papers wants this summary first.
 */
function PointsSummary({ question }: { question: QuestionResult }) {
  const groups = [
    { key: "correct", label: "Correct", points: question.correctPoints },
    { key: "missing", label: "Missing", points: question.missingPoints },
    { key: "incorrect", label: "Incorrect", points: question.incorrectPoints },
  ].filter((group) => group.points.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="points-summary">
      {groups.map((group) => (
        <div className={`points-group ${group.key}`} key={group.key}>
          <span className="points-label">
            {group.label} ({group.points.length})
          </span>
          <ul>
            {group.points.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ConfidenceBadge({ value, needsReview }: { value: number; needsReview: boolean }) {
  const percent = Math.round(value * 100);
  return (
    <span className={`badge ${needsReview ? "warn" : "ok"}`}>
      {needsReview ? "Needs review" : "Confident"} · {percent}%
    </span>
  );
}
