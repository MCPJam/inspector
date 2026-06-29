import { describe, expect, it, vi } from "vitest";
import { buildPreludeTraceEnvelope } from "../live-trace-prelude";

describe("buildPreludeTraceEnvelope", () => {
  it("maps direct MCP image tool results to model-visible media output", () => {
    const envelope = buildPreludeTraceEnvelope([
      {
        toolCallId: "playground-tool-1",
        toolName: "qa_return_image_tool_result",
        params: {},
        state: "output-available",
        result: {
          content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
      },
    ]);

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("maps embedded MCP image resources to model-visible media output", () => {
    const envelope = buildPreludeTraceEnvelope([
      {
        toolCallId: "playground-tool-1",
        toolName: "qa_return_embedded_image_resource",
        params: {},
        state: "output-available",
        result: {
          content: [
            {
              type: "resource",
              resource: {
                uri: "mcp://images/one",
                blob: "aGVsbG8=",
                mimeType: "image/png",
              },
            },
          ],
        },
      },
    ]);

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("maps direct MCP image tool results by default", () => {
    const envelope = buildPreludeTraceEnvelope([
      {
        toolCallId: "playground-tool-1",
        toolName: "qa_return_image_tool_result",
        params: {},
        state: "output-available",
        result: {
          content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
      },
    ]);

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("omits direct MCP image tool results when disabled", () => {
    const envelope = buildPreludeTraceEnvelope(
      [
        {
          toolCallId: "playground-tool-1",
          toolName: "qa_return_image_tool_result",
          params: {},
          state: "output-available",
          result: {
            content: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        },
      ],
      {
        modelVisibleMcpToolResults: {
          directContent: { image: false },
        },
      }
    );

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [
        { type: "text", text: "[image omitted: direct image policy disabled]" },
      ],
    });
  });

  it("falls back to JSON if backup image conversion throws", async () => {
    vi.resetModules();
    vi.doMock("@mcpjam/sdk/browser", () => ({
      mcpCallToolResultToModelOutput: () => {
        throw new Error("converter failed");
      },
    }));

    try {
      const { buildPreludeTraceEnvelope: buildWithThrowingConverter } =
        await import("../live-trace-prelude");
      const rawResult = {
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      };
      const envelope = buildWithThrowingConverter([
        {
          toolCallId: "playground-tool-1",
          toolName: "qa_return_image_tool_result",
          params: {},
          state: "output-available",
          result: rawResult,
        },
      ]);

      const toolMessage = envelope?.messages[2] as {
        content: Array<{ output: unknown }>;
      };

      expect(toolMessage.content[0].output).toEqual({
        type: "json",
        value: rawResult,
      });
    } finally {
      vi.doUnmock("@mcpjam/sdk/browser");
      vi.resetModules();
    }
  });

  it("uses pre-resolved model output for linked MCP image resources", () => {
    const envelope = buildPreludeTraceEnvelope([
      {
        toolCallId: "playground-tool-1",
        toolName: "qa_return_linked_image_resource",
        params: {},
        state: "output-available",
        result: {
          content: [
            {
              type: "resource_link",
              uri: "example://linked-image.png",
              mimeType: "image/png",
            },
          ],
        },
        modelOutput: {
          type: "content",
          value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
        },
      },
    ]);

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });
});
