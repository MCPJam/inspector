import type { ModelMessage } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { modelMessageSchema } from "ai";
import { normalizeModelMessagesForConvex } from "../normalize-model-messages-for-convex";

/** Shape observed when Convex rejects AI_InvalidPromptError (missing toolCallId). */
const malformedProjectTrace = [
  {
    role: "user",
    content: [{ type: "text", text: "atdraw a go" }],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: 'I\'ll help you draw a "go" diagram! Let me first read the format reference, then create a hand-drawn style diagram for you.',
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
        text: 'Now let me create a hand-drawn "go" diagram for you! I\'ll interpret this as a "Go" game board with some game elements:',
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
    const out = normalizeModelMessagesForConvex(malformedProjectTrace);

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

/**
 * Asserted against the SDK's real `modelMessageSchema`, not a hand-written
 * copy of it: the whole failure class here is a message this repo believed was
 * valid and the backend's schema did not.
 *
 * The backend validates with `ai@7` while the inspector builds against
 * `ai@6`. Both were checked against every shape below and agree on the
 * tool-result `output` union, so testing with the local copy is not a
 * weaker assertion — but it is the reason a `text` output is never
 * synthesised here: only `json` accepts an arbitrary payload in both.
 */
describe("normalizeModelMessagesForConvex — tool-result output", () => {
  const base = { type: "tool-result", toolCallId: "call_1", toolName: "search" };
  const toolMessage = (part: Record<string, unknown>) =>
    [{ role: "tool", content: [part] }] as unknown as ModelMessage[];
  // Mirrors the wire: `JSON.stringify` silently drops an undefined value, and
  // that is how a half-built output reaches the backend looking like a missing
  // one.
  const overWire = (messages: ModelMessage[]) =>
    JSON.parse(JSON.stringify(messages)) as ModelMessage[];

  const parseFirst = (messages: ModelMessage[]) =>
    modelMessageSchema.safeParse(overWire(normalizeModelMessagesForConvex(messages))[0]);

  const outputOf = (messages: ModelMessage[]) =>
    (
      overWire(normalizeModelMessagesForConvex(messages))[0] as unknown as {
        content: Array<{ output?: unknown }>;
      }
    ).content[0].output;

  it.each([
    ["a v4 result carrying an object", { ...base, result: { distance: "2.4km" } }],
    ["a v4 result carrying a string", { ...base, result: "2.4km" }],
    ["an unwrapped output", { ...base, output: { distance: "2.4km" } }],
    ["an output whose value is undefined", { ...base, output: { type: "json", value: undefined } }],
    ["an undefined output beside a result", { ...base, output: undefined, result: { a: 1 } }],
  ])("repairs %s into a valid ModelMessage", (_label, part) => {
    expect(parseFirst(toolMessage(part)).success).toBe(true);
  });

  it("wraps a bare payload as json rather than assigning it raw", () => {
    // The bug this replaces: the old repair copied `result` onto `output`
    // untouched, which the schema rejects exactly as it rejects no output.
    expect(outputOf(toolMessage({ ...base, result: { distance: "2.4km" } }))).toEqual({
      type: "json",
      value: { distance: "2.4km" },
    });
  });

  it("lands an undefined value on null so it survives serialization", () => {
    expect(outputOf(toolMessage({ ...base, output: { type: "json", value: undefined } }))).toEqual({
      type: "json",
      value: null,
    });
  });

  /**
   * The schema is stricter than the type tag: `null` is valid only under
   * `json` / `error-json`, `text` and `error-text` need a string, and
   * `content` needs an array. An envelope that contradicts its own tag is
   * rejected exactly like a missing output, so it cannot be preserved just
   * because the tag was recognized.
   */
  it.each([
    ["text carrying an object", { type: "text", value: { a: 1 } }],
    ["text carrying undefined", { type: "text", value: undefined }],
    ["error-text carrying undefined", { type: "error-text", value: undefined }],
    ["content carrying undefined", { type: "content", value: undefined }],
    ["content carrying a string", { type: "content", value: "x" }],
  ])("re-declares %s as json rather than preserving it", (_label, output) => {
    const messages = toolMessage({ ...base, output });
    expect(parseFirst(messages).success).toBe(true);
    expect((outputOf(messages) as { type: string }).type).toBe("json");
  });

  it("keeps the payload when it re-declares a mistyped envelope", () => {
    // Re-declaring must not nest the envelope inside itself.
    expect(outputOf(toolMessage({ ...base, output: { type: "text", value: { a: 1 } } }))).toEqual({
      type: "json",
      value: { a: 1 },
    });
  });

  it.each([
    ["json", { type: "json", value: { d: 1 } }],
    ["json carrying null", { type: "json", value: null }],
    ["error-json", { type: "error-json", value: { e: 1 } }],
    ["error-text", { type: "error-text", value: "boom" }],
    ["text", { type: "text", value: "hi" }],
    ["content", { type: "content", value: [{ type: "text", text: "x" }] }],
  ])("leaves an already-valid %s output untouched", (_label, output) => {
    const messages = toolMessage({ ...base, output });
    expect(parseFirst(messages).success).toBe(true);
    expect(outputOf(messages)).toEqual(output);
  });

  /**
   * Deliberately NOT repaired. A tool-result with neither key means the output
   * was lost upstream, and inventing one would grade the case against a value
   * the tool never returned. The backend's 400 names the index instead, which
   * is the honest failure.
   */
  it("leaves a tool-result with no output and no result for the backend to reject", () => {
    const messages = toolMessage({ ...base });
    expect(outputOf(messages)).toBeUndefined();
    expect(parseFirst(messages).success).toBe(false);
  });
});
