import { z } from "zod";
import { judgeRubricSchema } from "./judge-settings.js";
export const judgeBacktestRequestSchema = z
  .object({
    rubric: judgeRubricSchema.nullable(),
    continuation: z
      .object({
        cursor: z.number().int().min(1),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        reservationId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type JudgeBacktestRequest = z.infer<typeof judgeBacktestRequestSchema>;
export type JudgeBacktestReport =
  | { ok: false; reason: string }
  | {
      ok: true;
      comparable: boolean;
      reason?: string;
      judgeTemplateVersion: number;
      draftSuiteRubricHash: string | null;
      storedSuiteRubricHash: string | null;
      cursor?: number;
      sourceHash?: string;
      reservationId?: string;
      isDone?: boolean;
      cases: Array<{
        gradingKey: string;
        iterationId: string | null;
        stored: { score: number; band: string } | null;
        draft: { score: number; band: string } | null;
        status?: "scored" | "error";
        errorCode?: string;
        reason?: string;
        flipped: boolean;
      }>;
      summary: { graded: number; flips: number; storedMissing: number };
    };
