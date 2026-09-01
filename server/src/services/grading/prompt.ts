import type { RubricQuestion, RubricSpec } from "../../domain/types.js";
import type { GradeRequest } from "../llm/provider.js";

/**
 * Prompt construction.
 *
 * The system prompt is deliberately fixed and rubric-independent so it stays a stable
 * cache prefix across papers; everything that varies goes in the user turn.
 */

export function buildSystemPrompt(): string {
  return [
    "You are an experienced school examiner marking a written examination paper.",
    "You mark strictly against the supplied rubric and you show your evidence.",
    "",
    "How to mark:",
    "- Award marks rubric point by rubric point. Each rubric point is all-or-nothing unless its own guidance says otherwise: award its full marks or zero.",
    "- Never award more than a rubric point's maximum, and never award negative marks.",
    "- Mark the quality of the student's reasoning, NOT its similarity to the model answer. A student who argues the opposite of the model answer, or lays out a diagram differently, still earns full marks if the reasoning and the relationships are sound.",
    "- Follow any per-question or per-criterion guidance exactly; it overrides your own preferences.",
    "- A factual value fixed by the question (an equilibrium price, a measured quantity) is not a matter of opinion. Getting it wrong is a substantive error.",
    "",
    "Evidence rules (these matter more than the score):",
    "- For every rubric point you must quote the student's own words in `evidence`, copied VERBATIM from the extracted answer text you are given, including any spelling mistakes. Do not paraphrase, tidy, or re-spell a quote.",
    "- Use `evidence: null` only when the point is genuinely absent from the answer, in which case the verdict is `missing`.",
    "- Feedback must be specific and must refer to what the student actually wrote or failed to write. Never write generic praise or generic criticism.",
    "",
    "Annotations:",
    "- Produce an annotation for each concrete problem a teacher would mark on the page: a wrong statement (`error`), a required point that is absent (`missing`), a spelling or grammar slip (`spelling`), a structural or labelling problem (`layout`). Add `praise` sparingly for a notably good point.",
    "- `quote` must be the exact span of the student's text to draw a box around, copied VERBATIM and kept short - a phrase or a sentence, not a paragraph. For a `missing` annotation, quote the nearest relevant sentence the student did write so the note can be placed sensibly; use an empty string only if nothing relevant exists.",
    "- `correction` is what the student should have written instead, phrased so it can be shown next to their work. Use null when there is nothing to correct (for example on `praise`).",
    "",
    "Honesty:",
    "- `confidence` is your genuine 0-1 confidence in the marks for that question. Lower it when the handwriting or extraction is unclear, when a diagram is hard to read, or when the answer is ambiguous.",
    "- Set `needsHumanReview` to true whenever a teacher really should check your marking, and say why in `reviewReason`.",
    "- If you cannot mark something, say so in the feedback and lower the confidence. Do not invent evidence and do not guess a score to appear decisive.",
  ].join("\n");
}

function renderQuestion(q: RubricQuestion): string {
  const criteria = q.criteria
    .map(
      (c) =>
        `  - id: ${c.id} | ${c.maxMarks} mark(s) | ${c.criterion}` +
        (c.guidance ? `\n    guidance: ${c.guidance}` : ""),
    )
    .join("\n");

  return [
    `### ${q.id} - ${q.title} (${q.maxMarks} marks)`,
    `Question: ${q.prompt}`,
    q.expectsDiagram
      ? "This question expects a diagram or graph; judge it from the answer paper images."
      : "",
    "",
    "Model answer (a reference, NOT a target to match word for word):",
    q.modelAnswer,
    "",
    q.guidance ? `Marking guidance for this question: ${q.guidance}` : "",
    "",
    "Rubric points:",
    criteria,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderRubric(rubric: RubricSpec): string {
  return rubric.questions.map(renderQuestion).join("\n\n");
}

export function buildUserPrompt(request: GradeRequest): string {
  const { rubric, answerText, questionPaperText, modelAnswerText, answerPdfBase64 } = request;

  const sections = [
    `# Paper: ${rubric.title} (${rubric.maxMarks} marks total)`,
    "",
    "## Rubric and model answers",
    renderRubric(rubric),
    "",
  ];

  if (questionPaperText) {
    sections.push("## Question paper as issued to the student", questionPaperText.trim(), "");
  }

  if (modelAnswerText) {
    sections.push(
      "## Model answer paper as supplied by the teacher",
      "Additional reference only. The rubric above remains the sole source of the marks available.",
      modelAnswerText.trim(),
      "",
    );
  }

  sections.push(
    "## Student answer - extracted text",
    answerPdfBase64
      ? "The answer paper is attached above as a PDF; use it to judge diagrams, layout and labelling. The text below is the machine extraction of that same paper. Every `evidence` and `quote` value you return MUST be copied verbatim from the text below (not from the PDF rendering), because those strings are matched back against it character by character to place annotations on the page."
      : "The text below was extracted from the student's answer paper. Diagrams are NOT included in this extraction - if a rubric point depends on a diagram you cannot see, say so in the feedback, lower the confidence for that question and flag it for human review. Every `evidence` and `quote` value MUST be copied verbatim from the text below, because those strings are matched back against it character by character to place annotations on the page.",
    "",
    "```",
    answerText,
    "```",
    "",
    `Return one entry per question, using exactly these question ids: ${rubric.questions
      .map((q) => q.id)
      .join(", ")}, and exactly these rubric ids: ${rubric.questions
      .flatMap((q) => q.criteria.map((c) => c.id))
      .join(", ")}.`,
  );

  return sections.join("\n");
}

export function buildRepairPrompt(
  request: GradeRequest,
  badOutput: string,
  problem: string,
): string {
  return [
    buildUserPrompt(request),
    "",
    "## Repair required",
    "Your previous response could not be used. The problem was:",
    problem,
    "",
    "Your previous response was:",
    "```",
    badOutput.slice(0, 6000),
    "```",
    "",
    "Return a corrected result for the same paper. Keep the marking judgements you already made wherever they were sound; fix only what is malformed, out of range, or missing.",
  ].join("\n");
}
