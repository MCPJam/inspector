import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  createLinkedResourceServerIdResolver,
  convertToMcpjamModelMessages,
  mapMcpImageToolOutputs,
} from "../mcp-tool-result-model-output.js";

describe("mapMcpImageToolOutputs", () => {
  const imageResult = {
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  };

  const toolMessages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "qa_return_image_tool_result",
          output: {
            type: "json",
            value: imageResult,
          },
        },
      ],
    },
  ] as unknown as ModelMessage[];

  it("maps direct MCP image tool outputs to model-visible media output when enabled", async () => {
    await expect(
      mapMcpImageToolOutputs(toolMessages, {
        modelVisibleMcpImageToolResults: true,
      })
    ).resolves.toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_image_tool_result",
            output: {
              type: "content",
              value: [
                {
                  type: "media",
                  data: "aGVsbG8=",
                  mediaType: "image/png",
                },
              ],
            },
          },
        ],
      },
    ]);
  });

  it("leaves direct MCP image tool outputs as JSON when disabled", async () => {
    await expect(mapMcpImageToolOutputs(toolMessages)).resolves.toBe(
      toolMessages
    );
  });

  it("maps embedded MCP image resources to model-visible media output", async () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_embedded_image_resource",
            output: {
              type: "json",
              value: {
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
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
    });

    expect((mapped[0] as any).content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("resolves linked MCP image resources from JSON history with serverId", async () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_linked_image_resource",
            serverId: "srv-1",
            output: {
              type: "json",
              value: {
                content: [
                  {
                    type: "resource_link",
                    uri: "mcp://images/one",
                    name: "one.png",
                    mimeType: "image/png",
                  },
                ],
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const readLinkedResource = vi.fn(
      async ({
        uri,
      }: {
        serverId: string;
        uri: string;
        options?: { abortSignal?: AbortSignal };
      }) => ({
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
      })
    );

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
      readLinkedResource,
    });

    expect((mapped[0] as any).content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(readLinkedResource).toHaveBeenCalledWith({
      serverId: "srv-1",
      uri: "mcp://images/one",
      options: undefined,
    });
  });

  it("resolves linked MCP image resources when only the tool call has server metadata", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "qa_return_linked_image_resource",
            input: {},
            providerOptions: { mcpjam: { serverId: "srv-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_linked_image_resource",
            output: {
              type: "json",
              value: {
                content: [
                  {
                    type: "resource_link",
                    uri: "mcp://images/one",
                    name: "one.png",
                    mimeType: "image/png",
                  },
                ],
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const readLinkedResource = vi.fn(
      async ({
        uri,
      }: {
        serverId: string;
        uri: string;
        options?: { abortSignal?: AbortSignal };
      }) => ({
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
      })
    );

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
      readLinkedResource,
    });

    expect((mapped[1] as any).content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(readLinkedResource).toHaveBeenCalledWith({
      serverId: "srv-1",
      uri: "mcp://images/one",
      options: undefined,
    });
    expect((mapped[0] as any).content[0].providerOptions).toBeUndefined();
  });

  it("unwraps nested JSON tool output before resolving linked MCP image resources", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "playground-call-1",
            toolName: "qa_return_linked_image_resource",
            input: {},
            providerOptions: { mcpjam: { serverId: "qa-server" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "playground-call-1",
            toolName: "qa_return_linked_image_resource",
            output: {
              type: "json",
              value: {
                type: "json",
                value: {
                  content: [
                    {
                      mimeType: "image/png",
                      name: "Linked PNG resource",
                      type: "resource_link",
                      uri: "example://linked-image.png",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const readLinkedResource = vi.fn(
      async ({
        uri,
      }: {
        serverId: string;
        uri: string;
        options?: { abortSignal?: AbortSignal };
      }) => ({
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
      })
    );

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
      readLinkedResource,
    });

    expect((mapped[1] as any).content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(readLinkedResource).toHaveBeenCalledWith({
      serverId: "qa-server",
      uri: "example://linked-image.png",
      options: undefined,
    });
  });

  it("restores replayed model-visible image output wrapped as JSON", async () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_image_tool_result",
            output: {
              type: "json",
              value: {
                type: "content",
                value: [
                  {
                    type: "media",
                    data: "aGVsbG8=",
                    mediaType: "image/png",
                  },
                ],
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
    });

    expect((mapped[0] as any).content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("keeps unrelated content-shaped JSON tool outputs on the JSON path", async () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "returns_content_json",
            output: {
              type: "json",
              value: {
                type: "content",
                value: [{ type: "text", text: "plain user payload" }],
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
    });

    expect((mapped[0] as any).content[0].output).toEqual({
      type: "json",
      value: {
        type: "content",
        value: [{ type: "text", text: "plain user payload" }],
      },
    });
  });

  it("resolves no-metadata linked MCP image resources through the server-id resolver", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Execute it" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Invoked `qa_return_linked_image_resource`",
          },
          {
            type: "tool-call",
            toolCallId: "playground-L6XNQZ9X4Swm2LUv",
            toolName: "qa_return_linked_image_resource",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "playground-L6XNQZ9X4Swm2LUv",
            toolName: "qa_return_linked_image_resource",
            output: {
              type: "json",
              value: {
                type: "json",
                value: {
                  content: [
                    {
                      mimeType: "image/png",
                      name: "Linked PNG resource",
                      type: "resource_link",
                      uri: "example://linked-image.png",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const resolveLinkedResourceServerId = vi.fn(async () => "qa-server");
    const readLinkedResource = vi.fn(
      async ({
        uri,
      }: {
        serverId: string;
        uri: string;
        options?: { abortSignal?: AbortSignal };
      }) => ({
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
      })
    );

    const mapped = await mapMcpImageToolOutputs(messages, {
      modelVisibleMcpImageToolResults: true,
      resolveLinkedResourceServerId,
      readLinkedResource,
    });

    expect((mapped[2] as any).content[0].output).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(resolveLinkedResourceServerId).toHaveBeenCalledWith({
      toolCallId: "playground-L6XNQZ9X4Swm2LUv",
      toolName: "qa_return_linked_image_resource",
    });
    expect(readLinkedResource).toHaveBeenCalledWith({
      serverId: "qa-server",
      uri: "example://linked-image.png",
      options: undefined,
    });
  });

  it("only falls back to a linked-resource server id for unique selected tool names", async () => {
    const listTools = vi.fn(async (serverId: string) => ({
      tools:
        serverId === "srv-1"
          ? [{ name: "unique_tool" }, { name: "shared_tool" }]
          : [{ name: "shared_tool" }],
    }));
    const resolver = createLinkedResourceServerIdResolver({
      serverIds: ["srv-1", "srv-2"],
      listTools,
    });

    await expect(resolver({ toolName: "unique_tool" })).resolves.toBe("srv-1");
    await expect(resolver({ toolName: "shared_tool" })).resolves.toBeUndefined();
  });

  it("resolves linked MCP image resources after UI-message conversion", async () => {
    const readLinkedResource = vi.fn(
      async ({
        uri,
      }: {
        serverId: string;
        uri: string;
        options?: { abortSignal?: AbortSignal };
      }) => ({
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
      })
    );

    const mapped = await convertToMcpjamModelMessages(
      [
        {
          id: "msg-1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "call-1",
              toolName: "qa_return_linked_image_resource",
              state: "output-available",
              input: {},
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
              callProviderMetadata: {
                mcpjam: { serverId: "srv-1" },
              },
            },
          ],
        },
      ] as any,
      {
        modelVisibleMcpImageToolResults: true,
        readLinkedResource,
      }
    );

    expect(mapped).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "qa_return_linked_image_resource",
            input: {},
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_linked_image_resource",
            output: {
              type: "content",
              value: [
                {
                  type: "media",
                  data: "aGVsbG8=",
                  mediaType: "image/png",
                },
              ],
            },
          },
        ],
      },
    ]);
    expect(readLinkedResource).toHaveBeenCalledWith({
      serverId: "srv-1",
      uri: "mcp://images/one",
      options: undefined,
    });
  });

  it("restores direct MCP image output after UI-message conversion", async () => {
    const mapped = await convertToMcpjamModelMessages(
      [
        {
          id: "msg-1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "call-1",
              toolName: "qa_return_image_tool_result",
              state: "output-available",
              input: {},
              output: {
                type: "content",
                value: [
                  {
                    type: "media",
                    data: "aGVsbG8=",
                    mediaType: "image/png",
                  },
                ],
              },
            },
          ],
        },
      ] as any,
      {
        modelVisibleMcpImageToolResults: true,
      }
    );

    expect(mapped).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "qa_return_image_tool_result",
            input: {},
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "qa_return_image_tool_result",
            output: {
              type: "content",
              value: [
                {
                  type: "media",
                  data: "aGVsbG8=",
                  mediaType: "image/png",
                },
              ],
            },
          },
        ],
      },
    ]);
  });
});
