import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import {
  createToolNameAliases,
  renameToolNamesInMessages,
  withProviderSafeToolNames,
} from "../src/provider-tool-names.js";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const fn = (name: string) => ({
  type: "function" as const,
  name,
  inputSchema: { type: "object" as const, properties: {} },
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

describe("createToolNameAliases", () => {
  it("keeps safe names and aliases the rest without collisions", () => {
    const aliases = createToolNameAliases(["cart_add", "cart.add", "cart/add"]);
    expect(aliases.toWire("cart_add")).toBe("cart_add");
    expect(aliases.toWire("cart.add")).toBe("cart_add_2");
    expect(aliases.toWire("cart/add")).toBe("cart_add_3");
    expect(aliases.fromWire("cart_add_2")).toBe("cart.add");
    expect(aliases.fromWire("cart_add_3")).toBe("cart/add");
    expect(aliases.fromWire("cart_add")).toBe("cart_add");
  });

  it("assigns the same aliases whatever order the tools arrive in", () => {
    const a = createToolNameAliases(["x.y", "x/y"]);
    const b = createToolNameAliases(["x/y", "x.y"]);
    expect(a.toWire("x.y")).toBe(b.toWire("x.y"));
    expect(a.toWire("x/y")).toBe(b.toWire("x/y"));
  });

  it("keeps an alias within 64 characters when it needs a suffix", () => {
    const long = "a".repeat(70);
    const aliases = createToolNameAliases(["a".repeat(64), `${long}.b`]);
    const alias = aliases.toWire(`${long}.b`);
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(alias).not.toBe("a".repeat(64));
  });

  it("sanitizes a name outside the tool set, such as an old call in history", () => {
    expect(createToolNameAliases([]).toWire("gone.tool")).toBe("gone_tool");
  });
});

describe("renameToolNamesInMessages", () => {
  it("returns the same array when nothing is renamed", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "ok" }],
      },
    ];
    expect(renameToolNamesInMessages(messages, (n) => n)).toBe(messages);
  });
});

describe("withProviderSafeToolNames", () => {
  const prompt: CallOptions["prompt"] = [
    { role: "user", content: [{ type: "text", text: "add it" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "cart.add",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "cart.add",
          output: { type: "text", value: "added" },
        },
      ],
    },
  ];

  it("sends aliases to the provider and restores the names in its reply", async () => {
    let sent: CallOptions | undefined;
    const inner = new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent = options;
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "c2",
              toolName: "cart_add_2",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const result = await withProviderSafeToolNames(inner).doGenerate({
      prompt,
      tools: [fn("cart.add"), fn("cart_add")],
      toolChoice: { type: "tool", toolName: "cart.add" },
    });

    expect(sent?.tools?.map((tool) => tool.name)).toEqual([
      "cart_add_2",
      "cart_add",
    ]);
    expect(sent?.toolChoice).toEqual({ type: "tool", toolName: "cart_add_2" });
    expect(JSON.stringify(sent?.prompt)).not.toContain("cart.add");
    expect(result.content).toEqual([
      expect.objectContaining({ type: "tool-call", toolName: "cart.add" }),
    ]);
  });

  it("restores names in streamed tool parts", async () => {
    const inner = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "tool-input-start", id: "c2", toolName: "cart_add" },
          { type: "tool-input-end", id: "c2" },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "cart_add",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
          },
        ]),
      }),
    });

    const { stream } = await withProviderSafeToolNames(inner).doStream({
      prompt,
      tools: [fn("cart.add")],
    });
    const names: string[] = [];
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if ("toolName" in r.value) names.push(r.value.toolName);
    }

    expect(names).toEqual(["cart.add", "cart.add"]);
  });

  it("passes a call whose names are all safe through untouched", async () => {
    let sent: CallOptions | undefined;
    const inner = new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent = options;
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "x_2",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const params: CallOptions = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [fn("x"), fn("x_2")],
    };

    const result = await withProviderSafeToolNames(inner).doGenerate(params);

    expect(sent).toBe(params);
    expect(result.content).toEqual([
      expect.objectContaining({ toolName: "x_2" }),
    ]);
  });
});
