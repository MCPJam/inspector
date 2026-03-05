import { describe, expect, it, vi, beforeEach } from "vitest";
import { mcpApiPresets } from "@/test/mocks/mcp-api";
import { storePresets } from "@/test/mocks/stores";
import {
  applyClientRuntimePresets,
  clientRuntimeMocks,
} from "@/test/mocks/client-runtime";

vi.mock("@/hooks/use-app-state", () => ({
  useAppState: clientRuntimeMocks.useAppStateMock,
}));

vi.mock("@/state/mcp-api", () => clientRuntimeMocks.mcpApiMock);

import { buildWidgetModelContextMessages } from "../model-context-messages";
import * as widgetStateMessages from "../openai-widget-state-messages";

const resolveFilePartSpy = vi.spyOn(widgetStateMessages, "resolveFilePart");

beforeEach(() => {
  vi.clearAllMocks();
  applyClientRuntimePresets({
    mcpApi: mcpApiPresets.allSuccess(),
    appState: storePresets.empty(),
  });
  resolveFilePartSpy.mockResolvedValue(null);
});

describe("buildWidgetModelContextMessages", () => {
  it("preserves text and image content blocks as text + file parts", async () => {
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-1",
        context: {
          content: [
            { type: "text", text: "Selected image" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
          ],
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Selected image" },
      {
        type: "file",
        mediaType: "image/jpeg",
        url: "data:image/jpeg;base64,aGVsbG8=",
      },
    ]);
  });

  it("keeps existing data URLs unchanged", async () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-2",
        context: {
          content: [{ type: "image", data: dataUrl, mimeType: "image/png" }],
        },
      },
    ]);

    expect(messages[0].parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        url: dataUrl,
      },
    ]);
  });

  it("falls back to structured content text when no supported content blocks exist", async () => {
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-3",
        context: {
          structuredContent: { selectedIds: [1, 2, 3] },
        },
      },
    ]);

    expect(messages[0].parts).toEqual([
      {
        type: "text",
        text: 'Widget tool-3 structured context: {"selectedIds":[1,2,3]}',
      },
    ]);
  });

  it("strips privateContent from structured content fallback text", async () => {
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-priv",
        context: {
          structuredContent: {
            modelContent: "visible summary",
            privateContent: { secret: "should not appear" },
            imageIds: [],
          },
        },
      },
    ]);

    const text = (messages[0].parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("visible summary");
    expect(text).not.toContain("privateContent");
    expect(text).not.toContain("should not appear");
  });

  it("emits no text part when structuredContent contains only privateContent", async () => {
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-priv-only",
        context: {
          structuredContent: {
            privateContent: { secret: "should not appear" },
          },
        },
      },
    ]);

    expect(messages).toHaveLength(0);
  });

  it("appends image URL from structuredContent when content[] provides only text (native MCP Apps path)", async () => {
    // Native MCP Apps send text metadata in content[] but image URLs only in
    // structuredContent.privateContent.selectedImages. The old code returned
    // early once content[] produced parts, silently dropping the image.
    const imageUrl = "https://example.com/search-result.jpg";
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-5",
        context: {
          content: [{ type: "text", text: "1: Title: Cat photo" }],
          structuredContent: {
            modelContent: "1: Title: Cat photo",
            privateContent: {
              selectedImages: [{ imageUrl }],
            },
          },
        },
      },
    ]);

    const parts = messages[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "1: Title: Cat photo" });
    expect(parts[1]).toEqual({
      type: "file",
      mediaType: "image/jpeg",
      url: imageUrl,
    });
  });

  it("resolves image URL from structuredContent.privateContent.selectedImages when file fetch fails", async () => {
    const imageUrl = "https://example.com/cat.jpg";
    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-4",
        context: {
          structuredContent: {
            modelContent: "1: Title: Cat",
            privateContent: {
              selectedImages: [{ imageUrl }],
              rawFileIds: ["file_abc123"],
            },
            imageIds: ["file_abc123"],
          },
        },
      },
    ]);

    // resolveFilePart is mocked to return null, so we fall back to URL
    const parts = messages[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("tool-4"),
    });
    expect(parts[1]).toEqual({
      type: "file",
      mediaType: "image/jpeg",
      url: imageUrl,
    });
  });

  it("skips fallback image URLs when at least one file ID resolves (avoids duplicates)", async () => {
    const resolvedPart = {
      type: "file" as const,
      mediaType: "image/png",
      url: "data:image/png;base64,cmVzb2x2ZWQ=",
    };
    vi.mocked(widgetStateMessages.resolveFilePart)
      .mockResolvedValueOnce(resolvedPart)
      .mockResolvedValueOnce(null);

    const messages = await buildWidgetModelContextMessages([
      {
        toolCallId: "tool-6",
        context: {
          structuredContent: {
            imageIds: [
              "file_550e8400-e29b-41d4-a716-446655440000",
              "file_550e8400-e29b-41d4-a716-446655440001",
            ],
            privateContent: {
              selectedImages: [
                { imageUrl: "https://example.com/cat-1.jpg" },
                { imageUrl: "https://example.com/cat-2.jpg" },
              ],
            },
          },
        },
      },
    ]);

    const parts = messages[0].parts;
    // Only the resolved file part should be present — no fallback HTTP URLs
    // which would duplicate the already-resolved image.
    const fileParts = parts.filter((p) => p.type === "file");
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]).toEqual(resolvedPart);
  });
});
