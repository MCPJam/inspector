import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { saveBrowserProfile } from "../client";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const profile = {
  profileId: "bp_1",
  projectId: "prj 1",
  name: "My browser",
  bytes: 3,
  savedFrom: "chat_1",
  isDefaultForUser: false,
  createdAt: 1,
};

describe("saveBrowserProfile", () => {
  const directFetch = vi.fn();

  beforeEach(() => {
    mockAuthFetch.mockReset();
    directFetch.mockReset();
    vi.stubGlobal("fetch", directFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the archive bytes to the inspector, then commits the returned storage id", async () => {
    mockAuthFetch
      .mockResolvedValueOnce(json(200, { storageId: "kg2_archive" }))
      .mockResolvedValueOnce(json(200, { profile }));
    const archive = new Blob([new Uint8Array([1, 2, 3])]);

    const saved = await saveBrowserProfile({
      projectId: "prj 1",
      name: "My browser",
      savedFrom: "chat_1",
      archive,
    });

    expect(saved).toEqual(profile);
    expect(mockAuthFetch).toHaveBeenCalledTimes(2);
    const [uploadPath, uploadInit] = mockAuthFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(uploadPath).toBe(
      "/api/web/browser-profiles/upload?projectId=prj%201",
    );
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });
    expect(uploadInit.body).toBe(archive);

    const [commitPath, commitInit] = mockAuthFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(commitPath).toBe("/api/web/browser-profiles/commit");
    expect(JSON.parse(String(commitInit.body))).toEqual({
      projectId: "prj 1",
      name: "My browser",
      savedFrom: "chat_1",
      storageId: "kg2_archive",
    });
    // Nothing goes anywhere but the inspector.
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHORIZED", "Sign in to save browser profiles."],
    [
      403,
      "FEATURE_NOT_SUPPORTED",
      "Browser profiles requires a signed-in account.",
    ],
    [
      413,
      "VALIDATION_ERROR",
      "The browser profile archive exceeds the 256 MB limit.",
    ],
    [429, "RATE_LIMITED", "Too many requests."],
  ])(
    "surfaces a %i from the upload and commits nothing",
    async (status, code, message) => {
      mockAuthFetch.mockResolvedValueOnce(json(status, { code, message }));

      await expect(
        saveBrowserProfile({
          projectId: "prj_1",
          name: "My browser",
          savedFrom: "chat_1",
          archive: new Blob([new Uint8Array([1])]),
        }),
      ).rejects.toThrow(message);
      expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses an upload answer without a storage id", async () => {
    mockAuthFetch.mockResolvedValueOnce(json(200, {}));

    await expect(
      saveBrowserProfile({
        projectId: "prj_1",
        name: "My browser",
        savedFrom: "chat_1",
        archive: new Blob([new Uint8Array([1])]),
      }),
    ).rejects.toThrow("did not return a storage id");
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });
});
