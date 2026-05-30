import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";

describe("web routes — server secret reveal", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects runtime reveal from the browser proxy", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await postJson(
      app,
      "/api/web/server/reveal-secrets",
      {
        purpose: "runtime",
        projectId: "proj_1",
        serverId: "srv_1",
      },
      token
    );
    const { status, data } = await expectJson(response);

    expect(status).toBe(403);
    expect(data).toEqual({
      code: "FORBIDDEN",
      message: "Runtime secret reveal is not available from browser routes",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards browser reveal as edit purpose with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          env: { FOO: "bar" },
          headers: null,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await postJson(
      app,
      "/api/web/server/reveal-secrets",
      {
        purpose: "runtime",
        projectId: "proj_1",
        serverId: "srv_1",
      },
      token
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const editResponse = await postJson(
      app,
      "/api/web/server/reveal-secrets",
      {
        projectId: "proj_1",
        serverId: "srv_1",
      },
      token
    );
    const { status, data } = await expectJson(editResponse);

    expect(status).toBe(200);
    expect(data).toEqual({
      success: true,
      env: { FOO: "bar" },
      headers: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.test/web/server/reveal-secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        }),
        body: JSON.stringify({
          projectId: "proj_1",
          serverId: "srv_1",
          purpose: "edit",
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("times out browser reveal proxy requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = postJson(
      app,
      "/api/web/server/reveal-secrets",
      {
        projectId: "proj_1",
        serverId: "srv_1",
      },
      token
    );

    await vi.advanceTimersByTimeAsync(20_000);
    const response = await responsePromise;
    const { status, data } = await expectJson(response);

    expect(status).toBe(504);
    expect(data).toEqual({
      code: "TIMEOUT",
      message: "Couldn't reveal saved secrets. Try again.",
    });
  });
});
