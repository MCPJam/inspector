/**
 * The goal-completion judge on the public goal surface (`./goals.ts`).
 *
 * A goal's judge is the same grader an eval suite's is, stored in the same
 * `judgeConfig.goalCompletion` envelope the suite routes write, so this file
 * speaks the suite vocabulary rather than inventing one: `enabled`, `autoRun`,
 * `model`, `modelSelection` and `threshold` on a write; the resolved `judge`
 * object the suite settings DTO returns on a read. A caller who has written a
 * suite's judge can write a goal's without learning a second spelling, and
 * `judgeModel`/`judgeSelection` stay the storage's names.
 *
 * Lives beside `goals.ts` rather than in it because that file is already past
 * the size at which it should take new code.
 */
import { z } from "zod";
import type { RequestedModelSelection } from "@mcpjam/sdk";
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";
import { judgeModelIdInputSchema, judgeRunOverride } from "./judge-model-id.js";
import {
  computedModelId,
  requestedModelSelectionSchema,
  sameRequestedSelection,
  selectionOriginField,
} from "./model-selection-schema.js";

/**
 * The judge fields a goal write takes: the same keys a read of `goal.judge`
 * returns, so a caller can send back what it read. Every one optional, so a
 * PATCH can move a single field; `null` for the whole object (on PATCH)
 * clears the goal's judge back to the managed defaults, as it does upstream.
 *
 * `model` is checked but not normalized here: the rewrite of a hosted
 * `mcpjam/` id depends on the selection it is sent with, which is
 * {@link judgeRunOverride}'s job. `modelSelection` takes a STORED legacy
 * selection too, because a read can return one. `modelSelectionOrigin` is a
 * read-only marker, accepted only so a read round-trips; it never sets
 * anything (see {@link judgeConfigForWrite}). A body with no field that
 * changes anything is refused rather than stored as a judge that says
 * nothing.
 */
export const goalJudgeWriteSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    autoRun: z.boolean().optional(),
    model: judgeModelIdInputSchema.optional(),
    modelSelection: requestedModelSelectionSchema.optional(),
    modelSelectionOrigin: z.literal("backfill").optional(),
    threshold: z.number().min(0).max(1).optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "modelSelectionOrigin"),
    { message: "Provide at least one judge field." },
  );

export type GoalJudgeWrite = z.infer<typeof goalJudgeWriteSchema>;

const parsedJudgeSchema = goalJudgeWriteSchema.nullable().optional();

/**
 * The judge off a parsed goal body, whichever surface parsed it. The
 * surface-specific count key on those schemas is computed, which widens
 * every parsed field to the union of them all, so the field is narrowed
 * back through the schema that already accepted it rather than cast.
 */
export function judgeOf(body: {
  judge?: unknown;
}): GoalJudgeWrite | null | undefined {
  return parsedJudgeSchema.parse(body.judge);
}

/** The stored slot, as `journeys:getJourney` serializes it. */
type StoredGoalCompletion = {
  enabled?: boolean;
  judgeModel?: string;
  judgeSelection?: RequestedModelSelection;
  judgeSelectionOrigin?: unknown;
  threshold?: number;
  autoRun?: boolean;
  role?: unknown;
  severity?: unknown;
};

/** The judge fields of a journey row this module reads. */
export type GoalJudgeRowFields = {
  judgeConfig?: { goalCompletion?: StoredGoalCompletion } | null;
  judgePolicy?: {
    effective: {
      enabled: boolean;
      judgeModel: string;
      threshold: number;
      autoRun: boolean;
    };
  } | null;
};

/**
 * The `judgeConfig` argument for `journeys:createJourney` /
 * `journeys:updateJourney` from a public judge write.
 *
 * MERGE semantics on an update: the backend replaces the goal-completion slot
 * wholesale, so a write naming one field is layered onto the stored slot here
 * — otherwise `{ autoRun: false }` would also drop the goal's chosen model.
 * The other slots of the envelope are the backend's to carry forward; only
 * `goalCompletion` is sent.
 *
 * A model change replaces the stored selection: a selection belongs to the
 * model it was chosen for, so it is kept only while it still names the new
 * model. The conversion marker describes the STORED selection, so it survives
 * only while that exact selection is what is written back. Same rules as the
 * suite execution-config PATCH.
 */
export function judgeConfigForWrite(
  judge: GoalJudgeWrite | null,
  stored?: StoredGoalCompletion,
): { goalCompletion: Record<string, unknown> } | null {
  if (judge === null) return null;
  const goalCompletion: Record<string, unknown> = { ...(stored ?? {}) };
  if (judge.enabled !== undefined) goalCompletion.enabled = judge.enabled;
  if (judge.autoRun !== undefined) goalCompletion.autoRun = judge.autoRun;
  if (judge.threshold !== undefined) goalCompletion.threshold = judge.threshold;
  if (judge.model !== undefined || judge.modelSelection !== undefined) {
    // A selection sent alone names the model; the backend refuses a
    // selection beside no `judgeModel`, as every legacy reader would then
    // grade on the default.
    const { judgeModel, judgeSelection } = judgeRunOverride(
      judge.model ?? judge.modelSelection?.modelId,
      judge.modelSelection,
    );
    goalCompletion.judgeModel = judgeModel;
    const storedSelection = stored?.judgeSelection;
    const nextSelection =
      judgeSelection ??
      (storedSelection?.modelId === judgeModel ? storedSelection : undefined);
    if (nextSelection === undefined) delete goalCompletion.judgeSelection;
    else goalCompletion.judgeSelection = nextSelection;
    if (
      nextSelection === undefined ||
      storedSelection === undefined ||
      !sameRequestedSelection(nextSelection, storedSelection)
    ) {
      delete goalCompletion.judgeSelectionOrigin;
    }
  }
  return { goalCompletion };
}

/**
 * The goal's judge, RESOLVED the way the suite settings DTO resolves its
 * `settings.judge`: every field layered over the managed defaults, so a
 * caller reads what a run would actually grade with and can echo it back.
 * The backend's own resolution (`judgePolicy.effective`) wins when the row
 * carries it. The saved choice is named as it is on the write
 * (`modelSelection`, `modelSelectionOrigin`), not by its storage name.
 */
export function toGoalJudgeDto(row: GoalJudgeRowFields) {
  const stored = row.judgeConfig?.goalCompletion;
  const effective = row.judgePolicy?.effective;
  return {
    enabled:
      effective?.enabled ?? stored?.enabled ?? GOAL_COMPLETION_DEFAULTS.enabled,
    model:
      computedModelId(stored?.judgeSelection, stored?.judgeModel) ??
      effective?.judgeModel ??
      GOAL_COMPLETION_DEFAULTS.judgeModel,
    ...(stored?.judgeSelection
      ? { modelSelection: stored.judgeSelection }
      : {}),
    ...(stored?.judgeSelection &&
    selectionOriginField(stored.judgeSelectionOrigin)
      ? {
          modelSelectionOrigin: selectionOriginField(
            stored.judgeSelectionOrigin,
          ),
        }
      : {}),
    autoRun:
      effective?.autoRun ?? stored?.autoRun ?? GOAL_COMPLETION_DEFAULTS.autoRun,
    threshold:
      effective?.threshold ??
      stored?.threshold ??
      GOAL_COMPLETION_DEFAULTS.threshold,
  };
}
