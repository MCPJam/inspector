import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import audioTranscriptions from "../audio-transcriptions.js";
import { hashGuestSpendIp } from "../../../utils/guest-spend-ip.js";

vi.mock("../../../utils/guest-spend-ip.js", () => ({
  hashGuestSpendIp: vi.fn().mockResolvedValue("guest-ip-hash"),
}));

const ORIGINAL_ENV = {
  CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
};

const app = new Hono();
// Production mounts the same router on both prefixes (see routes/mcp/index.ts
// and routes/web/index.ts). Mirror that here so tests cover both paths.
app.route("/api/mcp/audio", audioTranscriptions);
app.route("/api/web/audio", audioTranscriptions);

async function postTranscription(body: Record<string, unknown>) {
  return app.request("/api/mcp/audio/transcriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("audio transcriptions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hashGuestSpendIp).mockResolvedValue("guest-ip-hash");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            text: "Hello from audio.",
            usage: { seconds: 1.5, cost: 0.001 },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Generation-Id": "gen_123",
            },
          },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (ORIGINAL_ENV.CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_ENV.CONVEX_HTTP_URL;
    }
    if (ORIGINAL_ENV.INSPECTOR_SERVICE_TOKEN === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN =
        ORIGINAL_ENV.INSPECTOR_SERVICE_TOKEN;
    }
  });

  it("rejects voice transcription on the MCP mount", async () => {
    const response = await postTranscription({
      input_audio: {
        data: "UklGRiQA",
        format: "webm",
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "Voice transcription uses MCPJam credits and is only available on the /api/web audio endpoint.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects data URIs because the backend expects raw base64", async () => {
    const response = await postTranscription({
      input_audio: {
        data: "data:audio/webm;base64,UklGRiQA",
        format: "webm",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "input_audio.data must be raw base64, not a data URI",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("proxies signed-in project transcriptions through the MCPJam backend", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://convex.example/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer user-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "openai/whisper-1",
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
        projectId: "project-voice",
        selectedServerIds: ["server-1"],
        scenarioId: "scenario-1",
        accessVersion: 3,
      });
      return new Response(
        JSON.stringify({ ok: true, text: "Backend key transcript." }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        selectedServerIds: ["server-1"],
        scenarioId: "scenario-1",
        accessVersion: 3,
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      text: "Backend key transcript.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to forward the caller's bearer over cleartext", async () => {
    // The scheme of `CONVEX_HTTP_URL` decides whether this route puts a
    // caller's `Authorization` header on the wire in the clear. Operator-set,
    // so this is a misconfiguration guard rather than an injection one — but
    // a deployment pointed at `http:` would leak every voice caller's token,
    // and failing closed is cheap.
    process.env.CONVEX_HTTP_URL = "http://convex.example";

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        input_audio: { data: "UklGRiQA", format: "webm" },
      }),
    });

    // 502 because the route's catch maps every unrecognized failure there;
    // asserted as-is rather than reshaped, since the status is not the point.
    // The point is that NOTHING WAS SENT — no bearer left the process.
    expect(response.status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("https"),
    });
  });

  it("still forwards to a loopback Convex over http", async () => {
    // A local Convex is `http://127.0.0.1:…` and there is no network hop to
    // protect. Refusing it would break local development to defend against
    // nothing — the same rule browsers apply to secure contexts.
    process.env.CONVEX_HTTP_URL = "http://127.0.0.1:3210";
    vi.mocked(fetch).mockImplementation(async (url) => {
      expect(String(url)).toBe("http://127.0.0.1:3210/audio/transcriptions");
      return new Response(JSON.stringify({ ok: true, text: "Local." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        input_audio: { data: "UklGRiQA", format: "webm" },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes through MCPJam voice budget errors with friendly copy", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          code: "user_rate_limit",
          error:
            "Daily MCPJam voice limit reached. Try again tomorrow or top up your credits.",
          isRetryable: true,
          retryAfter: 86_400_000,
          details: "Try again tomorrow.",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "You've used today's voice budget.",
      code: "user_rate_limit",
      isRetryable: true,
      retryAfter: 86_400_000,
      details: "Try again tomorrow.",
      status: 429,
    });
  });

  it("passes through MCPJam voice in-progress errors with friendly copy", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          code: "voice_transcription_in_progress",
          error: "Busy",
          isRetryable: true,
          retryAfter: 10_000,
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error:
        "Another voice message is still processing. Try again in a moment.",
      code: "voice_transcription_in_progress",
      isRetryable: true,
      retryAfter: 10_000,
      status: 429,
    });
  });

  // MJ-002. This route used to answer a bearer-less request by fetching a
  // server-side guest session and spending MCPJam's own credential on it. The
  // handler now refuses, and — the assertion that matters — refuses BEFORE any
  // upstream request, so nothing is billed. The bearer requirement is also
  // enforced a layer up by the `/audio/*` mount; this covers the handler on its
  // own, so a future remount cannot quietly restore the old behaviour.
  it("refuses an unauthenticated transcription without spending anything", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "203.0.113.10",
      },
      body: JSON.stringify({
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Bearer token required",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the caller's own bearer and never substitutes one", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://convex.example/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer caller-guest-token",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "openai/whisper-1",
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      });
      return new Response(JSON.stringify({ ok: true, text: "Guest audio." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer caller-guest-token",
        "X-Real-IP": "203.0.113.10",
      },
      body: JSON.stringify({
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(hashGuestSpendIp).toHaveBeenCalledWith("203.0.113.10");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      text: "Guest audio.",
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get("x-mcpjam-guest-ip-hash")).toBe(
      "guest-ip-hash",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects project-backed transcription on the MCP mount", async () => {
    const response = await app.request("/api/mcp/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "Voice transcription uses MCPJam credits and is only available on the /api/web audio endpoint.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes MCPJam transcription errors", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Voice provider failed" },
          details: "Backend env var AI_GATEWAY_API_KEY is not set.",
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Voice provider failed",
      status: 502,
    });
  });

  it("times out hung MCPJam transcription requests", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) return;
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    const responsePromise = app.request("/api/web/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
      }),
    });

    await vi.advanceTimersByTimeAsync(55_000);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "Voice transcription timed out. Try a shorter recording.",
    });
  });
});
