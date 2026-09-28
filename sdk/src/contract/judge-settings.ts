import { z } from "zod";
import { MAX_JUDGE_INSTRUCTIONS_LENGTH } from "./goal-completion.js";

export const judgeCriterionSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
  required: z.boolean().optional(),
});

/** One authoring shape across UI, REST, platform MCP, CLI files and SDK. */
export const judgeRubricSchema = z
  .strictObject({
    criteria: z.array(judgeCriterionSchema).min(1).max(25).optional(),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(MAX_JUDGE_INSTRUCTIONS_LENGTH)
      .optional()
      .describe(
        "Grading instructions: extra rules applied alongside each case's task and expected outcome. They do not replace the expected outcome."
      ),
  })
  .superRefine((rubric, ctx) => {
    if (rubric.criteria === undefined && rubric.instructions === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Provide grading instructions or criteria; use null to clear.",
        path: [],
      });
    }
    const ids = new Set<string>();
    rubric.criteria?.forEach((criterion, index) => {
      if (ids.has(criterion.id))
        ctx.addIssue({
          code: "custom",
          message: "Criterion IDs must be unique.",
          path: ["criteria", index, "id"],
        });
      ids.add(criterion.id);
    });
  });

export const suiteJudgeSettingsSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    model: z.string().trim().min(1).optional(),
    autoRun: z.boolean().optional(),
    threshold: z.number().min(0).max(1).optional(),
    role: z.enum(["advisory", "gating", "required"]).optional(),
    severity: z.literal("warn").optional(),
    rubric: judgeRubricSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.severity === undefined ||
      value.role === undefined ||
      value.role === "advisory",
    {
      message: "Severity is only available for advisory judges.",
      path: ["severity"],
    }
  );

export const caseJudgeSettingsSchema = z.strictObject({
  enabled: z.boolean().optional(),
});
export type SuiteJudgeSettings = z.infer<typeof suiteJudgeSettingsSchema>;
export type CaseJudgeSettings = z.infer<typeof caseJudgeSettingsSchema>;
