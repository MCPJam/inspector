import { describe, expect, it, vi } from "vitest";
import {
  BlobUploadError,
  blobUploadUrl,
  uploadBlob,
  type BlobUploadScope,
} from "../blob-upload";

const SITE = "https://demo.convex.site/";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function upload(
  fetchImpl: ReturnType<typeof vi.fn>,
  scope: BlobUploadScope = { purpose: "mcp-app-view" },
) {
  return uploadBlob({
    siteUrl: SITE,
    bearerToken: "bearer-1",
    scope,
    body: "<div>hello</div>",
    contentType: "text/plain; charset=utf-8",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("blobUploadUrl", () => {
  it("names the purpose and its scope parameters", () => {
    const cases: Array<[BlobUploadScope, Record<string, string>]> = [
      [
        { purpose: "widget-snapshot", chatSessionId: "chat-1" },
        { purpose: "widget-snapshot", chatSessionId: "chat-1" },
      ],
      [
        {
          purpose: "widget-snapshot",
          chatSessionId: "chat-1",
          scenarioId: "scn_1",
          accessVersion: 3,
        },
        {
          purpose: "widget-snapshot",
          chatSessionId: "chat-1",
          scenarioId: "scn_1",
          accessVersion: "3",
        },
      ],
      [{ purpose: "mcp-app-view" }, { purpose: "mcp-app-view" }],
      [
        { purpose: "eval-attachment", suiteId: "suite_1" },
        { purpose: "eval-attachment", suiteId: "suite_1" },
      ],
      [
        { purpose: "skill-file", projectId: "prj_1", skillId: "skl_1" },
        { purpose: "skill-file", projectId: "prj_1", skillId: "skl_1" },
      ],
    ];
    for (const [scope, params] of cases) {
      const url = new URL(blobUploadUrl(SITE, scope));
      expect(url.origin + url.pathname).toBe(
        "https://demo.convex.site/web/uploads/blob",
      );
      expect(Object.fromEntries(url.searchParams)).toEqual(params);
    }
  });

  it("sends an access version only alongside a scenario, and only a whole one", () => {
    for (const scope of [
      { chatSessionId: "chat-1", accessVersion: 3 },
      { chatSessionId: "chat-1", scenarioId: "scn_1", accessVersion: 1.5 },
      { chatSessionId: "chat-1", scenarioId: "scn_1", accessVersion: -1 },
    ]) {
      const url = new URL(
        blobUploadUrl(SITE, { purpose: "widget-snapshot", ...scope }),
      );
      expect(url.searchParams.has("accessVersion"), JSON.stringify(scope)).toBe(
        false,
      );
    }
  });
});

describe("uploadBlob", () => {
  it("posts the raw bytes with the bearer and content type and returns the storage id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, storageId: "kg2_storage" }),
    );

    const storageId = await upload(fetchImpl, {
      purpose: "eval-attachment",
      suiteId: "suite_1",
    });

    expect(storageId).toBe("kg2_storage");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://demo.convex.site/web/uploads/blob?purpose=eval-attachment&suiteId=suite_1",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      Authorization: "Bearer bearer-1",
    });
    expect(init.body).toBe("<div>hello</div>");
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
  ])(
    "surfaces a %i refusal with the route's code and message",
    async (status, code) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(status, { ok: false, code, error: `refused: ${code}` }),
      );

      const error = await upload(fetchImpl).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BlobUploadError);
      expect(error).toMatchObject({
        status,
        code,
        message: `refused: ${code}`,
        data: { code },
        reason: null,
        retryAfterSeconds: null,
      });
    },
  );

  it("carries the refusal's reason where the stale-grant classifier reads it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, {
        ok: false,
        code: "FORBIDDEN",
        error: "Scenario access changed.",
        reason: "scenario_access_stale",
        currentAccessVersion: 4,
      }),
    );

    await expect(upload(fetchImpl)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      reason: "scenario_access_stale",
      data: { code: "FORBIDDEN", reason: "scenario_access_stale" },
    });
  });

  it("carries Retry-After seconds on a 429", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        429,
        { ok: false, code: "RATE_LIMITED", error: "Slow down." },
        { "Retry-After": "12" },
      ),
    );

    await expect(upload(fetchImpl)).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 12,
    });
  });

  it.each([
    [401, "Your session has expired. Sign in again and retry."],
    [403, "You do not have access to upload this file."],
    [413, "The file is too large to upload."],
    [429, "Too many uploads right now. Wait a moment and try again."],
    [502, "The upload failed. Try again."],
  ])(
    "gives a %i without a message a sentence of its own",
    async (status, message) => {
      const fetchImpl = vi.fn(
        async () => new Response("upstream text", { status }),
      );

      await expect(upload(fetchImpl)).rejects.toMatchObject({
        status,
        code: null,
        message,
      });
    },
  );

  it("refuses a success answer that carries no storage id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));

    await expect(upload(fetchImpl)).rejects.toMatchObject({
      name: "BlobUploadError",
      message: "The upload did not return a storage id.",
    });
  });

  it("reports a transport failure as status 0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(upload(fetchImpl)).rejects.toMatchObject({
      name: "BlobUploadError",
      status: 0,
    });
  });

  it("lets the caller's abort propagate as-is", async () => {
    const controller = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    const fetchImpl = vi.fn(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(
      uploadBlob({
        siteUrl: SITE,
        bearerToken: "bearer-1",
        scope: { purpose: "mcp-app-view" },
        body: "x",
        contentType: "text/plain",
        signal: controller.signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBe(reason);
  });
});
