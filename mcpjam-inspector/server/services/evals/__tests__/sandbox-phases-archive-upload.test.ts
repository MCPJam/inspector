import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EFTW-90: a graded iteration's archive is stored best effort. It never fails
// or holds up the iteration, and its storage id exists only once confirmed.

const mocks = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../../../utils/computers/grading-files-client.js", () => ({
  requestGradingFilesUploadUrl: mocks.requestUploadUrl,
}));
vi.mock("../../../utils/upload-receipt.js", () => ({
  confirmUploadedObject: mocks.confirm,
}));

import { readGradingArchive } from "../sandbox-phases/grading-archive.js";
import { uploadGradingArchive } from "../sandbox-phases/grading-archive-upload.js";

const input = {
  iterationJson: JSON.stringify({ version: 1 }),
  files: [
    {
      type: "file" as const,
      path: "home/user/out.json",
      executable: false,
      data: new TextEncoder().encode("{}"),
    },
  ],
};
const upload = {
  runId: "run",
  iterationId: "iteration",
  bearer: () => "member-token",
  input,
  timeoutMs: 30_000,
};

let posted: { url: string; init: RequestInit } | undefined;
const storage = vi.fn(async (url: string, init: RequestInit) => {
  posted = { url, init };
  return Response.json({ storageId: "storage-1" });
});

beforeEach(() => {
  posted = undefined;
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.stubGlobal("fetch", storage);
  storage.mockClear();
  mocks.requestUploadUrl.mockReset().mockResolvedValue({
    ok: true,
    value: {
      uploadUrl: "https://storage.test/upload",
      uploadGrantId: "grant-1",
    },
  });
  mocks.confirm.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("storing a graded iteration's archive", () => {
  it("uploads the tar, confirms it, and only then returns the storage id", async () => {
    expect(await uploadGradingArchive(upload)).toBe("storage-1");
    expect(mocks.requestUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: "member-token",
        runId: "run",
        iterationId: "iteration",
      }),
    );
    expect(posted?.url).toBe("https://storage.test/upload");
    expect(posted?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-tar" },
      redirect: "error",
    });
    const tar = posted?.init.body as Uint8Array;
    expect(await readGradingArchive(tar, ["/home/user/out.json"])).toEqual({
      ok: true,
      input,
    });
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        convexHttpUrl: "https://convex.test",
        bearer: "member-token",
        serviceToken: "service-token-for-tests",
        uploadGrantId: "grant-1",
        storageId: "storage-1",
      }),
    );
  });

  it("skips quietly when the backend has no upload route", async () => {
    mocks.requestUploadUrl.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Not found",
    });
    expect(await uploadGradingArchive(upload)).toBeUndefined();
    expect(storage).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("returns nothing when storage refuses the bytes, without throwing", async () => {
    storage.mockImplementationOnce(
      async () => new Response("no", { status: 500 }),
    );
    expect(await uploadGradingArchive(upload)).toBeUndefined();
    storage.mockImplementationOnce(async () => {
      throw new Error("fetch failed");
    });
    expect(await uploadGradingArchive(upload)).toBeUndefined();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("returns nothing when the receipt is refused", async () => {
    mocks.confirm.mockRejectedValue(new Error("Upload receipt was refused"));
    expect(await uploadGradingArchive(upload)).toBeUndefined();
  });

  it("returns nothing when the bearer can't be renewed", async () => {
    expect(
      await uploadGradingArchive({
        ...upload,
        bearer: () => {
          throw new Error("token_renewal_failed: expired");
        },
      }),
    ).toBeUndefined();
    expect(mocks.requestUploadUrl).not.toHaveBeenCalled();
  });

  it("sends nothing without the service token or without time left", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    expect(await uploadGradingArchive(upload)).toBeUndefined();
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
    expect(
      await uploadGradingArchive({ ...upload, timeoutMs: 0 }),
    ).toBeUndefined();
    expect(mocks.requestUploadUrl).not.toHaveBeenCalled();
  });
});
