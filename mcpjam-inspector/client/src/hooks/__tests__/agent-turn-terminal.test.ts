import { describe, expect, it } from "vitest";
import {
  lastAssistantHasUnresolvedToolParts,
  turnAssistantMessage,
} from "../use-mcpjam-agent-session";
import type { UIMessage } from "ai";

const msg = (parts: unknown[]): UIMessage =>
  ({ role: "assistant", parts } as unknown as UIMessage);

describe("lastAssistantHasUnresolvedToolParts", () => {
  it("is false for a plain text answer (turn genuinely done)", () => {
    expect(
      lastAssistantHasUnresolvedToolParts(
        msg([{ type: "text", text: "hi" }]),
      ),
    ).toBe(false);
  });

  it("is true while a tool call awaits its result (intermediate ready)", () => {
    // The SDK reaches `ready` here with the tool part input-available — the
    // turn is NOT done; emitting now would truncate duration and suppress the
    // real completion.
    expect(
      lastAssistantHasUnresolvedToolParts(
        msg([{ type: "tool-ui_navigate", state: "input-available" }]),
      ),
    ).toBe(true);
  });

  it("is true while a tool call awaits approval", () => {
    expect(
      lastAssistantHasUnresolvedToolParts(
        msg([{ type: "tool-ui_execute_tool", state: "approval-requested" }]),
      ),
    ).toBe(true);
  });

  it("is false once every tool call has resolved (final ready)", () => {
    expect(
      lastAssistantHasUnresolvedToolParts(
        msg([
          { type: "tool-ui_navigate", state: "output-available" },
          { type: "text", text: "done" },
        ]),
      ),
    ).toBe(false);
  });

  it("treats an errored tool output as resolved", () => {
    expect(
      lastAssistantHasUnresolvedToolParts(
        msg([{ type: "tool-ui_navigate", state: "output-error" }]),
      ),
    ).toBe(false);
  });

  it("treats a denied tool output as resolved (denied turns still complete)", () => {
    expect(
      lastAssistantHasUnresolvedToolParts(
        msg([{ type: "tool-ui_remove_server", state: "output-denied" }]),
      ),
    ).toBe(false);
  });

  it("is false for undefined / non-assistant messages", () => {
    expect(lastAssistantHasUnresolvedToolParts(undefined)).toBe(false);
    expect(
      lastAssistantHasUnresolvedToolParts({
        role: "user",
        parts: [{ type: "tool-x", state: "input-available" }],
      } as unknown as UIMessage),
    ).toBe(false);
  });
});

describe("turnAssistantMessage", () => {
  const withId = (id: string): UIMessage =>
    ({ id, role: "assistant", parts: [] } as unknown as UIMessage);

  it("returns the message when it's new (id differs from the boundary)", () => {
    const m = withId("assistant-2");
    expect(turnAssistantMessage(m, "assistant-1")).toBe(m);
  });

  it("returns undefined when last is the pre-submit boundary (stale)", () => {
    // Error before the turn produced its own assistant message: `last` is the
    // previous answer, whose id equals the boundary → not this turn's.
    const stale = withId("assistant-1");
    expect(turnAssistantMessage(stale, "assistant-1")).toBeUndefined();
  });

  it("returns the message on a fresh session (null boundary)", () => {
    const m = withId("assistant-1");
    expect(turnAssistantMessage(m, null)).toBe(m);
  });

  it("returns undefined when there is no last message", () => {
    expect(turnAssistantMessage(undefined, "x")).toBeUndefined();
  });
});
