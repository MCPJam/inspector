import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  resolveMcpToolResultImagePreviews,
  hasMcpToolResultImageCandidate,
  useMcpToolResultImagePreviews,
} from "@/components/chat-v2/shared/mcp-tool-result-image-preview";

const PNG_DATA = "aGVsbG8=";
const GIF_DATA = "R0lGODlhAQABAIAAAAUEBA==";

describe("mcp tool result image preview resolver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders direct image content as a data URL", async () => {
    const previews = await resolveMcpToolResultImagePreviews({
      content: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
    });

    expect(previews).toEqual([
      {
        src: `data:image/png;base64,${PNG_DATA}`,
        mediaType: "image/png",
        alt: "Tool result image 1",
      },
    ]);
  });

  it("keeps resolved previews when equivalent image results rerender", async () => {
    const firstResult = {
      content: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
    };
    const equivalentResult = {
      content: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
    };

    const { result, rerender } = renderHook(
      ({ value }) => useMcpToolResultImagePreviews(value),
      { initialProps: { value: firstResult } }
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.previews[0]?.src).toBe(
      `data:image/png;base64,${PNG_DATA}`
    );

    rerender({ value: equivalentResult });

    expect(result.current.status).toBe("ready");
    expect(result.current.previews[0]?.src).toBe(
      `data:image/png;base64,${PNG_DATA}`
    );
  });

  it("renders embedded image resources as data URLs", async () => {
    const previews = await resolveMcpToolResultImagePreviews({
      content: [
        {
          type: "resource",
          resource: {
            uri: "example://embedded.png",
            blob: PNG_DATA,
            mimeType: "image/png",
          },
        },
      ],
    });

    expect(previews).toEqual([
      {
        src: `data:image/png;base64,${PNG_DATA}`,
        mediaType: "image/png",
        alt: "Tool result image 1",
      },
    ]);
  });

  it("renders already-converted model media outputs (reloaded transcripts) as UI previews", async () => {
    // After a transcript is re-persisted, the raw MCP `result` is dropped by
    // the AI SDK round-trip and only the model-facing output survives. The UI
    // must still render the image from that surviving copy (when the model was
    // allowed to see it), otherwise tool images vanish as a chat ages.
    const modelOutput = {
      type: "content",
      value: [{ type: "media", data: PNG_DATA, mediaType: "image/png" }],
    };

    expect(hasMcpToolResultImageCandidate(modelOutput)).toBe(true);
    await expect(
      resolveMcpToolResultImagePreviews(modelOutput)
    ).resolves.toEqual([
      {
        src: `data:image/png;base64,${PNG_DATA}`,
        mediaType: "image/png",
        alt: "Tool result image 1",
      },
    ]);
  });

  it("renders model media outputs wrapped in a json envelope", async () => {
    const enveloped = {
      type: "json",
      value: {
        type: "content",
        value: [{ type: "media", data: PNG_DATA, mediaType: "image/png" }],
      },
    };

    expect(hasMcpToolResultImageCandidate(enveloped)).toBe(true);
    await expect(
      resolveMcpToolResultImagePreviews(enveloped)
    ).resolves.toEqual([
      {
        src: `data:image/png;base64,${PNG_DATA}`,
        mediaType: "image/png",
        alt: "Tool result image 1",
      },
    ]);
  });

  it("resolves linked image resources through the supplied resource reader", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const readResource = vi.fn(async (uri: string) => ({
      contents: [{ uri, blob: PNG_DATA, mimeType: "image/png" }],
    }));

    const previews = await resolveMcpToolResultImagePreviews(
      {
        content: [
          {
            type: "resource_link",
            uri: "example://linked-image.png",
            mimeType: "image/png",
          },
        ],
      },
      { readResource }
    );

    expect(readResource).toHaveBeenCalledWith("example://linked-image.png");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(previews).toEqual([
      {
        src: `data:image/png;base64,${PNG_DATA}`,
        mediaType: "image/png",
        alt: "Tool result image 1",
      },
    ]);
  });

  it("resolves linked image resources from hosted content envelopes", async () => {
    const readResource = vi.fn(async () => ({
      content: {
        contents: [
          {
            uri: "example://linked-image.png",
            blob: PNG_DATA,
            mimeType: "image/png",
          },
        ],
      },
    }));

    const previews = await resolveMcpToolResultImagePreviews(
      {
        content: [
          {
            type: "resource_link",
            uri: "example://linked-image.png",
            mimeType: "image/png",
          },
        ],
      },
      { readResource }
    );

    expect(previews).toHaveLength(1);
    expect(previews[0]?.src).toBe(`data:image/png;base64,${PNG_DATA}`);
  });

  it("renders multiple images in MCP content order", async () => {
    const previews = await resolveMcpToolResultImagePreviews({
      content: [
        { type: "image", data: PNG_DATA, mimeType: "image/png" },
        { type: "text", text: "between" },
        {
          type: "resource",
          resource: {
            uri: "example://embedded.gif",
            blob: GIF_DATA,
            mimeType: "image/gif",
          },
        },
      ],
    });

    expect(previews.map((preview) => preview.src)).toEqual([
      `data:image/png;base64,${PNG_DATA}`,
      `data:image/gif;base64,${GIF_DATA}`,
    ]);
  });

  it("ignores non-image resources", async () => {
    const result = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "example://text.txt",
            text: "hello",
            mimeType: "text/plain",
          },
        },
      ],
    };

    expect(hasMcpToolResultImageCandidate(result)).toBe(false);
    await expect(resolveMcpToolResultImagePreviews(result)).resolves.toEqual(
      []
    );
  });

  it("omits invalid image data without throwing", async () => {
    await expect(
      resolveMcpToolResultImagePreviews({
        content: [
          { type: "image", data: "not base64??", mimeType: "image/png" },
        ],
      })
    ).resolves.toEqual([]);
  });

  it("omits oversized image data without throwing", async () => {
    const oversizedData = "A".repeat(15 * 1024 * 1024);

    await expect(
      resolveMcpToolResultImagePreviews({
        content: [
          { type: "image", data: oversizedData, mimeType: "image/png" },
        ],
      })
    ).resolves.toEqual([]);
  });

  it("falls back cleanly when linked resource resolution fails", async () => {
    const readResource = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      resolveMcpToolResultImagePreviews(
        {
          content: [
            {
              type: "resource_link",
              uri: "example://linked-image.png",
              mimeType: "image/png",
            },
          ],
        },
        { readResource }
      )
    ).resolves.toEqual([]);
  });
});
