import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/web/browser-profiles/upload` (MJ-006): archive bytes in, storage
 * id out. Driven through the real `/api/web` router and the real body-limit
 * middleware, so the mount (auth, guest denial, the body-cap exemption) is
 * what is under test, not a hand-assembled chain.
 */

const { validateGuestTokenMock, hostedMode } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  hostedMode: { value: false },
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedMode.value;
    },
  };
});

import webRoutes from "../index.js";
import { webBodyLimit } from "../../../middleware/web-body-limit.js";
import { MAX_BROWSER_PROFILE_ARCHIVE_BYTES } from "../browser-profile-upload.js";

const CONVEX_HTTP_URL = "https://convex-http.example.com";
const STORAGE_DESTINATION =
  "https://storage.example.com/api/storage/upload?token=UNEXPECTED_MARKER";

function makeApp(): Hono {
  const app = new Hono();
  app.use("/api/web/*", webBodyLimit());
  app.route("/api/web", webRoutes);
  return app;
}

function upload(
  app: Hono,
  body: Uint8Array<ArrayBuffer>,
  options: { query?: string; bearer?: string; headers?: HeadersInit } = {},
) {
  return app.request(
    `/api/web/browser-profiles/upload${options.query ?? "?projectId=prj_1"}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        // What a browser sends for a Blob body; a test Request carries none.
        "Content-Length": String(body.byteLength),
        Authorization: `Bearer ${options.bearer ?? "user-bearer"}`,
        ...options.headers,
      },
      body,
    },
  );
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readAll(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

type FetchCall = [string, RequestInit & { duplex?: string }];

describe("POST /api/web/browser-profiles/upload", () => {
  const originalEnv = {
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  let streamedBytes: Uint8Array | null;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = CONVEX_HTTP_URL;
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token-1";
    hostedMode.value = true;
    validateGuestTokenMock.mockReset().mockResolvedValue({ valid: false });
    streamedBytes = null;
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/browser-profiles/upload-url")) {
        return json(200, { uploadUrl: STORAGE_DESTINATION });
      }
      if (url === STORAGE_DESTINATION) {
        streamedBytes = await readAll(init.body);
        return json(200, { storageId: "kg2_profile_archive" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("streams the archive to the destination the backend names and returns only the storage id", async () => {
    const archive = new Uint8Array(64 * 1024).map((_, i) => i % 251);

    const res = await upload(makeApp(), archive);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ storageId: "kg2_profile_archive" });
    // The answer is the storage id alone.
    expect(text).not.toContain("storage.example.com");
    expect(text).not.toContain("UNEXPECTED_MARKER");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as FetchCall;
    expect(mintUrl).toBe(
      `${CONVEX_HTTP_URL}/internal/v1/browser-profiles/upload-url`,
    );
    expect(mintInit.method).toBe("POST");
    expect(mintInit.headers).toMatchObject({
      Authorization: "Bearer user-bearer",
      "x-inspector-service-token": "service-token-1",
    });
    expect(JSON.parse(String(mintInit.body))).toEqual({ projectId: "prj_1" });

    const [storageUrl, storageInit] = fetchMock.mock.calls[1] as FetchCall;
    expect(storageUrl).toBe(STORAGE_DESTINATION);
    expect(storageInit.method).toBe("POST");
    expect(storageInit.redirect).toBe("error");
    // Streamed through, not buffered first.
    expect(storageInit.body).toBeInstanceOf(ReadableStream);
    expect(storageInit.duplex).toBe("half");
    expect(storageInit.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(archive.byteLength),
    });
    expect(streamedBytes).toEqual(archive);
  });

  it("accepts an archive above the 1MB /api/web body cap", async () => {
    const archive = new Uint8Array(3 * 1024 * 1024 + 7);

    const res = await upload(makeApp(), archive);

    expect(res.status).toBe(200);
    expect(streamedBytes?.byteLength).toBe(archive.byteLength);
  });

  it("refuses an archive over 256 MB before asking the backend for anything", async () => {
    const res = await upload(makeApp(), new Uint8Array(16), {
      headers: {
        "Content-Length": String(MAX_BROWSER_PROFILE_ARCHIVE_BYTES + 1),
      },
    });

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a projectId", async () => {
    const res = await upload(makeApp(), new Uint8Array(8), { query: "" });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty archive", async () => {
    const res = await upload(makeApp(), new Uint8Array(0));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the archive's length up front", async () => {
    const res = await makeApp().request(
      "/api/web/browser-profiles/upload?projectId=prj_1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: "Bearer user-bearer",
        },
        body: new Uint8Array(8),
      },
    );

    expect(res.status).toBe(411);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the route to guests", async () => {
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_1",
    });

    const res = await upload(makeApp(), new Uint8Array(8), {
      bearer: "guest-bearer",
    });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
  ])(
    "passes a %i from the backend through and sends no bytes",
    async (status, code) => {
      fetchMock.mockImplementation(async () =>
        json(status, { code, error: "Not allowed for this project" }),
      );

      const res = await upload(makeApp(), new Uint8Array(8));

      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({
        code,
        message: "Not allowed for this project",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("answers 502 with a generic message when storage refuses the bytes", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/upload-url")) {
        return json(200, { uploadUrl: STORAGE_DESTINATION });
      }
      await readAll(init.body);
      return new Response(`refused ${STORAGE_DESTINATION}`, { status: 500 });
    });

    const res = await upload(makeApp(), new Uint8Array(8));

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("storage.example.com");
    expect(text).not.toContain("UNEXPECTED_MARKER");
  });

  it("refuses a destination that is not https", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/upload-url")) {
        return json(200, {
          uploadUrl:
            "http://storage.example.com/upload?token=UNEXPECTED_MARKER",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await upload(makeApp(), new Uint8Array(8));

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await res.text()).not.toContain("UNEXPECTED_MARKER");
  });

  it("refuses to run hosted without the service credential", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;

    const res = await upload(makeApp(), new Uint8Array(8));

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the per-user route on a local install without the service credential", async () => {
    hostedMode.value = false;
    delete process.env.INSPECTOR_SERVICE_TOKEN;

    const res = await upload(makeApp(), new Uint8Array([1, 2, 3]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ storageId: "kg2_profile_archive" });
    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as FetchCall;
    expect(mintUrl).toBe(`${CONVEX_HTTP_URL}/browser-profiles/upload-url`);
    expect(mintInit.headers).toMatchObject({
      Authorization: "Bearer user-bearer",
    });
    expect(mintInit.headers).not.toHaveProperty("x-inspector-service-token");
    expect(streamedBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("no longer serves the upload-url operation to the browser", async () => {
    const res = await makeApp().request(
      "/api/web/browser-profiles/upload-url",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer user-bearer",
        },
        body: JSON.stringify({ projectId: "prj_1" }),
      },
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
