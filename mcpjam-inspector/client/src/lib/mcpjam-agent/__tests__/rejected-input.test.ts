import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { isGuestInputTooLargeMessage } from "@/lib/mcpjam-limit";
import { conversationTooLarge, rejectedInputTurn } from "../rejected-input";

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

const toolReply: UIMessage = {
  id: "tool-reply",
  role: "assistant",
  parts: [
    {
      type: "tool-ui_create_server",
      toolCallId: "create-server",
      state: "output-available",
      input: { name: "My server" },
      output: { serverId: "created-server" },
    },
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

  it("preserves a turn whose tool already ran before a later size refusal", () => {
    expect(
      rejectedInputTurn([...history, rejected, toolReply], refusal),
    ).toBeNull();
  });

  it("handles an empty transcript without deleting anything", () => {
    expect(rejectedInputTurn([], refusal)).toBeNull();
    expect(rejectedInputTurn([history[1]], refusal)).toBeNull();
  });

  it("blocks the conversation when tools ran after the refused turn", () => {
    expect(
      conversationTooLarge([...history, rejected, toolReply], refusal),
    ).toBe(true);
  });

  it("lets a droppable refused turn be replaced", () => {
    expect(conversationTooLarge([...history, rejected], refusal)).toBe(false);
  });

  it("doesn't block a refusal with no user message, since no tools ran after one", () => {
    expect(conversationTooLarge([], refusal)).toBe(false);
    expect(conversationTooLarge([toolReply], refusal)).toBe(false);
  });

  it.each([undefined, "Network error", '{"code":"platform_capacity"}'])(
    "never blocks on an unrelated error: %s",
    (message) => {
      expect(
        conversationTooLarge([...history, rejected, toolReply], message),
      ).toBe(false);
    },
  );
});

describe("oversized history behind a short message", () => {
  // The 413 body as the client receives it, with the repro's numbers.
  const sizeRefusal = (estimatedInputTokens: number) =>
    JSON.stringify({
      ok: false,
      code: "guest_input_too_large",
      limit: 32000,
      estimatedInputTokens,
      error: `Guest input is estimated at ${estimatedInputTokens} tokens, above the 32000 token limit.`,
    });
  const userText = (id: string, text: string): UIMessage => ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  });
  const paste = userText("paste", "x".repeat(63698));

  it("keeps blocking when the refused paste is the newest turn and tools ran", () => {
    expect(conversationTooLarge([paste, toolReply], sizeRefusal(33649))).toBe(
      true,
    );
  });

  it("blocks a short message sent after a reload brought the paste back", () => {
    const reloaded = [
      paste,
      toolReply,
      userText("hi", "hi"),
      userText("again", "hello again"),
    ];
    expect(conversationTooLarge(reloaded, sizeRefusal(33121))).toBe(true);
  });

  it("lets a large newest turn be replaced when the rest fits", () => {
    expect(
      conversationTooLarge(
        [...history, userText("big", "x".repeat(90000))],
        sizeRefusal(33000),
      ),
    ).toBe(false);
  });

  it("reads the numbers from a wrapped refusal too", () => {
    const reloaded = [paste, toolReply, userText("again", "hello again")];
    const wrapped = JSON.stringify({ error: sizeRefusal(33121) });
    expect(conversationTooLarge(reloaded, wrapped)).toBe(true);
  });

  it("lets a chat exactly at the limit send, as the backend refuses only above it", () => {
    const again = userText("again", "hello again");
    const share = JSON.stringify(again).length / 3;
    const reloaded = [paste, toolReply, again];
    expect(conversationTooLarge(reloaded, sizeRefusal(32000 + share))).toBe(
      false,
    );
    expect(conversationTooLarge(reloaded, sizeRefusal(32001 + share))).toBe(
      true,
    );
  });

  it("falls back to the tool rule when the refusal has no numbers", () => {
    const reloaded = [paste, toolReply, userText("again", "hello again")];
    expect(conversationTooLarge(reloaded, refusal)).toBe(false);
  });
});
