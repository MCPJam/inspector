/**
 * What the client does to its own partial message when the user presses Stop.
 *
 * The behaviour under test lives in `use-chat-session.ts`'s `onFinish`, but the
 * decision it makes is entirely in the shared helper — so this exercises the
 * helper through the exact shape the AI SDK hands that callback, rather than
 * mounting the whole hook.
 *
 * Why it matters: the user can send again the instant Stop lands, and the next
 * request carries this history. An open tool call in it is not a loose end —
 * the server's loop reads an unresolved historical call as work to do, so the
 * call the user just stopped would run for real on the next turn.
 */
import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_TOOL_CALL_TEXT,
  closeUnresolvedUiToolParts,
} from "@/shared/turn-outcome-closure";

const partialAssistantMessage = (
  parts: Array<Record<string, unknown>>,
): { id: string; role: string; parts: Array<Record<string, unknown>> } => ({
  id: "m-partial",
  role: "assistant",
  parts,
});

describe("client Stop closes the partial turn's open tool calls", () => {
  it("closes a call whose input was complete as OUTCOME UNKNOWN", () => {
    // `input-available` means the call is with the server. The client cannot
    // see dispatch, so it must not promise the call did nothing.
    const message = partialAssistantMessage([
      { type: "text", text: "Charging the card…" },
      {
        type: "tool-charge_card",
        toolCallId: "c1",
        state: "input-available",
        input: { amount: 4200 },
      },
    ]);
    const closed = closeUnresolvedUiToolParts(message, { turnId: "turn-1" });
    const part = closed.parts[1] as Record<string, unknown>;
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe(INTERRUPTED_TOOL_CALL_TEXT.outcome_unknown);
    expect(part.callProviderMetadata).toEqual({
      mcpjam: { interrupted: "outcome_unknown", turnId: "turn-1" },
    });
  });

  it("closes a call the model had not finished dictating as NEVER STARTED", () => {
    const message = partialAssistantMessage([
      {
        type: "tool-charge_card",
        toolCallId: "c1",
        state: "input-streaming",
        input: {},
      },
    ]);
    const closed = closeUnresolvedUiToolParts(message);
    const part = closed.parts[0] as Record<string, unknown>;
    expect(part.errorText).toBe(INTERRUPTED_TOOL_CALL_TEXT.never_started);
  });

  it("leaves a SETTLED call untouched", () => {
    const message = partialAssistantMessage([
      {
        type: "tool-list_cards",
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output: { cards: [] },
      },
    ]);
    expect(closeUnresolvedUiToolParts(message)).toBe(message);
  });

  it("leaves a call that already ERRORED untouched — that is a real answer", () => {
    const message = partialAssistantMessage([
      {
        type: "tool-charge_card",
        toolCallId: "c1",
        state: "output-error",
        input: {},
        errorText: "the card was declined",
      },
    ]);
    const closed = closeUnresolvedUiToolParts(message);
    expect(closed).toBe(message);
    expect((closed.parts[0] as Record<string, unknown>).errorText).toBe(
      "the card was declined",
    );
  });

  it("closes several open calls in one pass and keeps text parts as they are", () => {
    const message = partialAssistantMessage([
      { type: "text", text: "Working on it" },
      { type: "tool-a", toolCallId: "c1", state: "input-available", input: {} },
      { type: "tool-b", toolCallId: "c2", state: "input-streaming", input: {} },
    ]);
    const closed = closeUnresolvedUiToolParts(message, { turnId: "turn-1" });
    expect((closed.parts[0] as Record<string, unknown>).type).toBe("text");
    expect((closed.parts[1] as Record<string, unknown>).state).toBe(
      "output-error",
    );
    expect((closed.parts[2] as Record<string, unknown>).state).toBe(
      "output-error",
    );
  });

  it("returns the SAME object when nothing was open, so React sees no change", () => {
    const message = partialAssistantMessage([{ type: "text", text: "done" }]);
    expect(closeUnresolvedUiToolParts(message)).toBe(message);
  });

  it("is idempotent — a second Stop on the same message changes nothing", () => {
    const message = partialAssistantMessage([
      { type: "tool-a", toolCallId: "c1", state: "input-available", input: {} },
    ]);
    const once = closeUnresolvedUiToolParts(message, { turnId: "turn-1" });
    expect(closeUnresolvedUiToolParts(once, { turnId: "turn-1" })).toBe(once);
  });

  it("omits turnId rather than nulling it when the turn identity is unknown", () => {
    // An explicit `null` would change the serialized bytes the client's and the
    // server's closures have to agree on.
    const message = partialAssistantMessage([
      { type: "tool-a", toolCallId: "c1", state: "input-available", input: {} },
    ]);
    const closed = closeUnresolvedUiToolParts(message);
    expect((closed.parts[0] as Record<string, unknown>).callProviderMetadata)
      .toEqual({ mcpjam: { interrupted: "outcome_unknown" } });
  });
});
