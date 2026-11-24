/**
 * How MCPJam's step marks its own calls. On `submit_climb_round` the route
 * turns the generation and chat session into the backend's `pickerStep`, which
 * only a held lease and the person who started the climb can use. On a trace
 * read the route sends the climb and generation as the backend's `pickerStep`,
 * which only ever narrows what the read may open. So a caller that sends these
 * headers without the lease gains nothing: like the launcher header, they are
 * a label with no authority.
 */
import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { looksLikeConvexId } from "../../routes/v1/convex-id-param.js";

export const PICKER_STEP_HEADERS = {
  /** The generation the claim returned. */
  generation: "x-mcpjam-picker-step",
  /** The chat session that holds the step's transcript. */
  chatSession: "x-mcpjam-picker-chat-session",
  /** The climb the step works on. Read by the trace route only. */
  climb: "x-mcpjam-picker-climb",
} as const;

/** What the round route reads: the backend's `pickerStep` for a round. */
export type PickerStepMark = { generation: number; chatSessionId?: string };

/** What the step's client sends on every call. */
export type PickerStepSent = PickerStepMark & { climbId: string };

function readGeneration(c: Context): number | undefined {
  const generation = Number(c.req.header(PICKER_STEP_HEADERS.generation));
  return Number.isInteger(generation) && generation >= 1 ? generation : undefined;
}

export function readPickerStep(c: Context): PickerStepMark | undefined {
  const generation = readGeneration(c);
  if (generation === undefined) return undefined;
  const chatSessionId = c.req.header(PICKER_STEP_HEADERS.chatSession)?.trim();
  return { generation, ...(chatSessionId ? { chatSessionId } : {}) };
}

/**
 * The backend's `pickerStep` for a trace read, or undefined for a member's own
 * read. Half a marker is refused rather than dropped: read as a member's own,
 * it would open what the step must not see.
 */
export function readPickerTraceStep(c: Context): { climbId: string; generation: number } | undefined {
  const sentGeneration = c.req.header(PICKER_STEP_HEADERS.generation) !== undefined;
  const climbId = c.req.header(PICKER_STEP_HEADERS.climb)?.trim();
  if (!sentGeneration && climbId === undefined) return undefined;
  const generation = readGeneration(c);
  if (generation === undefined || !climbId || !looksLikeConvexId(climbId)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `A step's trace read names its climb and its generation. Send ${PICKER_STEP_HEADERS.climb} with ${PICKER_STEP_HEADERS.generation}, or neither.`,
      { reason: "PICKER_STEP_INCOMPLETE" },
    );
  }
  return { climbId, generation };
}

export function pickerStepHeaders(mark: PickerStepSent): Record<string, string> {
  return {
    [PICKER_STEP_HEADERS.generation]: String(mark.generation),
    [PICKER_STEP_HEADERS.climb]: mark.climbId,
    ...(mark.chatSessionId ? { [PICKER_STEP_HEADERS.chatSession]: mark.chatSessionId } : {}),
  };
}
