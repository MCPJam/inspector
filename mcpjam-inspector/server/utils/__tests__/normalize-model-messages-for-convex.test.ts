import type { ModelMessage } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { normalizeModelMessagesForConvex } from "../normalize-model-messages-for-convex";

/** Shape observed when Convex rejects AI_InvalidPromptError (missing toolCallId). */
const malformedWorkspaceTrace = [
  {
    role: "user",
    content: [{ type: "text", text: "atdraw a go" }],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll help you draw a \"go\" diagram! Let me first read the format reference, then create a hand-drawn style diagram for you.",
      },
      { type: "tool-call", toolName: "invocation" },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "invocation",
        output: {
          type: "error-text",
          value: "Tool 'invocation' not found",
        },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Now let me create a hand-drawn \"go\" diagram for you! I'll interpret this as a \"Go\" game board with some game elements:",
      },
      { type: "tool-call", toolName: "invocation" },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "invocation",
        output: {
          type: "error-text",
          value: "Tool 'invocation' not found",
        },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Perfect! I've drawn a simple **Go** diagram for you! So on.",
      },
    ],
  },
  {
    role: "user",
    content: [{ type: "text", text: "test" }],
  },
] as unknown as ModelMessage[];

describe("normalizeModelMessagesForConvex", () => {
  it("assign paired toolCallIds to tool-call and tool-result parts missing ids", () => {
    const out = normalizeModelMessagesForConvex(malformedWorkspaceTrace);

    expect(out[0].role).toBe("user");
    expect((out[0] as { content: unknown }).content).toBe("atdraw a go");

    const a1 = out[1] as {
      content: Array<{ type?: string; toolCallId?: string; args?: unknown }>;
    };
    const call1 = a1.content.find((p) => p.type === "tool-call");
    expect(call1?.toolCallId).toMatch(/^mcpjam-synth-/);
    expect(call1?.args).toEqual({});

    const t1 = out[2] as {
      content: Array<{ type?: string; toolCallId?: string }>;
    };
    expect(t1.content[0].toolCallId).toBe(call1?.toolCallId);

    const a2 = out[3] as {
      content: Array<{ type?: string; toolCallId?: string }>;
    };
    const call2 = a2.content.find((p) => p.type === "tool-call");
    expect(call2?.toolCallId).toMatch(/^mcpjam-synth-/);
    expect(call2?.toolCallId).not.toBe(call1?.toolCallId);

    const t2 = out[4] as {
      content: Array<{ type?: string; toolCallId?: string }>;
    };
    expect(t2.content[0].toolCallId).toBe(call2?.toolCallId);

    expect((out[out.length - 1] as { content: unknown }).content).toBe("test");
  });

  it("leaves well-formed tool rows unchanged except user text coalescing", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "search",
            args: { q: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search",
            output: { ok: true },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const out = normalizeModelMessagesForConvex(messages);
    const assist = out[1] as { content: Array<{ toolCallId?: string }> };
    const tool = out[2] as { content: Array<{ toolCallId?: string }> };
    expect(assist.content[0].toolCallId).toBe("c1");
    expect(tool.content[0].toolCallId).toBe("c1");
    expect((out[0] as { content: unknown }).content).toBe("hi");
  });
});
