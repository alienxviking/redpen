/**
 * Core domain types for RedPen.
 *
 * Two things drive most of the design here:
 *   1. A grade must be reconstructible from evidence. Every mark deduction points at
 *      a rubric row, and every piece of feedback points at text in the student answer.
 *   2. Annotations are data, not a rendering of the grade. They are stored separately
 *      and can be edited without re-grading (see AnnotationRecord.origin).
 */

/** A rectangle in PDF user space (origin bottom-left, points). */
export interface Rect {
  page: number; // 0-indexed
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One text run extracted from a PDF, with its position on the page. */
export interface PositionedToken {
  text: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset of this token's text within ExtractedDocument.text. */
  start: number;
  end: number;
}

export interface ExtractedPage {
  page: number;
  width: number;
  height: number;
  text: string;
  /** Offset of this page's text within ExtractedDocument.text. */
  start: number;
  end: number;
}

export interface ExtractedDocument {
  /** Full plain text of the document, pages joined by \f. */
  text: string;
  pages: ExtractedPage[];
  tokens: PositionedToken[];
  /** True when the document carries no meaningful extractable text. */
  isBlank: boolean;
  /** Characters of non-whitespace text found. */
  charCount: number;
  /**
   * Where the text came from. `text-layer` is the PDF's own embedded text. `vision`
   * means the page had no text layer - a scan or a handwritten script - so the text
   * and its positions were transcribed from the page image. That is fallible, and the
   * grade must say so rather than treat it as ground truth.
   */
  source: "text-layer" | "vision";
}

/* ------------------------------------------------------------------ rubric */

export interface RubricCriterion {
  id: string; // e.g. "q1.r2"
  criterion: string;
  maxMarks: number;
  /** Optional grader hints lifted from the model answer's guidance sections. */
  guidance?: string;
}

export interface RubricQuestion {
  id: string; // e.g. "q1"
  title: string; // "Q1 - Science"
  prompt: string;
  maxMarks: number;
  criteria: RubricCriterion[];
  /** The model answer text for this question. */
  modelAnswer: string;
  /** Free-text marking guidance that applies to the whole question. */
  guidance?: string;
  /** Whether a full-credit answer is expected to include a diagram/graph. */
  expectsDiagram: boolean;
}

export interface RubricSpec {
  id: string;
  title: string;
  maxMarks: number;
  questions: RubricQuestion[];
}

/* ------------------------------------------------------------------ grading */

export type Verdict = "correct" | "partial" | "incorrect" | "missing";

export interface CriterionResult {
  rubricId: string;
  criterion: string;
  maxMarks: number;
  awardedMarks: number;
  verdict: Verdict;
  /** Verbatim quote from the student answer supporting this judgement. */
  evidence: string | null;
  /** Why these marks were given or withheld. */
  feedback: string;
}

export interface QuestionResult {
  questionId: string;
  title: string;
  maxMarks: number;
  awardedMarks: number;
  criteria: CriterionResult[];
  correctPoints: string[];
  missingPoints: string[];
  incorrectPoints: string[];
  /** 0..1 self-reported, adjusted downward by the validator. */
  confidence: number;
}

export type AnnotationType =
  | "error" // factually wrong statement
  | "missing" // a required point is absent
  | "spelling" // spelling / grammar / OCR-style slip
  | "layout" // alignment, structure, labelling problem
  | "praise"; // a correct point worth marking positively

export interface Annotation {
  id: string;
  questionId: string;
  rubricId: string | null;
  type: AnnotationType;
  /** The text the grader was pointing at. */
  quote: string;
  /** Teacher-facing note shown next to the box. */
  comment: string;
  /** Suggested corrected wording, if there is one. */
  correction: string | null;
  /** Where to draw. Empty rects means the quote could not be located. */
  rects: Rect[];
  /** How confidently the quote was located in the answer PDF (0..1). */
  anchorScore: number;
  anchored: boolean;
  /** Where this annotation came from. Edited/manual ones survive re-grading. */
  origin: "model" | "user";
  /** Set once a user has moved or retyped it. */
  edited: boolean;
}

export interface ReviewFlag {
  code:
    | "blank_answer"
    | "low_confidence"
    | "unanchored_evidence"
    | "model_output_repaired"
    | "model_unavailable"
    | "marks_clamped"
    | "criteria_missing"
    | "no_evidence"
    | "ocr_extraction";
  message: string;
}

export interface GradeResult {
  id: string;
  createdAt: string;
  rubricId: string;
  /** Ids of the stored documents this grade was produced from. */
  documents: { questionPaperId?: string; answerId: string; modelAnswerId?: string };
  answerFilename: string;
  totalMarks: number;
  maxMarks: number;
  questions: QuestionResult[];
  confidence: number;
  needsHumanReview: boolean;
  flags: ReviewFlag[];
  /** Provenance: which grader actually produced this. */
  grader: {
    provider: "anthropic" | "gemini" | "groq" | "mock";
    model: string;
    degraded: boolean;
  };
  /** Non-fatal repairs the validator applied to the raw model output. */
  warnings: string[];
  overallFeedback: string;
}

/** A stored grading, plus its independently-editable annotation layer. */
export interface GradingRecord {
  result: GradeResult;
  annotations: Annotation[];
}

export interface StoredDocument {
  id: string;
  kind: "question-paper" | "answer" | "model-answer";
  filename: string;
  mimeType: string;
  bytes: number;
  storedAt: string;
  pageCount: number;
  charCount: number;
  isBlank: boolean;
  /**
   * The positioned extraction lives in its own file rather than in the index,
   * because it is large and only needed when grading or re-anchoring a quote.
   */
  extractionFile: string;
  file: string;
}
