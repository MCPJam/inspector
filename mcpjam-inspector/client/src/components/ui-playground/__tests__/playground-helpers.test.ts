import { describe, expect, it, vi } from "vitest";
import type { DynamicToolUIPart } from "ai";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateId: () => "fixed-id",
  };
});

import { createDeterministicToolMessages } from "../playground-helpers";

describe("createDeterministicToolMessages", () => {
  // ── Text extraction from various result shapes ──

  it("injects text output for non-UI tools (content array)", () => {
    const { messages } = createDeterministicToolMessages(
      "read_me",
      { path: "/tmp/readme.md" },
      {
        content: [
          { type: "text", text: "First line" },
          { type: "text", text: "Second line" },
        ],
      },
      undefined,
    );

    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toHaveLength(3);
    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "First line\n\nSecond line",
    });
  });

  it("injects text output when result is a plain string", () => {
    const { messages } = createDeterministicToolMessages(
      "echo",
      {},
      "hello world",
      undefined,
    );

    expect(messages[1].parts).toHaveLength(3);
    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "hello world",
    });
  });

  it("injects text output when result has a top-level text field", () => {
    const { messages } = createDeterministicToolMessages(
      "summarize",
      {},
      { text: "Summary here" },
      undefined,
    );

    expect(messages[1].parts).toHaveLength(3);
    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "Summary here",
    });
  });

  it("does not inject text part when content array is empty", () => {
    const { messages } = createDeterministicToolMessages(
      "noop",
      {},
      { content: [] },
      undefined,
    );

    // Only invocation text + tool part, no text extraction
    expect(messages[1].parts).toHaveLength(2);
  });

  it("does not inject text part when result is null", () => {
    const { messages } = createDeterministicToolMessages(
      "fire_and_forget",
      {},
      null,
      undefined,
    );

    expect(messages[1].parts).toHaveLength(2);
  });

  it("does not inject text part when result is undefined", () => {
    const { messages } = createDeterministicToolMessages(
      "fire_and_forget",
      {},
      undefined,
      undefined,
    );

    expect(messages[1].parts).toHaveLength(2);
  });

  it("does not inject text part for empty string result", () => {
    const { messages } = createDeterministicToolMessages(
      "empty",
      {},
      "",
      undefined,
    );

    expect(messages[1].parts).toHaveLength(2);
  });

  it("does not inject text part for whitespace-only string result", () => {
    const { messages } = createDeterministicToolMessages(
      "empty",
      {},
      "   ",
      undefined,
    );

    expect(messages[1].parts).toHaveLength(2);
  });

  it("skips non-text content blocks in the content array", () => {
    const { messages } = createDeterministicToolMessages(
      "mixed",
      {},
      {
        content: [
          { type: "image", url: "https://example.com/img.png" },
          { type: "text", text: "Only this" },
          { type: "resource", uri: "file:///tmp/data" },
        ],
      },
      undefined,
    );

    expect(messages[1].parts).toHaveLength(3);
    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "Only this",
    });
  });

  it("skips whitespace-only text blocks in the content array", () => {
    const { messages } = createDeterministicToolMessages(
      "sparse",
      {},
      {
        content: [
          { type: "text", text: "  " },
          { type: "text", text: "real content" },
          { type: "text", text: "" },
        ],
      },
      undefined,
    );

    expect(messages[1].parts).toHaveLength(3);
    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "real content",
    });
  });

  // ── UI-capable tools should NOT get duplicate text ──

  it("does not inject duplicate text output for UI-capable tools (OpenAI SDK)", () => {
    const { messages } = createDeterministicToolMessages(
      "create_view",
      { title: "Diagram" },
      {
        content: [{ type: "text", text: "Widget data" }],
      },
      {
        "openai/outputTemplate": "ui://widget/template.html",
      },
    );

    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toHaveLength(2);
  });

  it("does not inject duplicate text output for MCP Apps tools", () => {
    const { messages } = createDeterministicToolMessages(
      "render_chart",
      {},
      {
        content: [{ type: "text", text: "chart data" }],
      },
      {
        // ui.resourceUri triggers MCP_APPS detection
        ui: { resourceUri: "ui://chart/render.html" },
      },
    );

    expect(messages[1].parts).toHaveLength(2);
  });

  // ── Error state ──

  it("injects text error details for non-UI tool failures", () => {
    const { messages } = createDeterministicToolMessages(
      "read_me",
      {},
      null,
      undefined,
      {
        state: "output-error",
        errorText: "Permission denied",
      },
    );

    expect(messages).toHaveLength(2);
    expect(messages[1].parts).toHaveLength(3);
    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "Tool error: Permission denied",
    });

    const toolPart = messages[1].parts[1] as DynamicToolUIPart;
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("Permission denied");
  });

  it("uses 'Unknown error' when errorText is not provided", () => {
    const { messages } = createDeterministicToolMessages(
      "broken",
      {},
      null,
      undefined,
      {
        state: "output-error",
      },
    );

    expect(messages[1].parts[2]).toMatchObject({
      type: "text",
      text: "Tool error: Unknown error",
    });
  });

  it("does not inject error text for UI-capable tool failures", () => {
    const { messages } = createDeterministicToolMessages(
      "render_chart",
      {},
      null,
      { "openai/outputTemplate": "ui://chart/template.html" },
      {
        state: "output-error",
        errorText: "Render failed",
      },
    );

    // Only invocation text + tool part (error surfaced via widget)
    expect(messages[1].parts).toHaveLength(2);
  });

  // ── Message structure ──

  it("generates user and assistant messages with correct IDs", () => {
    const { messages, toolCallId } = createDeterministicToolMessages(
      "my_tool",
      { key: "val" },
      { text: "result" },
      undefined,
    );

    expect(toolCallId).toBe("playground-fixed-id");
    expect(messages[0].id).toBe("user-playground-fixed-id");
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts[0]).toMatchObject({
      type: "text",
      text: "Execute `my_tool`",
    });

    expect(messages[1].id).toBe("assistant-playground-fixed-id");
    expect(messages[1].role).toBe("assistant");
  });

  it("uses custom invoked message from tool metadata", () => {
    const { messages } = createDeterministicToolMessages(
      "my_tool",
      {},
      { text: "ok" },
      { "openai/toolInvocation/invoked": "Running custom action..." },
    );

    expect(messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Running custom action...",
    });
  });

  it("falls back to default invocation message without custom metadata", () => {
    const { messages } = createDeterministicToolMessages(
      "my_tool",
      {},
      { text: "ok" },
      undefined,
    );

    expect(messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Invoked `my_tool`",
    });
  });

  it("throws when toolName is empty", () => {
    expect(() =>
      createDeterministicToolMessages("", {}, null, undefined),
    ).toThrow("toolName is required");
  });

  // ── Tool part shape ──

  it("sets output-available state with result in tool part by default", () => {
    const result = { content: [{ type: "text", text: "data" }] };
    const { messages } = createDeterministicToolMessages(
      "fetch",
      { url: "https://example.com" },
      result,
      undefined,
    );

    const toolPart = messages[1].parts[1] as DynamicToolUIPart;
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.toolName).toBe("fetch");
    expect(toolPart.state).toBe("output-available");
    expect((toolPart as any).input).toEqual({ url: "https://example.com" });
    expect((toolPart as any).output).toBe(result);
  });
});
