import { describe, expect, it, vi, beforeEach } from "vitest";

const { authFetchMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: authFetchMock,
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

import {
  buildWidgetStateParts,
  resolveFilePart,
} from "../openai-widget-state-messages";

describe("buildWidgetStateParts", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("returns text-only parts when there are no uploaded file ids", async () => {
    const state = { foo: "bar" };
    const parts = await buildWidgetStateParts("tool-1", state);

    expect(parts).toEqual([
      {
        type: "text",
        text: 'The state of widget tool-1 is: {"foo":"bar"}',
      },
    ]);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("resolves file ids from imageIds into file parts", async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["hello"], { type: "image/jpeg" }),
    });

    // imageIds is the canonical source; privateContent is UI-only and not read.
    const state = {
      imageIds: ["file_550e8400-e29b-41d4-a716-446655440000"],
      privateContent: { currentView: "image-viewer" },
    };

    const parts = await buildWidgetStateParts("tool-2", state);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(parts[0]).toEqual({
      type: "text",
      text: 'The state of widget tool-2 is: {"imageIds":["file_550e8400-e29b-41d4-a716-446655440000"]}',
    });
    expect(parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
    });
    expect(
      (parts[1] as { url: string }).url.startsWith("data:image/jpeg;"),
    ).toBe(true);
  });

  it("strips privateContent when modelContent is missing", async () => {
    const state = {
      privateContent: {
        secret: "should-not-leak",
      },
      imageIds: [],
      selectedTab: "results",
    };

    const parts = await buildWidgetStateParts("tool-2b", state);

    expect(authFetchMock).not.toHaveBeenCalled();
    expect(parts).toEqual([
      {
        type: "text",
        text: 'The state of widget tool-2b is: {"imageIds":[],"selectedTab":"results"}',
      },
    ]);
    expect((parts[0] as { text: string }).text).not.toContain("privateContent");
    expect((parts[0] as { text: string }).text).not.toContain(
      "should-not-leak",
    );
  });

  it("uses modelContent as text and does not expose privateContent", async () => {
    const state = {
      modelContent: "User uploaded an image from the file upload widget.",
      privateContent: {
        rawFileId: "file_8a45d63b-79d4-4eff-a178-c0ce4078c7c6",
      },
      imageIds: [],
    };

    const parts = await buildWidgetStateParts("tool-3", state);

    expect(authFetchMock).not.toHaveBeenCalled();
    expect(parts).toEqual([
      {
        type: "text",
        text: "User uploaded an image from the file upload widget.",
      },
    ]);
  });

  it("handles undefined modelContent without producing an invalid text part", async () => {
    const state = {
      modelContent: undefined,
      privateContent: {
        rawFileId: "file_8a45d63b-79d4-4eff-a178-c0ce4078c7c6",
      },
      imageIds: [],
    };

    const parts = await buildWidgetStateParts("tool-3b", state);

    expect(authFetchMock).not.toHaveBeenCalled();
    expect(parts).toEqual([
      {
        type: "text",
        text: "undefined",
      },
    ]);
  });

  it("resolves imageIds into file parts alongside modelContent text", async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["img"], { type: "image/jpeg" }),
    });

    const state = {
      modelContent: "User uploaded an image from the file upload widget.",
      privateContent: {
        rawFileId: "file_8a45d63b-79d4-4eff-a178-c0ce4078c7c6",
      },
      imageIds: ["file_8a45d63b-79d4-4eff-a178-c0ce4078c7c6"],
    };

    const parts = await buildWidgetStateParts("tool-4", state);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(parts[0]).toEqual({
      type: "text",
      text: "User uploaded an image from the file upload widget.",
    });
    expect(parts[1]).toMatchObject({ type: "file", mediaType: "image/jpeg" });
    expect(
      (parts[1] as { url: string }).url.startsWith("data:image/jpeg;"),
    ).toBe(true);
  });

  it("omits file parts when imageId resolution fails", async () => {
    authFetchMock.mockResolvedValue({ ok: false });

    const state = {
      modelContent: "User uploaded an image from the file upload widget.",
      privateContent: {
        rawFileId: "file_8a45d63b-79d4-4eff-a178-c0ce4078c7c6",
      },
      imageIds: ["file_8a45d63b-79d4-4eff-a178-c0ce4078c7c6"],
    };

    const parts = await buildWidgetStateParts("tool-5", state);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(parts).toEqual([
      {
        type: "text",
        text: "User uploaded an image from the file upload widget.",
      },
    ]);
  });

  it("returns null when all endpoint requests throw", async () => {
    authFetchMock.mockRejectedValue(new Error("network failure"));

    await expect(
      resolveFilePart("file_550e8400-e29b-41d4-a716-446655440000"),
    ).resolves.toBeNull();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});
