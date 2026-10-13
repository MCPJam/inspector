import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { isGuestInputTooLargeMessage } from "@/lib/mcpjam-limit";
import { rejectedInputTurn } from "../rejected-input";

const refusal = JSON.stringify({ code: "guest_input_too_large", limit: 32000 });
const history: UIMessage[] = [
  { id: "first", role: "user", parts: [{ type: "text", text: "Hello" }] },
  { id: "reply", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
];
const rejected: UIMessage = {
  id: "rejected",
  role: "user",
  parts: [
    { type: "data-ui-context", data: { path: "/testing" } },
    { type: "text", text: "Debug this failure" },
  ],
};

describe("oversized agent input recovery", () => {
  it.each([
    refusal,
    `Request failed: ${refusal}`,
    JSON.stringify({ error: refusal }),
    JSON.stringify({ details: { code: "guest_input_too_large" } }),
  ])("recognizes the structured refusal: %s", (message) => {
    expect(isGuestInputTooLargeMessage(message)).toBe(true);
  });

  it.each([
    undefined,
    "Network error",
    '{"code":"platform_capacity"}',
    '{"error":"guest_input_too_large"}',
  ])("does not classify an unrelated error: %s", (message) => {
    expect(isGuestInputTooLargeMessage(message)).toBe(false);
    expect(rejectedInputTurn([...history, rejected], message)).toBeNull();
  });

  it("preserves completed history and returns only the rejected text", () => {
    const messages = [...history, rejected];
    expect(rejectedInputTurn(messages, refusal)).toEqual({
      messages: history,
      text: "Debug this failure",
    });
    expect(messages).toEqual([...history, rejected]);
  });

  it("drops an assistant placeholder belonging to the rejected turn", () => {
    expect(
      rejectedInputTurn(
        [...history, rejected, { id: "empty", role: "assistant", parts: [] }],
        refusal,
      )?.messages,
    ).toEqual(history);
  });

  it("handles an empty transcript without deleting anything", () => {
    expect(rejectedInputTurn([], refusal)).toBeNull();
    expect(rejectedInputTurn([history[1]], refusal)).toBeNull();
  });
});
