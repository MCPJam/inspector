import { describe, it, expect, vi } from "vitest";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
  type TraceMessage,
  type TraceWidgetSnapshot,
} from "../trace-viewer-adapter";

// Mock external dependencies used by the adapter
vi.mock("@mcp-ui/client", () => ({
  isUIResource: (value: Record<string, unknown>) =>
    !!value?.resource &&
    typeof (value.resource as Record<string, unknown>).uri === "string" &&
    (value.resource as Record<string, unknown>).uri
      ?.toString()
      .startsWith("ui://"),
}));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  getToolUiResourceUri: (tool: { _meta?: Record<string, unknown> }) => {
    const uri = (tool._meta?.ui as Record<string, unknown> | undefined)
      ?.resourceUri;
    return typeof uri === "string" ? uri : undefined;
  },
}));

// Helper to build a minimal widget snapshot
function makeWidgetSnapshot(
  overrides: Partial<TraceWidgetSnapshot> = {},
): TraceWidgetSnapshot {
  return {
    toolCallId: "call-1",
    toolName: "create_view",
    protocol: "mcp-apps",
    serverId: "server-1",
    resourceUri: "ui://widget/create-view.html",
    toolMetadata: { ui: { resourceUri: "ui://widget/create-view.html" } },
    widgetCsp: null,
    widgetPermissions: null,
    widgetPermissive: true,
    prefersBorder: true,
    ...overrides,
  };
}

describe("adaptTraceToUiMessages", () => {
  // --- Test 1: Text + tool-call + tool-result grouping ---
  it("groups assistant text + tool-call with matching tool-result into a single UIMessage", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me do that." },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "get_data",
              input: { id: 42 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "get_data",
              output: { type: "json", value: { text: "result text" } },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");

    // text, dynamic-tool, text-fallback
    expect(msg.parts.length).toBeGreaterThanOrEqual(3);
    expect(msg.parts[0]).toEqual({ type: "text", text: "Let me do that." });
    expect(msg.parts[1]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "call-1",
      toolName: "get_data",
      state: "output-available",
    });
    // text fallback from tool result
    expect(msg.parts[2]).toMatchObject({ type: "text" });
  });

  it("attaches readable tool output to the tool part in attached-to-tool mode", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me do that." },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_me",
              input: { id: 42 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read_me",
              output: { type: "json", value: { text: "result text" } },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({
      trace,
      toolResultDisplay: "attached-to-tool",
    });
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0];
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[1]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "call-1",
      toolName: "read_me",
      traceDisplayText: "result text",
      traceDisplayMode: "markdown",
    });
    expect(
      msg.parts.find((part) => part.type === "text" && part !== msg.parts[0]),
    ).toBeUndefined();
  });

  it("attaches structured tool output as json markdown in attached-to-tool mode", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_me",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read_me",
              output: { hello: "world" },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({
      trace,
      toolResultDisplay: "attached-to-tool",
    });

    expect(result.messages[0].parts).toHaveLength(1);
    expect(result.messages[0].parts[0]).toMatchObject({
      type: "dynamic-tool",
      traceDisplayMode: "json-markdown",
    });
    expect((result.messages[0].parts[0] as any).traceDisplayText).toContain(
      '"hello": "world"',
    );
  });

  // --- Test 2: Multiple tool calls ---
  it("groups multiple tool-calls and results into a single assistant UIMessage", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "tool_a",
              input: {},
            },
            {
              type: "tool-call",
              toolCallId: "call-2",
              toolName: "tool_b",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "tool_a",
              output: "result-a",
            },
            {
              type: "tool-result",
              toolCallId: "call-2",
              toolName: "tool_b",
              output: "result-b",
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0];
    const dynamicTools = msg.parts.filter((p) => p.type === "dynamic-tool");
    expect(dynamicTools).toHaveLength(2);
    expect(dynamicTools[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "tool_a",
    });
    expect(dynamicTools[1]).toMatchObject({
      toolCallId: "call-2",
      toolName: "tool_b",
    });
  });

  // --- Test 3: Orphan tool-results ---
  it("creates synthetic assistant UIMessage for orphan tool-results", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphan-1",
              toolName: "orphan_tool",
              output: "orphan output",
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.parts.some((p) => p.type === "dynamic-tool")).toBe(true);
  });

  // --- Test 4: String content ---
  it("normalizes string content into a text part", () => {
    const trace: TraceMessage[] = [{ role: "user", content: "Hello" }];

    const result = adaptTraceToUiMessages({ trace });
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0];
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([{ type: "text", text: "Hello" }]);
  });

  // --- Test 5: Missing toolCallId ---
  it("assigns deterministic synthetic ID when toolCallId is missing", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "my_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "my_tool",
              output: "done",
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const toolPart = result.messages[0].parts.find(
      (p) => p.type === "dynamic-tool",
    );
    expect(toolPart).toBeDefined();
    expect((toolPart as any).toolCallId).toBe("trace-tool-0-0-my_tool");
  });

  // --- Test 6: Deterministic synthetic IDs ---
  it("produces identical output for identical input across calls and does not mutate input", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "stable_tool",
              input: { x: 1 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "stable_tool",
              output: "stable output",
            },
          ],
        },
      ],
    };

    const traceBefore = JSON.parse(JSON.stringify(trace));

    const result1 = adaptTraceToUiMessages({ trace });
    const result2 = adaptTraceToUiMessages({ trace });

    expect(result1).toEqual(result2);

    // The original trace must not have been mutated
    expect(trace).toEqual(traceBefore);
  });

  // --- Test 7: _meta / _serverId preservation ---
  it("preserves _serverId from tool-result output", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-srv",
              toolName: "srv_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-srv",
              toolName: "srv_tool",
              output: {
                type: "json",
                value: { _serverId: "server-original", data: 1 },
              },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const toolPart = result.messages[0].parts.find(
      (p) => p.type === "dynamic-tool",
    ) as any;
    expect(toolPart.output._serverId).toBe("server-original");
  });

  it("merges serverId field from tool-result part onto output", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-merge",
              toolName: "merge_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-merge",
              toolName: "merge_tool",
              serverId: "merged-server",
              result: { data: "hello" },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const toolPart = result.messages[0].parts.find(
      (p) => p.type === "dynamic-tool",
    ) as any;
    expect(toolPart.output._serverId).toBe("merged-server");
  });

  // --- Test 8: Text extraction vs fenced-JSON fallback ---
  it("appends extracted text when tool output has extractable text", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-text",
              toolName: "text_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-text",
              toolName: "text_tool",
              output: {
                type: "json",
                value: {
                  content: [{ type: "text", text: "extracted content" }],
                },
              },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const textParts = result.messages[0].parts.filter((p) => p.type === "text");
    expect(textParts.some((p) => (p as any).text === "extracted content")).toBe(
      true,
    );
  });

  it("appends fenced JSON when tool output has only structured data", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-json",
              toolName: "json_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-json",
              toolName: "json_tool",
              output: {
                type: "json",
                value: { count: 5, items: ["a", "b"] },
              },
            },
          ],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const textParts = result.messages[0].parts.filter((p) => p.type === "text");
    const jsonFallback = textParts.find((p) =>
      (p as any).text?.startsWith("```json"),
    );
    expect(jsonFallback).toBeDefined();
  });

  // --- Test 9: Reasoning parts with no state ---
  it("passes through reasoning parts unchanged", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "thinking..." } as any],
        },
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    expect(result.messages).toHaveLength(1);

    const reasoningPart = result.messages[0].parts.find(
      (p) => (p as any).type === "reasoning",
    );
    expect(reasoningPart).toBeDefined();
    expect((reasoningPart as any).text).toBe("thinking...");
  });

  // --- Test 10: Offline snapshot replay ---
  it("creates replay override with cachedWidgetHtmlUrl and isOffline when snapshot has widgetHtmlUrl", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "create_view",
              input: { title: "Flow" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "create_view",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
      widgetSnapshots: [
        makeWidgetSnapshot({
          widgetHtmlUrl: "https://storage.example.com/widget.html",
        }),
      ],
    };

    // No connected servers — offline replay should still work
    const result = adaptTraceToUiMessages({ trace });

    expect(result.toolRenderOverrides["call-1"]).toBeDefined();
    expect(result.toolRenderOverrides["call-1"].cachedWidgetHtmlUrl).toBe(
      "https://storage.example.com/widget.html",
    );
    expect(result.toolRenderOverrides["call-1"].isOffline).toBe(true);
  });

  it("treats nested result.isError tool-results as output errors", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-error",
              toolName: "create_view",
              input: { elements: "[]" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-error",
              toolName: "create_view",
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Invalid JSON in elements",
                  },
                ],
              },
            },
          ],
        },
      ],
      widgetSnapshots: [
        makeWidgetSnapshot({
          toolCallId: "call-error",
          widgetHtmlUrl: "https://storage.example.com/error-widget.html",
        }),
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const toolPart = result.messages[0].parts.find(
      (part) => part.type === "dynamic-tool",
    ) as any;
    const textParts = result.messages[0].parts.filter(
      (part) => part.type === "text",
    ) as Array<{ text?: string }>;

    expect(toolPart.state).toBe("output-error");
    expect(result.toolRenderOverrides["call-error"]).toBeUndefined();
    expect(
      textParts.some(
        (part) => part.text === "Tool error: Invalid JSON in elements",
      ),
    ).toBe(true);
  });

  it("skips replay for failed widget calls but still replays later successful snapshots", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-error",
              toolName: "create_view",
              input: { elements: '[{"type":"rectangle"}]' },
            },
            {
              type: "tool-call",
              toolCallId: "call-success",
              toolName: "create_view",
              input: { elements: '[{"type":"ellipse"}]' },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-error",
              toolName: "create_view",
              output: {
                type: "json",
                value: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "Invalid JSON in elements",
                    },
                  ],
                },
              },
            },
            {
              type: "tool-result",
              toolCallId: "call-success",
              toolName: "create_view",
              output: {
                type: "json",
                value: { ok: true },
              },
            },
          ],
        },
      ],
      widgetSnapshots: [
        makeWidgetSnapshot({
          toolCallId: "call-error",
          widgetHtmlUrl: "https://storage.example.com/error-widget.html",
        }),
        makeWidgetSnapshot({
          toolCallId: "call-success",
          widgetHtmlUrl: "https://storage.example.com/success-widget.html",
        }),
      ],
    };

    const result = adaptTraceToUiMessages({ trace });
    const dynamicTools = result.messages[0].parts.filter(
      (part) => part.type === "dynamic-tool",
    ) as any[];

    expect(dynamicTools[0].toolCallId).toBe("call-error");
    expect(dynamicTools[0].state).toBe("output-error");
    expect(dynamicTools[1].toolCallId).toBe("call-success");
    expect(dynamicTools[1].state).toBe("output-available");
    expect(result.toolRenderOverrides["call-error"]).toBeUndefined();
    expect(result.toolRenderOverrides["call-success"]).toBeDefined();
    expect(result.toolRenderOverrides["call-success"].cachedWidgetHtmlUrl).toBe(
      "https://storage.example.com/success-widget.html",
    );
  });

  // --- Test 11: Widget scrub when no replay possible ---
  it("scrubs widget output and sets empty toolMetadata when no replay is possible", () => {
    const trace: TraceEnvelope = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-widget",
              toolName: "widget_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-widget",
              toolName: "widget_tool",
              output: {
                type: "json",
                value: {
                  _meta: {
                    ui: { resourceUri: "ui://test/widget.html" },
                  },
                  content: [
                    {
                      type: "resource",
                      resource: { uri: "ui://test/widget.html", text: "html" },
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    };

    // No snapshot, no connected servers → scrub
    const result = adaptTraceToUiMessages({
      trace,
      toolsMetadata: {
        widget_tool: { ui: { resourceUri: "ui://test/widget.html" } },
      },
    });

    expect(result.toolRenderOverrides["call-widget"]).toBeDefined();
    expect(result.toolRenderOverrides["call-widget"].toolMetadata).toEqual({});

    // The dynamic-tool output should be scrubbed (no resource content)
    const toolPart = result.messages[0].parts.find(
      (p) => p.type === "dynamic-tool",
    ) as any;
    expect(toolPart.output).toBeDefined();

    // Resource with ui:// URI should be removed
    const outputContent = (toolPart.output as Record<string, unknown>)?.content;
    if (Array.isArray(outputContent)) {
      const uiResources = outputContent.filter((item: any) =>
        item?.resource?.uri?.startsWith("ui://"),
      );
      expect(uiResources).toHaveLength(0);
    }
  });
});
