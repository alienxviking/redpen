import { z } from "zod";

/**
 * The contract we ask the model to fill in.
 *
 * This schema is deliberately *permissive about numbers* - `awardedMarks` is only
 * bounded to something sane here, and the real invariants (never above the rubric
 * maximum, total equals the sum of parts) are enforced afterwards in validate.ts.
 * Keeping enforcement out of the schema means a model that over-awards produces a
 * repairable result with a warning rather than a hard parse failure.
 */

export const verdictSchema = z.enum(["correct", "partial", "incorrect", "missing"]);

export const annotationTypeSchema = z.enum([
  "error",
  "missing",
  "spelling",
  "layout",
  "praise",
]);

export const modelCriterionSchema = z.object({
  rubricId: z.string(),
  awardedMarks: z.number(),
  verdict: verdictSchema,
  /**
   * A verbatim span copied from the student answer. Null when the point is simply
   * absent - there is nothing to quote for something that was never written.
   */
  evidence: z.string().nullable(),
  feedback: z.string(),
});

export const modelAnnotationSchema = z.object({
  rubricId: z.string().nullable(),
  type: annotationTypeSchema,
  /** Verbatim span from the student answer that the box should be drawn around. */
  quote: z.string(),
  comment: z.string(),
  correction: z.string().nullable(),
});

export const modelQuestionSchema = z.object({
  questionId: z.string(),
  criteria: z.array(modelCriterionSchema),
  correctPoints: z.array(z.string()),
  missingPoints: z.array(z.string()),
  incorrectPoints: z.array(z.string()),
  annotations: z.array(modelAnnotationSchema),
  confidence: z.number(),
});

export const modelGradeSchema = z.object({
  questions: z.array(modelQuestionSchema),
  overallFeedback: z.string(),
  /** The model's own flag that a human should look at this paper. */
  needsHumanReview: z.boolean(),
  reviewReason: z.string().nullable(),
});

export type ModelGrade = z.infer<typeof modelGradeSchema>;
export type ModelQuestion = z.infer<typeof modelQuestionSchema>;
export type ModelCriterion = z.infer<typeof modelCriterionSchema>;
export type ModelAnnotation = z.infer<typeof modelAnnotationSchema>;

/* ------------------------------------------------------- rubric input schema */

export const rubricCriterionSchema = z.object({
  id: z.string(),
  criterion: z.string(),
  maxMarks: z.number().positive(),
  guidance: z.string().optional(),
});

export const rubricQuestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  maxMarks: z.number().positive(),
  modelAnswer: z.string(),
  guidance: z.string().optional(),
  expectsDiagram: z.boolean().default(false),
  criteria: z.array(rubricCriterionSchema).min(1),
});

export const rubricSpecSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    maxMarks: z.number().positive(),
    questions: z.array(rubricQuestionSchema).min(1),
  })
  .superRefine((spec, ctx) => {
    for (const q of spec.questions) {
      const sum = q.criteria.reduce((a, c) => a + c.maxMarks, 0);
      if (Math.abs(sum - q.maxMarks) > 1e-9) {
        ctx.addIssue({
          code: "custom",
          message: `Question ${q.id}: criteria sum to ${sum} but maxMarks is ${q.maxMarks}`,
        });
      }
    }
    const total = spec.questions.reduce((a, q) => a + q.maxMarks, 0);
    if (Math.abs(total - spec.maxMarks) > 1e-9) {
      ctx.addIssue({
        code: "custom",
        message: `Rubric total is ${spec.maxMarks} but questions sum to ${total}`,
      });
    }
  });

/* ---------------------------------------------------------- API edit schemas */

export const rectSchema = z.object({
  page: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const annotationPatchSchema = z
  .object({
    type: annotationTypeSchema.optional(),
    comment: z.string().optional(),
    correction: z.string().nullable().optional(),
    quote: z.string().optional(),
    rects: z.array(rectSchema).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Empty patch" });

export const annotationCreateSchema = z.object({
  questionId: z.string(),
  rubricId: z.string().nullable().default(null),
  type: annotationTypeSchema.default("error"),
  quote: z.string().default(""),
  comment: z.string(),
  correction: z.string().nullable().default(null),
  rects: z.array(rectSchema).min(1),
});
