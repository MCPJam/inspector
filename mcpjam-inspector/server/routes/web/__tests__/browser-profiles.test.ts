import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Route-level tests for /api/web/browser-profiles/download (MJ-005): the
// archive is streamed by the server after the backend's owner check, and the
// response is the archive bytes and nothing else. The Convex-bearer exchange
// is mocked; `fetch` stands in for both the backend and the archive host.

vi.mock("../../../utils/v1-convex-token", () => ({
  getConvexBearerForRequest: vi.fn(async () => "convex-jwt"),
}));

import browserProfilesRouter from "../browser-profiles";
import {
  ARCHIVE_IDLE_TIMEOUT_MS,
  ARCHIVE_RESPONSE_TIMEOUT_MS,
} from "../browser-profile-download";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import { logger } from "../../../utils/logger.js";

const BACKEND = "https://backend.example";
const LOOKUP_URL = `${BACKEND}/browser-profiles/download-url`;
const ARCHIVE_URL =
  "https://happy-otter-123.convex.cloud/api/storage/0f1e2d3c?sig=abc";
const SERVICE_TOKEN = "inspector-service-token";
const ARCHIVE = new Uint8Array([31, 139, 8, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

const fetchMock = vi.fn();

function createApp() {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.route("/api/web/browser-profiles", browserProfilesRouter);
  return app;
}

function download(body: Record<string, unknown>) {
  return createApp().request("/api/web/browser-profiles/download", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer user-token",
    },
    body: JSON.stringify(body),
  });
}

const IDS = { projectId: "project-1", profileId: "profile-1" };

function lookupAnswers(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route `fetch` by URL: the backend lookup, then the archive read. */
function serve(options: { lookup?: () => Response; archive?: () => Response }) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === LOOKUP_URL) {
      return (
        options.lookup ?? (() => lookupAnswers(200, { url: ARCHIVE_URL }))
      )();
    }
    if (
      url === ARCHIVE_URL ||
      url.startsWith("http://happy-otter-123.convex.cloud/")
    ) {
      return (
        options.archive ??
        (() =>
          new Response(ARCHIVE, {
            status: 200,
            headers: {
              "content-type": "application/gzip",
              "content-length": String(ARCHIVE.byteLength),
            },
          }))
      )();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function allHeaderValues(response: Response): string {
  const lines: string[] = [];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return lines.join("\n");
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", BACKEND);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(logger, "event").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe("POST /api/web/browser-profiles/download", () => {
  it("streams the archive bytes as an attachment", async () => {
    serve({});

    const res = await download(IDS);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="browser-profile-profile-1.tar.gz"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe(String(ARCHIVE.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ARCHIVE);
  });

  it("never puts the archive location in the response", async () => {
    serve({});

    const res = await download(IDS);
    const body = Buffer.from(await res.arrayBuffer()).toString("latin1");

    expect(res.status).toBe(200);
    for (const fragment of [
      ARCHIVE_URL,
      "happy-otter-123",
      "/api/storage/",
      "sig=abc",
    ]) {
      expect(allHeaderValues(res)).not.toContain(fragment);
      expect(body).not.toContain(fragment);
    }
  });

  it("asks the backend with the service token and the caller's Convex bearer", async () => {
    serve({});

    await (await download(IDS)).arrayBuffer();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(String(lookupUrl)).toBe(LOOKUP_URL);
    expect(lookupInit.method).toBe("POST");
    expect(lookupInit.redirect).toBe("error");
    const headers = new Headers(lookupInit.headers);
    expect(headers.get("x-inspector-service-token")).toBe(SERVICE_TOKEN);
    expect(headers.get("authorization")).toBe("Bearer convex-jwt");
    expect(JSON.parse(String(lookupInit.body))).toEqual(IDS);

    // The archive read carries no credential and follows no redirect.
    const [archiveUrl, archiveInit] = fetchMock.mock.calls[1] as [
      URL,
      RequestInit,
    ];
    expect(String(archiveUrl)).toBe(ARCHIVE_URL);
    expect(archiveInit.method).toBe("GET");
    expect(archiveInit.redirect).toBe("error");
    expect(archiveInit.headers).toBeUndefined();
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [401, "UNAUTHORIZED"],
  ])("answers the backend's %i as %s", async (status, code) => {
    serve({
      lookup: () => lookupAnswers(status, { error: "refused upstream" }),
    });

    const res = await download(IDS);

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A refusal is the backend's answer, not a failure to report.
    expect(
      vi
        .mocked(logger.event)
        .mock.calls.filter(
          ([event]) => event === "browser_profile.download.failed",
        ),
    ).toHaveLength(0);
  });

  it("reports a backend failure during the lookup", async () => {
    serve({
      lookup: () => lookupAnswers(500, { error: "lookup unavailable" }),
    });

    const res = await download(IDS);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "SERVER_UNREACHABLE" });
    expect(logger.event).toHaveBeenCalledWith(
      "browser_profile.download.failed",
      expect.anything(),
      { stage: "lookup", statusCode: 500, errorMessage: "lookup unavailable" },
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers 404 when the backend names no archive", async () => {
    serve({ lookup: () => lookupAnswers(200, {}) });

    const res = await download(IDS);

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers 404 when the stored archive is gone", async () => {
    serve({ archive: () => new Response("missing", { status: 404 }) });

    const res = await download(IDS);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 502 when the archive host fails", async () => {
    serve({ archive: () => new Response("boom", { status: 500 }) });

    const res = await download(IDS);

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("happy-otter-123");
    expect(logger.event).toHaveBeenCalledWith(
      "browser_profile.download.failed",
      expect.anything(),
      { stage: "archive", statusCode: 500 },
      undefined,
    );
  });

  it("refuses an archive location that is not https", async () => {
    serve({
      lookup: () =>
        lookupAnswers(200, {
          url: "http://happy-otter-123.convex.cloud/api/storage/0f1e2d3c",
        }),
    });

    const res = await download(IDS);

    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("happy-otter-123");
    // Only the lookup ran; the archive was never requested.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an archive only from this deployment's file storage", async () => {
    serve({
      lookup: () =>
        lookupAnswers(200, { url: "https://files.example/archive/0f1e2d3c" }),
    });

    const res = await download(IDS);

    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("files.example");
    // Only the lookup ran; the other location was never requested.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an archive declared over the size limit without streaming it", async () => {
    let cancelled = false;
    serve({
      archive: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: { "content-length": String(256 * 1024 * 1024 + 1) },
          },
        ),
    });

    const res = await download(IDS);

    expect(res.status).toBe(502);
    expect(cancelled).toBe(true);
  });

  it("answers 504 when the archive does not start arriving in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === LOOKUP_URL) {
          return lookupAnswers(200, { url: ARCHIVE_URL });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      },
    );

    const pending = download(IDS);
    await vi.advanceTimersByTimeAsync(ARCHIVE_RESPONSE_TIMEOUT_MS + 1);
    const res = await pending;

    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: "TIMEOUT" });
  });

  it("cuts a transfer that stops moving", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let cancelled = false;
    serve({
      archive: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    });

    const res = await download(IDS);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));

    const next = reader.read();
    next.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ARCHIVE_IDLE_TIMEOUT_MS + 1);

    await expect(next).rejects.toThrow("stalled");
    expect(cancelled).toBe(true);
  });

  it("is unavailable on a server without the service token", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    serve({});

    const res = await download(IDS);

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the body before asking the backend", async () => {
    serve({});

    const res = await download({ projectId: "project-1" });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("proxied browser-profile operations", () => {
  it("no longer offers download-url", async () => {
    serve({});

    const res = await createApp().request(
      "/api/web/browser-profiles/download-url",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer user-token",
        },
        body: JSON.stringify(IDS),
      },
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
