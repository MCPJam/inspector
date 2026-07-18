import { describe, expect, it } from "vitest";
import { lastAssistantHasUnresolvedToolParts } from "../use-mcpjam-agent-session";
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
