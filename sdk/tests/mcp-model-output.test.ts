import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createOpenAI } from "@ai-sdk/openai";
import {
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
} from "../src/mcp-client-manager/model-output.js";

async function captureOpenAIResponsesToolOutput(output: unknown) {
  const requestBodies: unknown[] = [];
  const fetchMock = async (_url: unknown, init?: { body?: unknown }) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: "resp_1",
        created_at: 1,
        model: "gpt-test",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const model = createOpenAI({
    apiKey: "test-key",
    fetch: fetchMock as unknown as typeof fetch,
  }).responses("gpt-4.1");

  await model.doGenerate({
    prompt: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "qa_return_image_tool_result",
            output,
          },
        ],
      },
    ],
    maxOutputTokens: 16,
    headers: {},
  } as any);

  const body = requestBodies[0] as {
    input: Array<{ output: unknown }>;
  };
  return body.input[0].output;
}

describe("mcpCallToolResultToModelOutput", () => {
  it("maps an image-only MCP tool result to AI SDK content output", () => {
    const result = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("preserves text and image content order", () => {
    const result = {
      content: [
        { type: "text", text: "before" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "after" },
      ],
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toEqual({
      type: "content",
      value: [
        { type: "text", text: "before" },
        { type: "media", data: "aGVsbG8=", mediaType: "image/png" },
        { type: "text", text: "after" },
      ],
    });
  });

  it("maps embedded image resources to AI SDK content output", () => {
    const result = {
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
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("preserves text and embedded image resource order", () => {
    const result = {
      content: [
        { type: "text", text: "before" },
        {
          type: "resource",
          resource: {
            uri: "mcp://images/one",
            blob: "aGVsbG8=",
            mimeType: "image/png",
          },
        },
        { type: "text", text: "after" },
      ],
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toEqual({
      type: "content",
      value: [
        { type: "text", text: "before" },
        { type: "media", data: "aGVsbG8=", mediaType: "image/png" },
        { type: "text", text: "after" },
      ],
    });
  });

  it("returns undefined when there are no image-bearing content blocks", () => {
    const result = {
      content: [{ type: "text", text: "plain result" }],
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toBeUndefined();
  });

  it("returns undefined for non-image embedded resources", () => {
    const result = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "mcp://docs/one",
            blob: "aGVsbG8=",
            mimeType: "application/pdf",
          },
        },
      ],
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toBeUndefined();
  });

  it("omits unsupported blocks compactly in mixed image results", () => {
    const result = {
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      ],
    } as unknown as CallToolResult;

    expect(mcpCallToolResultToModelOutput(result)).toEqual({
      type: "content",
      value: [
        { type: "media", data: "aGVsbG8=", mediaType: "image/png" },
        { type: "text", text: "[audio omitted: audio/wav]" },
      ],
    });
  });

  it("falls back to text markers for ineligible image blocks", () => {
    const nonImageMime = mcpCallToolResultToModelOutput({
      content: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "application/octet-stream",
        },
      ],
    } as unknown as CallToolResult);
    const malformedBase64 = mcpCallToolResultToModelOutput({
      content: [{ type: "image", data: "!!!!", mimeType: "image/png" }],
    } as unknown as CallToolResult);
    const oversized = mcpCallToolResultToModelOutput(
      {
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      } as unknown as CallToolResult,
      { maxImageBytes: 2 }
    );

    expect(nonImageMime?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: unsupported MIME application/octet-stream]",
      },
    ]);
    expect(malformedBase64?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: invalid base64 data (image/png)]",
      },
    ]);
    expect(oversized?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: image/png exceeds 2 bytes limit]",
      },
    ]);
  });

  it("rejects oversized base64 before decoding", () => {
    const bufferFrom = vi.spyOn(Buffer, "from");
    const oversizedData = "A".repeat(6);

    const output = mcpCallToolResultToModelOutput(
      {
        content: [
          {
            type: "image",
            data: oversizedData,
            mimeType: "image/png",
          },
        ],
      } as unknown as CallToolResult,
      { maxImageBytes: 2 }
    );

    expect(bufferFrom).not.toHaveBeenCalled();
    expect(output?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: image/png exceeds 2 bytes limit]",
      },
    ]);

    bufferFrom.mockRestore();
  });

  it("caps image media count and aggregate decoded bytes", () => {
    const manyImages = mcpCallToolResultToModelOutput(
      {
        content: Array.from({ length: 17 }, () => ({
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        })),
      } as unknown as CallToolResult,
      { maxImageCount: 16 }
    );

    expect(manyImages?.value).toHaveLength(17);
    expect(manyImages?.value.slice(0, 16)).toEqual(
      Array.from({ length: 16 }, () => ({
        type: "media",
        data: "aGVsbG8=",
        mediaType: "image/png",
      }))
    );
    expect(manyImages?.value[16]).toEqual({
      type: "text",
      text: "[image omitted: image count exceeds 16 limit]",
    });

    const aggregateOverflow = mcpCallToolResultToModelOutput(
      {
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      } as unknown as CallToolResult,
      { maxTotalImageBytes: 8 }
    );

    expect(aggregateOverflow?.value).toEqual([
      { type: "media", data: "aGVsbG8=", mediaType: "image/png" },
      {
        type: "text",
        text: "[image omitted: total image bytes exceed 8 bytes limit]",
      },
    ]);
  });

  it("rejects non-canonical malformed base64 image data", () => {
    const malformed = mcpCallToolResultToModelOutput({
      content: [{ type: "image", data: "AAAA=", mimeType: "image/png" }],
    } as unknown as CallToolResult);

    expect(malformed?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: invalid base64 data (image/png)]",
      },
    ]);
  });

  it("validates large images in browser-like runtimes without spreading all bytes", () => {
    const originalBuffer = Object.getOwnPropertyDescriptor(
      globalThis,
      "Buffer"
    );
    const data = Buffer.from(new Uint8Array(256 * 1024)).toString("base64");
    let output: ReturnType<typeof mcpCallToolResultToModelOutput>;

    try {
      Object.defineProperty(globalThis, "Buffer", {
        configurable: true,
        writable: true,
        value: undefined,
      });

      expect(() => {
        output = mcpCallToolResultToModelOutput({
          content: [{ type: "image", data, mimeType: "image/png" }],
        } as unknown as CallToolResult);
      }).not.toThrow();
    } finally {
      if (originalBuffer) {
        Object.defineProperty(globalThis, "Buffer", originalBuffer);
      } else {
        delete (globalThis as { Buffer?: unknown }).Buffer;
      }
    }

    const part = output!.value[0];
    expect(part).toEqual({
      type: "media",
      data,
      mediaType: "image/png",
    });
  });

  it("falls back to text markers for ineligible embedded image resources", () => {
    const malformedBase64 = mcpCallToolResultToModelOutput({
      content: [
        {
          type: "resource",
          resource: {
            uri: "mcp://images/bad",
            blob: "!!!!",
            mimeType: "image/png",
          },
        },
      ],
    } as unknown as CallToolResult);
    const oversized = mcpCallToolResultToModelOutput(
      {
        content: [
          {
            type: "resource",
            resource: {
              uri: "mcp://images/big",
              blob: "AAAA",
              mimeType: "image/png",
            },
          },
        ],
      } as unknown as CallToolResult,
      { maxImageBytes: 2 }
    );

    expect(malformedBase64?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: invalid base64 data (image/png)]",
      },
    ]);
    expect(oversized?.value).toEqual([
      {
        type: "text",
        text: "[image omitted: image/png exceeds 2 bytes limit]",
      },
    ]);
  });

  it("resolves image resource links through the supplied MCP reader", async () => {
    const readResource = vi.fn(async ({ uri }: { uri: string }) => ({
      contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
    }));

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(
        {
          content: [
            {
              type: "resource_link",
              uri: "mcp://images/one",
              name: "one.png",
              mimeType: "image/png",
            },
          ],
        } as unknown as CallToolResult,
        { readResource }
      )
    ).resolves.toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(readResource).toHaveBeenCalledWith({
      uri: "mcp://images/one",
      options: undefined,
    });
  });

  it("accepts MCPJam resources/read route wrappers for linked image resources", async () => {
    const readResource = vi.fn(async ({ uri }: { uri: string }) => ({
      content: {
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
      },
    }));

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(
        {
          content: [
            {
              type: "resource_link",
              uri: "example://linked-image.png",
              name: "Linked PNG resource",
              mimeType: "image/png",
            },
          ],
        } as unknown as CallToolResult,
        { readResource }
      )
    ).resolves.toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("preserves text and linked image resource order", async () => {
    const readResource = async ({ uri }: { uri: string }) => ({
      contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
    });

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(
        {
          content: [
            { type: "text", text: "before" },
            {
              type: "resource_link",
              uri: "mcp://images/one",
              name: "one.png",
              mimeType: "image/png",
            },
            { type: "text", text: "after" },
          ],
        } as unknown as CallToolResult,
        { readResource }
      )
    ).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: "before" },
        { type: "media", data: "aGVsbG8=", mediaType: "image/png" },
        { type: "text", text: "after" },
      ],
    });
  });

  it("keeps non-image resource links on the JSON fallback path", async () => {
    const output = await mcpCallToolResultToModelOutputWithLinkedResources(
      {
        content: [
          {
            type: "resource_link",
            uri: "mcp://docs/one",
            name: "one.pdf",
            mimeType: "application/pdf",
          },
        ],
      } as unknown as CallToolResult,
      {
        readResource: async () => {
          throw new Error("should not be called");
        },
      }
    );

    expect(output).toBeUndefined();
  });

  it("uses omission markers for failed or invalid linked image reads", async () => {
    const linkResult = {
      content: [
        {
          type: "resource_link",
          uri: "mcp://images/one",
          name: "one.png",
          mimeType: "image/png",
        },
      ],
    } as unknown as CallToolResult;

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(linkResult, {
        readResource: async () => {
          throw new Error("boom");
        },
      })
    ).resolves.toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "[resource link omitted: failed to read resource]",
        },
      ],
    });

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(linkResult, {
        readResource: async () => ({ contents: [] }),
      })
    ).resolves.toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "[resource link omitted: no image content returned]",
        },
      ],
    });

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(linkResult, {
        readResource: async () => {
          const error = new Error("Request timed out");
          error.name = "TimeoutError";
          throw error;
        },
      })
    ).resolves.toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "[resource link omitted: failed to read resource]",
        },
      ],
    });

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(linkResult, {
        readResource: async () => ({
          contents: [
            {
              uri: "mcp://images/one",
              blob: "!!!!",
              mimeType: "image/png",
            },
          ],
        }),
      })
    ).resolves.toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "[image omitted: invalid base64 data (image/png)]",
        },
      ],
    });

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(linkResult, {
        readResource: async () => ({
          contents: [
            {
              uri: "mcp://images/one",
              blob: "AAAA",
              mimeType: "image/png",
            },
          ],
        }),
        maxImageBytes: 2,
      })
    ).resolves.toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "[image omitted: image/png exceeds 2 bytes limit]",
        },
      ],
    });
  });

  it("caps linked resource reads", async () => {
    const readResource = vi.fn(async ({ uri }: { uri: string }) => ({
      contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
    }));

    const output = await mcpCallToolResultToModelOutputWithLinkedResources(
      {
        content: Array.from({ length: 17 }, (_, index) => ({
          type: "resource_link",
          uri: `mcp://images/${index}`,
          name: `${index}.png`,
          mimeType: "image/png",
        })),
      } as unknown as CallToolResult,
      { readResource, maxLinkedResourceReads: 16 }
    );

    expect(readResource).toHaveBeenCalledTimes(16);
    expect(output?.value).toHaveLength(17);
    expect(output?.value[16]).toEqual({
      type: "text",
      text: "[resource link omitted: linked resource read count exceeds 16 limit]",
    });
  });

  it("propagates cancellation during linked image resource reads", async () => {
    const abortController = new AbortController();
    const linkResult = {
      content: [
        {
          type: "resource_link",
          uri: "mcp://images/one",
          name: "one.png",
          mimeType: "image/png",
        },
      ],
    } as unknown as CallToolResult;

    await expect(
      mcpCallToolResultToModelOutputWithLinkedResources(linkResult, {
        abortSignal: abortController.signal,
        readResource: async () => {
          abortController.abort();
          return {
            contents: [
              {
                uri: "mcp://images/one",
                blob: "aGVsbG8=",
                mimeType: "image/png",
              },
            ],
          };
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("is sent as image input by the OpenAI Responses provider path", async () => {
    const output = mcpCallToolResultToModelOutput({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    } as unknown as CallToolResult);

    await expect(captureOpenAIResponsesToolOutput(output)).resolves.toEqual([
      {
        type: "input_image",
        image_url: "data:image/png;base64,aGVsbG8=",
      },
    ]);
  });

  it("sends embedded and linked image resources through the same provider path", async () => {
    const embeddedOutput = mcpCallToolResultToModelOutput({
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
    } as unknown as CallToolResult);
    const linkedOutput =
      await mcpCallToolResultToModelOutputWithLinkedResources(
        {
          content: [
            {
              type: "resource_link",
              uri: "mcp://images/one",
              name: "one.png",
              mimeType: "image/png",
            },
          ],
        } as unknown as CallToolResult,
        {
          readResource: async () => ({
            contents: [
              {
                uri: "mcp://images/one",
                blob: "aGVsbG8=",
                mimeType: "image/png",
              },
            ],
          }),
        }
      );

    await expect(
      captureOpenAIResponsesToolOutput(embeddedOutput)
    ).resolves.toEqual([
      {
        type: "input_image",
        image_url: "data:image/png;base64,aGVsbG8=",
      },
    ]);
    await expect(
      captureOpenAIResponsesToolOutput(linkedOutput)
    ).resolves.toEqual([
      {
        type: "input_image",
        image_url: "data:image/png;base64,aGVsbG8=",
      },
    ]);
  });
});
