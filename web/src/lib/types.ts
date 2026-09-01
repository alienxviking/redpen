/** Mirrors the server's domain types for the fields the UI actually consumes. */

export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationType = "error" | "missing" | "spelling" | "layout" | "praise";
export type Verdict = "correct" | "partial" | "incorrect" | "missing";

export interface Annotation {
  id: string;
  questionId: string;
  rubricId: string | null;
  type: AnnotationType;
  quote: string;
  comment: string;
  correction: string | null;
  rects: Rect[];
  anchorScore: number;
  anchored: boolean;
  origin: "model" | "user";
  edited: boolean;
}

export interface CriterionResult {
  rubricId: string;
  criterion: string;
  maxMarks: number;
  awardedMarks: number;
  verdict: Verdict;
  evidence: string | null;
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
  confidence: number;
}

export interface ReviewFlag {
  code: string;
  message: string;
}

export interface GradeResult {
  id: string;
  createdAt: string;
  rubricId: string;
  documents: { questionPaperId?: string; answerId: string; modelAnswerId?: string };
  answerFilename: string;
  totalMarks: number;
  maxMarks: number;
  questions: QuestionResult[];
  confidence: number;
  needsHumanReview: boolean;
  flags: ReviewFlag[];
  grader: {
    provider: "anthropic" | "gemini" | "groq" | "mock";
    model: string;
    degraded: boolean;
  };
  warnings: string[];
  overallFeedback: string;
}

export interface GradingRecord {
  result: GradeResult;
  annotations: Annotation[];
}

export interface StoredDocument {
  id: string;
  kind: "question-paper" | "answer" | "model-answer";
  filename: string;
  bytes: number;
  pageCount: number;
  charCount: number;
  isBlank: boolean;
  storedAt: string;
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  answerFilename: string;
  totalMarks: number;
  maxMarks: number;
  confidence: number;
  needsHumanReview: boolean;
  grader: { provider: string; model: string; degraded: boolean };
  annotationCount: number;
}

export interface Health {
  ok: boolean;
  grader: "anthropic" | "gemini" | "groq" | "mock";
  model: string;
  degraded: boolean;
}

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  error: "Incorrect",
  missing: "Missing",
  spelling: "Spelling",
  layout: "Layout",
  praise: "Good",
};

export const ANNOTATION_COLOURS: Record<AnnotationType, string> = {
  error: "#d62728",
  missing: "#e67e12",
  spelling: "#2270d1",
  layout: "#8541ae",
  praise: "#1c8c54",
};
