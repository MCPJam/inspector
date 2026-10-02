import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markServiceTokenRejected,
  resetServiceTokenRejectedForTests,
  resolveEvalRunAttachments,
} from "../control-plane-client.js";

/**
 * MJ-005 — resolving a run's attachments presents the inspector service token
 * alongside the caller's bearer whenever this server holds a usable one.
 */
describe("resolveEvalRunAttachments", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ cases: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    resetServiceTokenRejectedForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function sent(): { url: string; init: RequestInit; headers: Headers } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
  }

  it("sends the service token alongside the bearer when one is configured", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");

    const result = await resolveEvalRunAttachments({
      bearer: "user-token",
      runId: "run_1",
    });

    expect(result).toEqual({ ok: true, value: { cases: [] } });
    const { url, init, headers } = sent();
    expect(url).toBe("https://example.convex.site/evals/sandbox/attachments");
    expect(JSON.parse(String(init.body))).toEqual({ runId: "run_1" });
    expect(headers.get("x-inspector-service-token")).toBe("svc-token");
    expect(headers.get("authorization")).toBe("Bearer user-token");
  });

  it("sends only the bearer when no service token is configured", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    await resolveEvalRunAttachments({ bearer: "user-token", runId: "run_1" });

    const { headers } = sent();
    expect(headers.has("x-inspector-service-token")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer user-token");
  });

  it("does not present a token that was rejected at boot", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    markServiceTokenRejected();

    await resolveEvalRunAttachments({ bearer: "user-token", runId: "run_1" });

    const { headers } = sent();
    expect(headers.has("x-inspector-service-token")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer user-token");
  });
});
