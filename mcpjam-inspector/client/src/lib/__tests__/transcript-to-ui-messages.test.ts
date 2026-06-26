import { convertToModelMessages } from "ai";
import { describe, expect, it } from "vitest";
import {
  mergeTranscriptToolResults,
  preserveHydratedMessageIds,
  transcriptToUIMessages,
} from "../transcript-to-ui-messages";

describe("transcriptToUIMessages", () => {
  it("converts basic user/assistant transcript to UIMessages", () => {
    const transcript = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toEqual([{ type: "text", text: "Hi there!" }]);
  });

  it("handles array content parts", () => {
    const transcript = [
      {
        role: "user",
        content: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
    ];

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "First" });
    expect(messages[0].parts[1]).toEqual({ type: "text", text: "Second" });
  });

  it("merges role:tool tool-result rows into the matching assistant tool-call", () => {
    const transcript = [
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          {
            type: "tool-call",
            toolCallId: "call-search-1",
            toolName: "search",
            args: { q: "cats" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-search-1",
            result: { results: [] },
          },
        ],
      },
      { role: "assistant", content: "No results found." },
    ];

    const merged = mergeTranscriptToolResults(transcript);
    expect(merged).toHaveLength(3);
    expect((merged[1] as { role?: string }).role).toBe("assistant");
    const assistantContent = (merged[1] as { content: unknown[] }).content;
    const toolCallPart = assistantContent.find(
      (p) => (p as { type?: string }).type === "tool-call"
    ) as { result?: unknown };
    expect(toolCallPart.result).toEqual({ results: [] });

    const messages = transcriptToUIMessages(transcript);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);

    const toolPart = messages[1].parts.find(
      (p) => p.type === "dynamic-tool"
    ) as
      | { type: "dynamic-tool"; toolCallId: string; output: unknown }
      | undefined;
    expect(toolPart).toBeDefined();
    expect(toolPart!.output).toEqual({ results: [] });
  });

  it("merges multiple tool-result parts from one tool message", () => {
    const transcript = [
      { role: "user", content: "run two tools" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "foo",
            args: {},
          },
          {
            type: "tool-call",
            toolCallId: "b",
            toolName: "bar",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", output: { x: 1 } },
          { type: "tool-result", toolCallId: "b", output: { y: 2 } },
        ],
      },
      { role: "assistant", content: "done" },
    ];

    const messages = transcriptToUIMessages(transcript);
    const invocations = messages[1].parts.filter(
      (p) => p.type === "dynamic-tool"
    ) as Array<{
      toolCallId: string;
      output: unknown;
    }>;
    expect(invocations).toHaveLength(2);
    expect(invocations[0].output).toEqual({ x: 1 });
    expect(invocations[1].output).toEqual({ y: 2 });
  });

  it("matches tool-call id fallback to tool-result toolCallId", () => {
    const transcript = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "legacy-id",
            toolName: "t",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "legacy-id",
            result: { ok: true },
          },
        ],
      },
    ];

    const messages = transcriptToUIMessages(transcript);
    const toolPart = messages[0].parts[0] as {
      type: string;
      output: unknown;
    };
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.output).toEqual({ ok: true });
  });

  it("prefers raw tool output when a simplified result is also present", () => {
    const rawOutput = {
      type: "json",
      value: {
        _meta: {
          ui: { resourceUri: "ui://widget/create-view.html" },
          _serverId: "server-1",
        },
        structuredContent: { checkpointId: "checkpoint-1" },
      },
    };
    const simplifiedResult = {
      structuredContent: { checkpointId: "checkpoint-1" },
    };
    const transcript = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-widget-1",
            toolName: "create_view",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-widget-1",
            output: rawOutput,
            result: simplifiedResult,
          },
        ],
      },
    ];

    const merged = mergeTranscriptToolResults(transcript);
    const mergedToolCall = ((merged[0] as { content: unknown[] }).content[0] ??
      {}) as {
      output?: unknown;
      result?: unknown;
    };
    expect(mergedToolCall.output).toEqual(rawOutput);
    expect(mergedToolCall.result).toEqual(simplifiedResult);

    const messages = transcriptToUIMessages(transcript);
    const toolPart = messages[0].parts[0] as {
      type: string;
      output: unknown;
    };
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.output).toEqual(rawOutput);
  });

  it("merged tool history converts with convertToModelMessages", async () => {
    const transcript = [
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            args: { q: "cats" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            result: { hits: 0 },
          },
        ],
      },
      { role: "assistant", content: "No hits." },
    ];

    const messages = transcriptToUIMessages(transcript);
    const modelMessages = await convertToModelMessages(messages);
    expect(Array.isArray(modelMessages)).toBe(true);
    expect(modelMessages.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves MCP tool origin metadata through transcript hydration", async () => {
    const transcript = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-image-1",
            toolName: "qa_return_linked_image_resource",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-image-1",
            output: {
              content: [
                {
                  type: "resource_link",
                  uri: "mcp://images/one",
                  name: "one.png",
                  mimeType: "image/png",
                },
              ],
            },
            providerOptions: { mcpjam: { serverId: "srv-1" } },
          },
        ],
      },
    ];

    const messages = transcriptToUIMessages(transcript);
    const toolPart = messages[0].parts[0] as any;
    expect(toolPart.callProviderMetadata).toEqual({
      mcpjam: { serverId: "srv-1" },
    });

    const modelMessages = await convertToModelMessages(messages);
    const assistantToolCall = (modelMessages[0].content as any[])[0];
    expect(assistantToolCall.providerOptions).toEqual({
      mcpjam: { serverId: "srv-1" },
    });

    const toolMessage = modelMessages.find(
      (message) => message.role === "tool"
    ) as any;
    expect(toolMessage.content[0].providerOptions).toEqual({
      mcpjam: { serverId: "srv-1" },
    });
  });

  it("generates IDs when not present", () => {
    const transcript = [{ role: "user", content: "Hi" }];
    const messages = transcriptToUIMessages(transcript);
    expect(messages[0].id).toBeTruthy();
    expect(typeof messages[0].id).toBe("string");
  });

  it("uses stable fallback IDs across repeated hydration", () => {
    const transcript = [
      { role: "user", content: "draw a dog" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "create_view",
            args: { prompt: "draw a dog" },
          },
        ],
      },
    ];

    const first = transcriptToUIMessages(transcript);
    const second = transcriptToUIMessages(transcript);

    expect(first.map((message) => message.id)).toEqual(
      second.map((message) => message.id)
    );
    expect(first[1].parts[0]).toMatchObject(second[1].parts[0]);
  });

  it("preserves existing IDs", () => {
    const transcript = [{ id: "msg-123", role: "user", content: "Hi" }];
    const messages = transcriptToUIMessages(transcript);
    expect(messages[0].id).toBe("msg-123");
  });

  it("preserves live widget message IDs when same-session hydration returns the same tool call", () => {
    const currentMessages = [
      {
        id: "live-user-start-game",
        role: "user",
        parts: [{ type: "text", text: "Execute `start_game`" }],
      },
      {
        id: "live-assistant-start-game",
        role: "assistant",
        parts: [
          { type: "text", text: "Invoked `start_game`" },
          {
            type: "dynamic-tool",
            toolCallId: "playground-widget-1",
            toolName: "start_game",
            state: "output-available",
            input: {},
            output: { board: Array(9).fill("_") },
          },
        ],
      },
    ] as any;
    const hydratedMessages = transcriptToUIMessages([
      {
        role: "user",
        content: [{ type: "text", text: "Execute `start_game`" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Invoked `start_game`" },
          {
            type: "tool-call",
            toolCallId: "playground-widget-1",
            toolName: "start_game",
            args: {},
            output: { board: ["_", "X", "_", "_", "_", "_", "_", "_", "_"] },
          },
        ],
      },
    ]);

    const stabilized = preserveHydratedMessageIds(
      currentMessages,
      hydratedMessages
    );

    expect(stabilized[0].id).toBe("live-user-start-game");
    expect(stabilized[1].id).toBe("live-assistant-start-game");
    expect((stabilized[1].parts[1] as any).output).toEqual({
      board: ["_", "X", "_", "_", "_", "_", "_", "_", "_"],
    });
  });

  it("returns empty array for non-array input", () => {
    expect(transcriptToUIMessages(null as any)).toEqual([]);
    expect(transcriptToUIMessages(undefined as any)).toEqual([]);
    expect(transcriptToUIMessages("not an array" as any)).toEqual([]);
  });

  it("handles empty transcript", () => {
    expect(transcriptToUIMessages([])).toEqual([]);
  });

  it("handles string content on messages", () => {
    const transcript = [
      { role: "assistant", content: "Simple string response" },
    ];
    const messages = transcriptToUIMessages(transcript);
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Simple string response" },
    ]);
  });
});
