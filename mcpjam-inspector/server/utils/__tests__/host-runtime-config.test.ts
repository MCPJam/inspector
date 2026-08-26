import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHostRuntimeConfig } from "../host-runtime-config";

// Unit coverage for the inspector → Convex host runtime-config client. Mirrors
// the scenario runtime-config contract: POST /web/host/runtime-config with a
// bearer + { hostId }, mapping ok/err shapes the chat-v2 routes branch on.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.CONVEX_HTTP_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = vi.fn(async (url: any, init: any) =>
    impl(String(url), init as RequestInit)
  ) as unknown as typeof fetch;
}

describe("fetchHostRuntimeConfig", () => {
  it("POSTs to /web/host/runtime-config with a normalized bearer and { hostId }", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return Response.json({
        ok: true,
        config: { hostId: "h1", harness: "claude-code" },
      });
    });

    const result = await fetchHostRuntimeConfig({
      hostId: "h1",
      bearer: "raw-token", // no "Bearer " prefix → must be added
    });

    expect(seenUrl).toBe("https://convex.example.com/web/host/runtime-config");
    expect((seenInit.headers as Record<string, string>).authorization).toBe(
      "Bearer raw-token"
    );
    expect(JSON.parse(String(seenInit.body))).toEqual({ hostId: "h1" });
    expect(result).toEqual({
      ok: true,
      config: { hostId: "h1", harness: "claude-code" },
    });
  });

  it("rejects a blank bearer as 401 without hitting the network", async () => {
    // Regression: an unauthenticated local Playground turn on a host-bound
    // conversation sent `Bearer ` (empty), Convex threw "Invalid
    // authentication header", the backend answered 500 and the route
    // collapsed it to a 502 the client reported as MCPJam's fault.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    for (const bearer of ["", "   ", "Bearer "]) {
      const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ status: 401 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a token that merely STARTS with the letters Bearer", async () => {
    // Regression: a `^Bearer\s*` strip (zero-or-more) mangled an opaque token
    // like `Bearerabc123` into `abc123` — a different credential.
    let auth = "";
    mockFetch((_url, init) => {
      auth = (init.headers as Record<string, string>).authorization;
      return Response.json({ ok: true, config: { hostId: "h1" } });
    });
    await fetchHostRuntimeConfig({ hostId: "h1", bearer: "Bearerabc123" });
    expect(auth).toBe("Bearer Bearerabc123");
  });

  it("answers a blank bearer as 401 even when the endpoint is unconfigured", async () => {
    // The caller being unauthenticated is a 401, and must not inherit the 500
    // that missing CONVEX_HTTP_URL returns.
    delete process.env.CONVEX_HTTP_URL;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer: "" });

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not double-prefix an already-Bearer token", async () => {
    let auth = "";
    mockFetch((_url, init) => {
      auth = (init.headers as Record<string, string>).authorization;
      return Response.json({ ok: true, config: { hostId: "h1" } });
    });
    await fetchHostRuntimeConfig({ hostId: "h1", bearer: "Bearer abc" });
    expect(auth).toBe("Bearer abc");
  });

  it("flattens a nested HostConfigV2 config so harness reaches execution", async () => {
    mockFetch(() =>
      Response.json({
        ok: true,
        config: {
          hostId: "h1",
          modelId: "anthropic/claude-haiku-4.5",
          config: {
            harness: "claude-code",
            progressiveToolDiscovery: false,
            builtInToolIds: ["web_search"],
          },
        },
      })
    );

    const result = await fetchHostRuntimeConfig({
      hostId: "h1",
      bearer: "Bearer abc",
    });

    expect(result).toEqual({
      ok: true,
      config: {
        hostId: "h1",
        modelId: "anthropic/claude-haiku-4.5",
        harness: "claude-code",
        progressiveToolDiscovery: false,
        builtInToolIds: ["web_search"],
      },
    });
  });

  it("also accepts hostConfig as the nested HostConfigV2 key", async () => {
    mockFetch(() =>
      Response.json({
        ok: true,
        config: {
          hostId: "h1",
          hostConfig: {
            harness: "claude-code",
          },
        },
      })
    );

    const result = await fetchHostRuntimeConfig({
      hostId: "h1",
      bearer: "Bearer abc",
    });

    expect(result).toEqual({
      ok: true,
      config: {
        hostId: "h1",
        harness: "claude-code",
      },
    });
  });

  it("maps a 403 error body to ok:false with the status", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, error: "Host not found or access denied" }),
          { status: 403 }
        )
    );
    const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer: "t" });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Host not found or access denied",
    });
  });

  it("maps a network throw to a 502 result", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries one transient network failure before failing the turn", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json({ ok: true, config: { hostId: "h1" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer: "t" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, config: { hostId: "h1" } });
  });

  it("does not retry an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchHostRuntimeConfig({
      hostId: "h1",
      bearer: "t",
      signal: controller.signal,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  it("treats a 200 with a non-JSON body as a 502", async () => {
    mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});
