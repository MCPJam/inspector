import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveFilePart (hosted mode)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("tries hosted web fallback when the primary endpoint throws", async () => {
    const fileId = "file_550e8400-e29b-41d4-a716-446655440000";
    const authFetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["fallback"], { type: "image/png" }),
      });

    vi.doMock("@/lib/session-token", () => ({
      authFetch: authFetchMock,
    }));
    vi.doMock("@/lib/config", () => ({
      HOSTED_MODE: true,
    }));

    const { resolveFilePart } = await import("../openai-widget-state-messages");
    const part = await resolveFilePart(fileId);

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(authFetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/apps/chatgpt-apps/file/${fileId}`,
    );
    expect(authFetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/web/apps/chatgpt-apps/file/${fileId}`,
    );
    expect(part).toMatchObject({
      type: "file",
      mediaType: "image/png",
    });
    expect((part as { url: string }).url.startsWith("data:image/png;")).toBe(
      true,
    );
  });
});
