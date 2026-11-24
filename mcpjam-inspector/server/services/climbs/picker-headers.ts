/**
 * How MCPJam's step says, on its own call to `submit_climb_round`, that the
 * round is its own. The route turns the two headers into the backend's
 * `pickerStep`, which only a held lease and the person who started the climb
 * can use, so a caller that sends them without either is refused there: they
 * are a label with no authority, like the launcher header.
 */
import type { Context } from "hono";

export const PICKER_STEP_HEADERS = {
  /** The generation the claim returned. */
  generation: "x-mcpjam-picker-step",
  /** The chat session that holds the step's transcript. */
  chatSession: "x-mcpjam-picker-chat-session",
} as const;

export type PickerStepMark = { generation: number; chatSessionId?: string };

export function readPickerStep(c: Context): PickerStepMark | undefined {
  const generation = Number(c.req.header(PICKER_STEP_HEADERS.generation));
  if (!Number.isInteger(generation) || generation < 1) return undefined;
  const chatSessionId = c.req.header(PICKER_STEP_HEADERS.chatSession)?.trim();
  return { generation, ...(chatSessionId ? { chatSessionId } : {}) };
}

export function pickerStepHeaders(mark: PickerStepMark): Record<string, string> {
  return {
    [PICKER_STEP_HEADERS.generation]: String(mark.generation),
    ...(mark.chatSessionId ? { [PICKER_STEP_HEADERS.chatSession]: mark.chatSessionId } : {}),
  };
}
