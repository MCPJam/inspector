import { z } from "zod";
import { MAX_TEST_STEPS } from "./steps.js";

const maxRecordedActions = MAX_TEST_STEPS - 2;

export const recordedAppTraceSchema = z.object({
  apps: z.array(
    z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      serverId: z.string().optional(),
    })
  ),
  actions: z.array(
    z.object({
      toolCallId: z.string(),
      stepIndex: z.number().int().nonnegative(),
      promptIndex: z.number().int().nonnegative(),
      elapsedMs: z.number().nonnegative(),
      ts: z.number(),
      action: z.string(),
      actor: z.enum(["persona", "model", "scripted"]).optional(),
      ok: z.boolean().optional(),
      target: z
        .object({
          role: z.string(),
          name: z.string(),
          scope: z.literal("host").optional(),
        })
        .optional(),
      requiresModelFollowUp: z.boolean(),
    })
  ),
  summary: z.object({
    attempted: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
  }),
  truncated: z.boolean(),
});
export type RecordedAppTrace = z.infer<typeof recordedAppTraceSchema>;

/** Keep replay metadata only. Raw screenshots, widget messages and tool
 * results remain in the original trace evidence. */
export function projectRecordedAppTrace(evidence: {
  widgetRenderObservations?: readonly {
    toolCallId: string;
    toolName: string;
    serverId?: string;
    status: string;
  }[];
  browserInteractionSteps?: readonly {
    toolCallId: string;
    stepIndex: number;
    promptIndex: number;
    elapsedMs: number;
    ts: number;
    action: string;
    actor?: "persona" | "model" | "scripted";
    ok?: boolean;
    target?: { role: string; name: string; scope?: "host" };
    followUps?: readonly string[];
  }[];
  personaAppActions?: RecordedAppTrace["summary"];
}): RecordedAppTrace | undefined {
  if (!evidence.personaAppActions) return undefined;
  const actions = evidence.browserInteractionSteps ?? [];
  const toolCallIds = new Set(actions.map(({ toolCallId }) => toolCallId));
  const apps = (evidence.widgetRenderObservations ?? [])
    .filter(
      (row) => row.status === "rendered" && toolCallIds.has(row.toolCallId)
    )
    .slice(0, maxRecordedActions)
    .map(({ toolCallId, toolName, serverId }) => ({
      toolCallId,
      toolName,
      serverId,
    }));
  return recordedAppTraceSchema.parse({
    apps,
    actions: actions.slice(0, maxRecordedActions).map((step) => ({
      toolCallId: step.toolCallId,
      stepIndex: step.stepIndex,
      promptIndex: step.promptIndex,
      elapsedMs: step.elapsedMs,
      ts: step.ts,
      action: step.action,
      actor: step.actor,
      ok: step.ok,
      target: step.target,
      requiresModelFollowUp: Boolean(step.followUps?.length),
    })),
    summary: evidence.personaAppActions,
    truncated: actions.length > maxRecordedActions,
  });
}
