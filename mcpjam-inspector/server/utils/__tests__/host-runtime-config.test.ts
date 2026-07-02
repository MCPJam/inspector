import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHostRuntimeConfig } from "../host-runtime-config";

// Unit coverage for the inspector → Convex host runtime-config client. Mirrors
// the chatbox runtime-config contract: POST /web/host/runtime-config with a
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
  });

  it("treats a 200 with a non-JSON body as a 502", async () => {
    mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const result = await fetchHostRuntimeConfig({ hostId: "h1", bearer: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});
