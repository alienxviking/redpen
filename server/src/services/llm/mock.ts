import type { RubricCriterion, RubricQuestion } from "../../domain/types.js";
import type {
  ModelAnnotation,
  ModelCriterion,
  ModelGrade,
  ModelQuestion,
} from "../../domain/schema.js";
import {
  MISSPELLINGS,
  flatten,
  sentenceAt,
  toMatchable,
  type Mapped,
} from "../text/normalise.js";
import type { GradeRequest, GraderProvider, ProviderResponse } from "./provider.js";

/**
 * Deterministic offline grader.
 *
 * This exists for three reasons: a reviewer with no API key can still run the whole
 * product; the test suite can assert exact scores without paying for or depending on
 * a network call; and when the real model is unreachable we degrade to *something
 * defensible and clearly labelled* rather than to an error page.
 *
 * It is a keyword-and-pattern grader, and it says so: it reports a modest confidence
 * and the pipeline marks every mock grade as degraded and needing human review. It is
 * not pretending to be a substitute for the model, particularly on Q2 where the whole
 * point is judging reasoning quality.
 */

interface Signal {
  /** Evidence that the criterion is satisfied. */
  positive?: RegExp[];
  /** Evidence of a substantive error; outranks any positive match. */
  negative?: RegExp[];
  /** Minimum non-whitespace characters in the answer for the point to be creditable. */
  minChars?: number;
  correction?: string;
  errorComment?: string;
  missingComment?: string;
}

const SIGNALS: Record<string, Signal> = {
  "q1.r1": {
    positive: [/\bin series\b/i, /\bseries\b[^.]{0,60}\b(circuit|loop|path)\b/i],
    negative: [/\bbulb\b[^.]{0,30}\bin parallel\b[^.]{0,30}\bresistor\b/i],
    missingComment: "The main circuit is not described as a closed series path.",
  },
  "q1.r2": {
    positive: [/\bvoltmeter\b[^.]{0,60}\bparallel\b/i],
    negative: [/\bvoltmeter\b[^.]{0,60}\bin series\b/i, /\bammeter\b[^.]{0,60}\bparallel\b/i],
    correction:
      "The voltmeter must be connected in parallel across the bulb, because it measures the potential difference between the two ends of the bulb. Only the ammeter goes in series.",
    errorComment:
      "Substantive error: a voltmeter in series with the bulb would not measure the potential difference across it.",
    missingComment:
      "The answer does not state that the ammeter goes in series and the voltmeter in parallel across the bulb.",
  },
  "q1.r3": {
    positive: [/\bcurrent\b[^.]{0,80}\b(flows?|flowing)\b/i],
    missingComment: "The path of the current and the role of each component are not explained.",
  },
  "q1.r4": {
    positive: [
      /\bresistance\b[^.]{0,80}\bcurrent\b/i,
      /\bohm'?s law\b/i,
      /\bV\s*=\s*IR\b/,
    ],
    negative: [
      // "increas\w*" rather than "increases?" so that "is increased" is caught too.
      /\bresistance\b[^.]{0,40}\bincreas\w*[^.]{0,60}\bcurrent\b[^.]{0,40}\b(increas\w*|more|higher)\b/i,
    ],
    correction:
      "If the voltage is constant and the resistance increases, the current decreases (V = IR).",
    errorComment: "The stated relationship between resistance and current is inverted.",
    missingComment: "The effect of changing the resistance on the current is not explained.",
  },
  "q1.r5": {
    positive: [/\b(conventional current|direction of (the )?current|labell?ed)\b/i],
    missingComment:
      "The diagram lacks clear labelling or does not show the direction of conventional current.",
  },
  "q2.r1": {
    positive: [/\b(in my opinion|i believe|i think|i feel|my view)\b/i],
    minChars: 120,
    missingComment: "The answer does not commit to a clear position on the statement.",
  },
  "q2.r2": {
    positive: [/\b(because|therefore|as a result|this means|which means)\b/i],
    minChars: 200,
    missingComment: "The argument is asserted rather than developed.",
  },
  "q2.r3": {
    positive: [
      /\b(however|on the other hand|some (people |students )?argue|critics|opposing view|although|even though|admittedly)\b/i,
    ],
    missingComment:
      "No opposing viewpoint or limitation is considered; the question explicitly asks for one.",
  },
  "q2.r4": {
    positive: [/\b(for example|for instance|such as|e\.g\.)/i],
    missingComment: "No concrete example is given to support the claims.",
  },
  "q2.r5": {
    positive: [/\b(in conclusion|to conclude|to sum up|overall|therefore,)/i],
    missingComment: "There is no conclusion that follows from the discussion.",
  },
  "q3.r1": {
    positive: [/\b(demand curve|supply curve)\b/i],
    // The axes are the commonest labelling error on this question and the student
    // usually states the mistake in words as well as drawing it.
    negative: [/\bprice\b[^.]{0,20}\bhorizontal\b/i, /\bquantity\b[^.]{0,20}\bvertical\b/i],
    correction:
      "Quantity belongs on the horizontal axis and price on the vertical axis; the curves are drawn against those axes.",
    errorComment: "The axes are the wrong way round.",
    missingComment: "The demand and supply curves are not identified or labelled.",
  },
  "q3.r2": {
    positive: [/\bequilibrium\b[^.]{0,80}\b30\b[^.]{0,60}\b60\b/i, /\b30\b[^.]{0,40}\b60 units\b/i],
    negative: [
      /\bequilibrium\b[^.]{0,40}\b(10|20|40|50)\b/i,
      /\bRs\.?\s*(10|20|40|50)\b[^.]{0,80}\bequilibrium\b/i,
    ],
    correction:
      "Equilibrium is at a price of Rs 30 and a quantity of 60 units - the only row of the schedule where quantity demanded equals quantity supplied.",
    errorComment: "The equilibrium is read off the schedule incorrectly.",
    missingComment: "The equilibrium price and quantity are not identified.",
  },
  "q3.r3": {
    positive: [/\bshortage\b[\s\S]{0,400}\bsurplus\b/i, /\bsurplus\b[\s\S]{0,400}\bshortage\b/i],
    missingComment:
      "Only one side of the disequilibrium case is covered; both shortage and surplus are required.",
  },
  "q3.r4": {
    positive: [/\bsupply\b[^.]{0,60}\bshifts?\b[^.]{0,30}\b(left|leftward|upward|up)\b/i],
    negative: [/\bsupply\b[^.]{0,60}\bshifts?\b[^.]{0,30}\b(right|rightward|outward)\b/i],
    correction:
      "A rise in production cost makes supplying less profitable at every price, so the supply curve shifts to the LEFT / upward.",
    errorComment: "The direction of the supply shift is reversed.",
    missingComment: "The effect of higher production costs on the supply curve is not explained.",
  },
  "q3.r5": {
    positive: [/\bhigher\b[^.]{0,40}\bprice\b[^.]{0,80}\blower\b[^.]{0,40}\bquantity\b/i],
    negative: [/\blower\b[^.]{0,30}\bprice\b[^.]{0,60}\bhigher\b[^.]{0,30}\bquantity\b/i],
    correction:
      "The new equilibrium is at a higher price and a lower quantity, assuming demand is unchanged.",
    errorComment: "The resulting movement of equilibrium price and quantity is stated backwards.",
    missingComment: "The resulting new equilibrium is not described.",
  },
};

/**
 * A section of the answer, prepared for matching.
 *
 * `flat` is the student's own words with line wrapping removed; `matchable` is that
 * same text lower-cased and spell-corrected. Rules run against `matchable`, and any
 * match is reported back as the corresponding sentence of `flat` - so the grader can
 * read through a typo without ever quoting words the student did not write.
 */
interface Section {
  flat: Mapped;
  matchable: Mapped;
}

function prepare(text: string): Section {
  const flat = flatten(text);
  return { flat, matchable: toMatchable(flat.text) };
}

/** Run patterns against the matchable text; return the sentence the student wrote. */
function firstMatch(
  section: Section,
  patterns: RegExp[] | undefined,
): { evidence: string } | null {
  if (!patterns) return null;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    const m = re.exec(section.matchable.text);
    if (!m) continue;
    const flatIndex = section.matchable.map[m.index] ?? 0;
    return { evidence: sentenceAt(section.flat.text, flatIndex) };
  }
  return null;
}

/**
 * Generic fallback for a rubric id this grader has no rule for: how much of the
 * criterion's distinctive vocabulary shows up in the answer.
 */
function keywordOverlap(criterion: RubricCriterion, section: Section): number {
  const stop = new Set([
    "the", "and", "with", "that", "this", "from", "for", "are", "its", "correctly",
    "explains", "explain", "appropriate", "relevant", "provides", "presents", "clear",
  ]);
  const terms = [...new Set(criterion.criterion.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter(
    (t) => !stop.has(t),
  );
  if (terms.length === 0) return 0;
  const lower = section.matchable.text;
  return terms.filter((t) => lower.includes(t)).length / terms.length;
}

function gradeCriterion(
  criterion: RubricCriterion,
  section: Section,
  charCount: number,
): { result: ModelCriterion; annotation: ModelAnnotation | null } {
  const signal = SIGNALS[criterion.id];

  if (!signal) {
    const overlap = keywordOverlap(criterion, section);
    const awarded = overlap >= 0.5 ? criterion.maxMarks : 0;
    return {
      result: {
        rubricId: criterion.id,
        awardedMarks: awarded,
        verdict: awarded > 0 ? "correct" : "missing",
        evidence: null,
        feedback:
          awarded > 0
            ? "The offline grader found most of this criterion's key terms in the answer. A teacher should confirm."
            : "The offline grader could not find this criterion's key terms in the answer.",
      },
      annotation: null,
    };
  }

  const bad = firstMatch(section, signal.negative);
  if (bad) {
    const quote = bad.evidence;
    return {
      result: {
        rubricId: criterion.id,
        awardedMarks: 0,
        verdict: "incorrect",
        evidence: quote,
        feedback: signal.errorComment ?? "This statement is incorrect.",
      },
      annotation: {
        rubricId: criterion.id,
        type: "error",
        quote,
        comment: signal.errorComment ?? "Incorrect.",
        correction: signal.correction ?? null,
      },
    };
  }

  const enoughText = charCount >= (signal.minChars ?? 0);
  const good = enoughText ? firstMatch(section, signal.positive) : null;
  if (good) {
    return {
      result: {
        rubricId: criterion.id,
        awardedMarks: criterion.maxMarks,
        verdict: "correct",
        evidence: good.evidence,
        feedback: "This rubric point is met.",
      },
      annotation: null,
    };
  }

  return {
    result: {
      rubricId: criterion.id,
      awardedMarks: 0,
      verdict: "missing",
      evidence: null,
      feedback: signal.missingComment ?? "This rubric point is not addressed in the answer.",
    },
    annotation: {
      rubricId: criterion.id,
      type: "missing",
      quote: "",
      comment: signal.missingComment ?? "This rubric point is not addressed.",
      correction: null,
    },
  };
}

function spellingAnnotations(flatText: string): ModelAnnotation[] {
  const found: ModelAnnotation[] = [];
  const seen = new Set<string>();
  for (const [wrong, right] of Object.entries(MISSPELLINGS)) {
    const re = new RegExp(`\\b${wrong}\\b`, "i");
    const m = re.exec(flatText);
    if (!m || seen.has(wrong)) continue;
    seen.add(wrong);
    found.push({
      rubricId: null,
      type: "spelling",
      quote: m[0],
      comment: `Spelling: "${m[0]}" should be "${right}".`,
      correction: right,
    });
  }
  return found;
}

/**
 * Split the answer text into per-question sections so a rule for q3 does not match a
 * sentence the student wrote under q1. Falls back to the whole text when the answer
 * has no recognisable question headings.
 */
export function sectionise(answer: string, questions: RubricQuestion[]): Map<string, string> {
  const sections = new Map<string, string>();
  const marks: Array<{ id: string; index: number }> = [];

  for (const q of questions) {
    const number = q.id.replace(/\D/g, "");
    const re = new RegExp(`(^|\\n)\\s*(q(uestion)?\\s*\\.?\\s*${number})\\b`, "i");
    const m = re.exec(answer);
    if (m) marks.push({ id: q.id, index: m.index });
  }
  marks.sort((a, b) => a.index - b.index);

  if (marks.length === 0) {
    for (const q of questions) sections.set(q.id, answer);
    return sections;
  }

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.index;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : answer.length;
    sections.set(marks[i]!.id, answer.slice(start, end));
  }
  // Any question with no heading falls back to the whole paper.
  for (const q of questions) if (!sections.has(q.id)) sections.set(q.id, answer);
  return sections;
}

export class MockGrader implements GraderProvider {
  readonly name = "mock" as const;
  readonly model = "offline-heuristic-v1";

  async grade(request: GradeRequest): Promise<ProviderResponse> {
    const { rubric, answerText } = request;
    const sections = sectionise(answerText, rubric.questions);

    const questions: ModelQuestion[] = rubric.questions.map((q) => {
      const raw = sections.get(q.id) ?? answerText;
      const section = prepare(raw);
      const charCount = raw.replace(/\s/g, "").length;
      const annotations: ModelAnnotation[] = [];
      const criteria: ModelCriterion[] = [];
      const correctPoints: string[] = [];
      const missingPoints: string[] = [];
      const incorrectPoints: string[] = [];

      for (const criterion of q.criteria) {
        const { result, annotation } = gradeCriterion(criterion, section, charCount);
        criteria.push(result);
        if (annotation) annotations.push(annotation);
        if (result.verdict === "correct") correctPoints.push(criterion.criterion);
        else if (result.verdict === "incorrect") incorrectPoints.push(criterion.criterion);
        else missingPoints.push(criterion.criterion);
      }

      annotations.push(...spellingAnnotations(section.flat.text));

      return {
        questionId: q.id,
        criteria,
        correctPoints,
        missingPoints,
        incorrectPoints,
        annotations,
        // A pattern grader should not claim to be sure. This value deliberately sits
        // under the review threshold so every offline grade lands in front of a human.
        confidence: 0.55,
      };
    });

    const grade: ModelGrade = {
      questions,
      overallFeedback:
        "Graded offline by the deterministic pattern grader (no model available). Marks are indicative and every rubric point should be confirmed by a teacher.",
      needsHumanReview: true,
      reviewReason: "Graded without a language model, using keyword and pattern rules only.",
    };

    return {
      raw: JSON.stringify(grade),
      parsed: grade,
      provider: this.name,
      model: this.model,
    };
  }
}
