import { describe, expect, it } from "vitest";
import { extractToolCallsFromEnvelopeMessages } from "../chat-session-envelope";

describe("extractToolCallsFromEnvelopeMessages", () => {
  it("extracts tool calls from inline toolCalls arrays as well as tool-call content parts", () => {
    const messages = [
      {
        role: "assistant",
        content: "text-only message",
        toolCalls: [{ toolName: "fetch", args: { url: "/x" } }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolName: "search", input: { q: "y" } }],
      },
    ];

    expect(extractToolCallsFromEnvelopeMessages(messages)).toEqual([
      { toolName: "fetch", arguments: { url: "/x" } },
      { toolName: "search", arguments: { q: "y" } },
    ]);
  });

  it("deduplicates identical tool calls across messages", () => {
    const call = {
      role: "assistant",
      content: [{ type: "tool-call", toolName: "search", input: { q: "x" } }],
    };

    expect(extractToolCallsFromEnvelopeMessages([call, call])).toHaveLength(1);
  });
});
