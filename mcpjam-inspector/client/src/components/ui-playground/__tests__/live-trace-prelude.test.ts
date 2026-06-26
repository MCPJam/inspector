import { describe, expect, it } from "vitest";
import { buildPreludeTraceEnvelope } from "../live-trace-prelude";

describe("buildPreludeTraceEnvelope", () => {
  it("maps direct MCP image tool results to model-visible media output", () => {
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
      { modelVisibleMcpImageToolResults: true }
    );

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("maps embedded MCP image resources to model-visible media output", () => {
    const envelope = buildPreludeTraceEnvelope(
      [
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
      ],
      { modelVisibleMcpImageToolResults: true }
    );

    const toolMessage = envelope?.messages[2] as {
      content: Array<{ output: unknown }>;
    };

    expect(toolMessage.content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("keeps direct MCP image tool results as JSON by default", () => {
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
      type: "json",
      value: {
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      },
    });
  });
});
