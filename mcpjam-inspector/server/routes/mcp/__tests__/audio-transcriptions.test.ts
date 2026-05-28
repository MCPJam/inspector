import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import audioTranscriptions from "../audio-transcriptions.js";
import { getProductionGuestAuthHeader } from "../../../utils/guest-auth.js";
import { hashGuestSpendIp } from "../../../utils/guest-spend-ip.js";

vi.mock("../../../utils/guest-auth.js", () => ({
  getProductionGuestAuthHeader: vi
    .fn()
    .mockResolvedValue("Bearer guest-test-token"),
}));

vi.mock("../../../utils/guest-spend-ip.js", () => ({
  hashGuestSpendIp: vi.fn().mockResolvedValue("guest-ip-hash"),
}));

const ORIGINAL_ENV = {
  CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
};

const app = new Hono();
app.route("/api/mcp/audio", audioTranscriptions);

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
          }
        )
      )
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

  it("forwards raw base64 audio to OpenRouter", async () => {
    const response = await postTranscription({
      apiKey: "sk-or-test",
      input_audio: {
        data: "UklGRiQA",
        format: "webm",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "Hello from audio.",
      usage: { seconds: 1.5, cost: 0.001 },
      generationId: "gen_123",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-test",
          "Content-Type": "application/json",
          "HTTP-Referer": "https://www.mcpjam.com/",
          "X-Title": "MCPJam",
        }),
        body: JSON.stringify({
          model: "openai/whisper-1",
          input_audio: {
            data: "UklGRiQA",
            format: "webm",
          },
        }),
      })
    );
  });

  it("rejects data URIs because OpenRouter expects raw base64", async () => {
    const response = await postTranscription({
      apiKey: "sk-or-test",
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
        "Bearer user-token"
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "openai/whisper-1",
        input_audio: {
          data: "UklGRiQA",
          format: "webm",
        },
        projectId: "project-voice",
        selectedServerIds: ["server-1"],
        chatboxId: "chatbox-1",
        accessVersion: 3,
      });
      return new Response(
        JSON.stringify({ ok: true, text: "Backend key transcript." }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const response = await app.request("/api/mcp/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        projectId: "project-voice",
        selectedServerIds: ["server-1"],
        chatboxId: "chatbox-1",
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

  it("uses the same guest bearer fallback as free models for local project transcriptions", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://convex.example/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer guest-test-token"
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "openai/whisper-1",
        projectId: "project-voice",
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

    const response = await app.request("/api/mcp/audio/transcriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MCP-Session-Auth": "Bearer local-session-token",
        "X-Real-IP": "203.0.113.10",
      },
      body: JSON.stringify({
        projectId: "project-voice",
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
    expect(getProductionGuestAuthHeader).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get("x-mcpjam-guest-ip-hash")).toBe(
      "guest-ip-hash"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes OpenRouter errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Invalid OpenRouter API key" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await postTranscription({
      apiKey: "bad-key",
      input_audio: {
        data: "UklGRiQA",
        format: "webm",
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid OpenRouter API key",
      status: 401,
    });
  });

  it("times out hung OpenRouter transcription requests", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) return;
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        })
    );

    const responsePromise = postTranscription({
      apiKey: "sk-or-test",
      input_audio: {
        data: "UklGRiQA",
        format: "webm",
      },
    });

    await vi.advanceTimersByTimeAsync(55_000);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "OpenRouter transcription timed out. Try a shorter recording.",
    });
  });
});
