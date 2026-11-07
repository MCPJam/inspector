import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  CLEARED_TOOL_RESULT_TEXT,
  FILE_PART_TOKENS,
  MAX_TOOL_RESULT_TOKENS,
  estimateMessagesTokens,
  estimateModelTokens,
  fitMessagesToModelContext,
} from "../model-context-budget";

const BASE64 = "QUJD".repeat(50_000); // 200,000 dense characters

function call(id: string, toolName: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input: {} }],
  };
}

function result(id: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName, output } as never,
    ],
  };
}

function text(value: string) {
  return { type: "text", value };
}

/** Prose of `tokens` estimated tokens (three characters each). */
function prose(tokens: number): string {
  return "the quote ".repeat(Math.ceil((tokens * 3) / 10)).slice(0, tokens * 3);
}

function toolOutput(messages: ModelMessage[], id: string): any {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content as any[]) {
      if (part.toolCallId === id) return part.output;
    }
  }
  return undefined;
}

describe("estimateModelTokens", () => {
  it("counts long base64-like runs one token per character", () => {
    expect(estimateModelTokens(BASE64)).toBe(200_000);
  });

  it("counts other text three characters per token", () => {
    expect(estimateModelTokens("a b c d e f")).toBe(4);
  });

  it("counts non-ASCII characters one token each", () => {
    expect(estimateModelTokens("見積書")).toBe(3);
  });

  it("estimates the measured fixture result at or above the real token count", () => {
    const fixture = JSON.stringify({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            documentUUID: "doc-Q-1001-English",
            fileName: "doc-Q-1001-English.pdf",
            mimeType: "application/pdf",
            contentBase64: "A".repeat(683_048),
          }),
        },
      ],
    });
    // 683,048 base64 characters were 595,733 Claude tokens, prompt included.
    expect(estimateModelTokens(fixture)).toBeGreaterThanOrEqual(595_733);
  });
});

describe("estimateMessagesTokens", () => {
  it("counts an image or file part at a fixed cost, not by its bytes", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this pdf?" },
          {
            type: "file",
            mediaType: "application/pdf",
            data: "A".repeat(2_000_000),
          },
        ],
      },
    ];
    expect(estimateMessagesTokens(messages)).toBeLessThan(
      FILE_PART_TOKENS + 20,
    );
  });

  it("ignores provider options", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "short",
            providerOptions: { anthropic: { signature: "S".repeat(100_000) } },
          },
        ],
      },
    ];
    expect(estimateMessagesTokens(messages)).toBeLessThan(10);
  });
});

describe("fitMessagesToModelContext: cap", () => {
  const history = (output: unknown): ModelMessage[] => [
    { role: "user", content: "download the quote" },
    call("c1", "download_quote_document"),
    result("c1", "download_quote_document", output),
  ];

  it("returns the input unchanged when every result fits", () => {
    const messages = history(text("small result"));
    const fitted = fitMessagesToModelContext(messages, {
      contextTokens: 200_000,
    });
    expect(fitted.messages).toEqual(messages);
    expect(fitted.report).toBeUndefined();
  });

  it("keeps the start and end of an oversized json result under the cap", () => {
    const output = {
      type: "json",
      value: { content: [{ type: "text", text: `HEAD-${BASE64}-TAIL` }] },
    };
    const fitted = fitMessagesToModelContext(history(output), {
      contextTokens: 200_000,
    });
    const capped = toolOutput(fitted.messages, "c1");
    expect(capped.type).toBe("text");
    expect(
      capped.value.startsWith('{"content":[{"type":"text","text":"HEAD-'),
    ).toBe(true);
    expect(capped.value.endsWith('-TAIL"}]}')).toBe(true);
    expect(capped.value).toContain("[MCPJam cut ");
    expect(capped.value).toContain(
      "estimated tokens from the middle of this tool result to fit the model's context window. The full result is in the chat.]",
    );
    expect(estimateModelTokens(capped.value)).toBeLessThan(
      MAX_TOOL_RESULT_TOKENS,
    );
    expect(fitted.report?.shortened).toEqual([
      expect.objectContaining({
        toolCallId: "c1",
        toolName: "download_quote_document",
        originalTokens: estimateModelTokens(JSON.stringify(output.value)),
      }),
    ]);
    expect(fitted.report?.shortened[0].keptTokens).toBeLessThan(
      MAX_TOOL_RESULT_TOKENS,
    );
  });

  it("keeps an error output an error", () => {
    const fitted = fitMessagesToModelContext(
      history({ type: "error-text", value: BASE64 }),
      { contextTokens: 200_000 },
    );
    expect(toolOutput(fitted.messages, "c1").type).toBe("error-text");
  });

  it("cuts only the text parts of a content output and keeps images", () => {
    const image = {
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: "iVBOR".repeat(10) },
    };
    const fitted = fitMessagesToModelContext(
      history({
        type: "content",
        value: [{ type: "text", text: BASE64 }, image],
      }),
      { contextTokens: 200_000 },
    );
    const capped = toolOutput(fitted.messages, "c1");
    expect(capped.type).toBe("content");
    expect(capped.value[1]).toEqual(image);
    expect(estimateModelTokens(capped.value[0].text)).toBeLessThan(
      MAX_TOOL_RESULT_TOKENS,
    );
  });

  it("finishes on an empty text part beside an image", () => {
    const image = {
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: "iVBOR".repeat(10) },
    };
    const fitted = fitMessagesToModelContext(
      history({
        type: "content",
        value: [
          { type: "text", text: "" },
          image,
          { type: "text", text: prose(4_000) },
        ],
      }),
      { contextTokens: 8_000 },
    );
    const capped = toolOutput(fitted.messages, "c1");
    expect(capped.value).toContainEqual(image);
    expect(fitted.report?.shortened).toHaveLength(1);
  });

  it("cuts many small text parts once, so the result shrinks", () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => ({
      type: "text",
      text: `row ${i}: ${"status ok ".repeat(7)}`,
    }));
    const fitted = fitMessagesToModelContext(
      history({ type: "content", value: rows }),
      { contextTokens: 200_000 },
    );
    const capped = toolOutput(fitted.messages, "c1");
    const all = capped.value
      .map((part: { text: string }) => part.text)
      .join("");
    expect(all.match(/\[MCPJam cut /g)).toHaveLength(1);
    expect(estimateModelTokens(all)).toBeLessThan(MAX_TOOL_RESULT_TOKENS);
    expect(fitted.report?.shortened[0].keptTokens).toBeGreaterThan(20_000);
  });

  it("never leaves half of a surrogate pair at the cut", () => {
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const prefix of ["", "a", "ab", "abc"]) {
      const fitted = fitMessagesToModelContext(
        history(text(prefix + "ok 😀 ".repeat(20_000))),
        { contextTokens: 200_000 },
      );
      expect(toolOutput(fitted.messages, "c1").value).not.toMatch(lone);
    }
  });

  it("bounds the cap by a quarter of a small window", () => {
    const fitted = fitMessagesToModelContext(history(text(BASE64)), {
      contextTokens: 32_000,
    });
    expect(
      estimateModelTokens(toolOutput(fitted.messages, "c1").value),
    ).toBeLessThan(8_000);
  });

  it("caps with the default limit when the window is unknown", () => {
    const fitted = fitMessagesToModelContext(history(text(BASE64)), {});
    expect(
      estimateModelTokens(toolOutput(fitted.messages, "c1").value),
    ).toBeLessThan(MAX_TOOL_RESULT_TOKENS);
  });

  it("is idempotent", () => {
    const once = fitMessagesToModelContext(history(text(BASE64)), {
      contextTokens: 200_000,
    });
    const twice = fitMessagesToModelContext(once.messages, {
      contextTokens: 200_000,
    });
    expect(twice.messages).toEqual(once.messages);
  });

  it("never mutates its input", () => {
    const messages = history(text(BASE64));
    const snapshot = structuredClone(messages);
    fitMessagesToModelContext(messages, { contextTokens: 200_000 });
    expect(messages).toEqual(snapshot);
  });
});

describe("fitMessagesToModelContext: clear", () => {
  const WINDOW = 100_000;
  /** One earlier turn per id, each with a 20K-token result. */
  function earlierTurns(
    ids: string[],
    toolName = "get_shipment_events",
  ): ModelMessage[] {
    return ids.flatMap((id) => [
      { role: "user", content: `turn ${id}` } as ModelMessage,
      call(id, toolName),
      result(id, toolName, text(prose(20_000))),
      { role: "assistant", content: `answer ${id}` } as ModelMessage,
    ]);
  }

  it("clears nothing while the earlier turns stay under 60% of the window", () => {
    const messages = [
      ...earlierTurns(["a", "b"]),
      { role: "user", content: "next" } as ModelMessage,
    ];
    const fitted = fitMessagesToModelContext(messages, {
      contextTokens: WINDOW,
    });
    expect(fitted.report).toBeUndefined();
  });

  it("clears the oldest earlier results in batches of 20% of the window", () => {
    const messages = [
      ...earlierTurns(["a", "b", "c", "d"]),
      { role: "user", content: "next" } as ModelMessage,
    ];
    const fitted = fitMessagesToModelContext(messages, {
      contextTokens: WINDOW,
    });
    // Just over 80K estimated: three 20K batches bring it under the 40% target.
    expect(fitted.report?.cleared.map((entry) => entry.toolCallId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(toolOutput(fitted.messages, "a")).toEqual({
      type: "text",
      value: CLEARED_TOOL_RESULT_TEXT,
    });
    expect(toolOutput(fitted.messages, "d").value).toBe(prose(20_000));
  });

  it("keeps every result of the current turn, including parallel calls", () => {
    const parallel: ModelMessage[] = [
      { role: "user", content: "look up four shipments" },
      {
        role: "assistant",
        content: ["p1", "p2", "p3", "p4"].map((id) => ({
          type: "tool-call" as const,
          toolCallId: id,
          toolName: "get_shipment_events",
          input: {},
        })),
      },
      {
        role: "tool",
        content: ["p1", "p2", "p3", "p4"].map(
          (id) =>
            ({
              type: "tool-result",
              toolCallId: id,
              toolName: "get_shipment_events",
              output: text(prose(20_000)),
            }) as never,
        ),
      },
    ];
    const fitted = fitMessagesToModelContext(parallel, {
      contextTokens: WINDOW,
    });
    expect(fitted.report).toBeUndefined();
  });

  it("never clears skill loads, denials or small results", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      call("skill", "loadSkill"),
      result("skill", "loadSkill", text(prose(20_000))),
      call("denied", "delete_quote"),
      result("denied", "delete_quote", {
        type: "execution-denied",
        reason: "no",
      }),
      call("small", "get_status"),
      result("small", "get_status", text(prose(500))),
      ...earlierTurns(["a", "b", "c"]),
      { role: "user", content: "next" },
    ];
    const fitted = fitMessagesToModelContext(messages, {
      contextTokens: WINDOW,
    });
    const cleared =
      fitted.report?.cleared.map((entry) => entry.toolCallId) ?? [];
    expect(cleared).not.toContain("skill");
    expect(cleared).not.toContain("denied");
    expect(cleared).not.toContain("small");
    expect(cleared[0]).toBe("a");
  });

  it("never clears without a known window", () => {
    const messages = [
      ...earlierTurns(["a", "b", "c", "d", "e"]),
      { role: "user", content: "next" } as ModelMessage,
    ];
    expect(fitMessagesToModelContext(messages, {}).report).toBeUndefined();
  });

  it("counts fixed tokens toward the trigger", () => {
    const messages = [
      ...earlierTurns(["a", "b"]),
      { role: "user", content: "next" } as ModelMessage,
    ];
    const fitted = fitMessagesToModelContext(messages, {
      contextTokens: WINDOW,
      fixedTokens: 30_000,
    });
    expect(fitted.report?.cleared.length).toBeGreaterThan(0);
  });

  it("does not count an image in an earlier turn by its size", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "take a screenshot" },
      call("shot", "screenshot"),
      result("shot", "screenshot", {
        type: "content",
        value: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "iVBOR".repeat(300_000) },
          },
        ],
      }),
      ...earlierTurns(["a"]),
      { role: "user", content: "next" },
    ];
    expect(
      fitMessagesToModelContext(messages, { contextTokens: WINDOW }).report,
    ).toBeUndefined();
  });

  it("drops earlier-turn reasoning when it clears, so no replayed thinking follows an edit", () => {
    const reasoningTurn: ModelMessage[] = [
      { role: "user", content: "turn r" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking about it" },
          {
            type: "tool-call",
            toolCallId: "r",
            toolName: "get_shipment_events",
            input: {},
          },
        ],
      },
      result("r", "get_shipment_events", text(prose(20_000))),
    ];
    const messages = [
      ...earlierTurns(["a", "b", "c", "d"]),
      ...reasoningTurn,
      { role: "user", content: "next" } as ModelMessage,
    ];
    const reasoningOf = (fitted: { messages: ModelMessage[] }) =>
      fitted.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Array<{ type: string }>).filter(
              (part) => part.type === "reasoning",
            )
          : [],
      );
    const dropped = fitMessagesToModelContext(messages, {
      contextTokens: WINDOW,
      dropEarlierReasoning: true,
    });
    expect(dropped.report?.cleared.length).toBeGreaterThan(0);
    expect(reasoningOf(dropped)).toEqual([]);
    // OpenAI Responses replays a reply by id and rejects it without its
    // reasoning item, so a caller on that API keeps it.
    const kept = fitMessagesToModelContext(messages, { contextTokens: WINDOW });
    expect(kept.report?.cleared.length).toBeGreaterThan(0);
    expect(reasoningOf(kept)).toHaveLength(1);
  });

  it("keeps reasoning when nothing is cleared", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hello" },
        ],
      },
      { role: "user", content: "again" },
    ];
    expect(
      fitMessagesToModelContext(messages, { contextTokens: WINDOW }).messages,
    ).toBe(messages);
  });

  it("decides the same cleared set on every step of a turn", () => {
    const turnStart = [
      ...earlierTurns(["a", "b", "c", "d"]),
      { role: "user", content: "next" } as ModelMessage,
    ];
    const laterStep = [
      ...turnStart,
      call("now", "get_shipment_events"),
      result("now", "get_shipment_events", text(prose(20_000))),
    ];
    const first = fitMessagesToModelContext(turnStart, {
      contextTokens: WINDOW,
    });
    const later = fitMessagesToModelContext(laterStep, {
      contextTokens: WINDOW,
    });
    expect(later.report?.cleared).toEqual(first.report?.cleared);
  });
});
