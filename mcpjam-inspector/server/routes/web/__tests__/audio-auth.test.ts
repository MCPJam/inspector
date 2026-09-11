import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * MJ-002. `/api/web/audio/transcriptions` was the one MCP-operation route in
 * `routes/web/index.ts` mounted without `bearerAuthMiddleware`, and its handler
 * answered a bearer-less request by spending MCPJam's own guest credential on
 * OpenAI Whisper.
 *
 * These cases go through the REAL `/api/web` router rather than a hand-mounted
 * one, because the mount order is the thing under test: a suite that assembles
 * its own middleware chain would keep passing after someone removed the mount.
 */

const validateGuestTokenDetailedAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenDetailedAsyncMock,
}));

vi.mock("../../../utils/guest-spend-ip.js", () => ({
  hashGuestSpendIp: vi.fn(async () => "guest-ip-hash"),
}));

const ORIGINAL_ENV = {
  hostedMode: process.env.VITE_MCPJAM_HOSTED_MODE,
  convexHttpUrl: process.env.CONVEX_HTTP_URL,
  dailyLimit: process.env.MCPJAM_AUDIO_DAILY_IP_LIMIT,
};

type LoadedApp = {
  app: Hono;
  resetLimits: () => void;
};

/**
 * `HOSTED_MODE` and the daily ceiling are read when their modules are first
 * imported, so a fresh module registry is the only way to vary them.
 */
async function loadApp(dailyLimit: number): Promise<LoadedApp> {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  process.env.CONVEX_HTTP_URL = "https://convex.example";
  process.env.MCPJAM_AUDIO_DAILY_IP_LIMIT = String(dailyLimit);
  vi.resetModules();

  const [webRoutes, requestLogContext, guestLimit, dailyLimitModule] =
    await Promise.all([
      import("../index"),
      import("../../../middleware/request-log-context"),
      import("../../../middleware/guest-rate-limit"),
      import("../../../middleware/audio-daily-limit"),
    ]);

  const app = new Hono();
  // Mirrors production wiring: the log context must exist before any route
  // that reads it, and `bearerAuthMiddleware` writes to it on every branch.
  app.use("/api/*", requestLogContext.requestLogContextMiddleware);
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    await next();
  });
  app.route("/api/web", webRoutes.default);

  return {
    app,
    resetLimits: () => {
      guestLimit.resetGuestRateLimitForTests();
      dailyLimitModule.resetAudioDailyLimitForTests();
    },
  };
}

function transcribe(
  app: Hono,
  options: { bearer?: string; ip?: string; nonce?: string } = {}
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": options.ip ?? "203.0.113.7",
  };
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;

  return app.request("/api/web/audio/transcriptions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      input_audio: {
        data: `UklGRiQA${options.nonce ?? ""}`,
        format: "webm",
      },
    }),
  });
}

function stubUpstream() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, text: "Transcript." }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // A `guest-*` token is a valid guest JWT; anything else falls through to the
  // unverified-passthrough branch, which is what a real WorkOS session does.
  validateGuestTokenDetailedAsyncMock.mockImplementation(async (token: string) =>
    token.startsWith("guest-")
      ? { valid: true, guestId: token }
      : { valid: false, reason: "not_guest" }
  );
  stubUpstream();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  for (const [key, value] of [
    ["VITE_MCPJAM_HOSTED_MODE", ORIGINAL_ENV.hostedMode],
    ["CONVEX_HTTP_URL", ORIGINAL_ENV.convexHttpUrl],
    ["MCPJAM_AUDIO_DAILY_IP_LIMIT", ORIGINAL_ENV.dailyLimit],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("/api/web/audio/transcriptions — auth and per-caller metering", () => {
  let loaded: LoadedApp;

  // Above the 60/min guest window, so the per-minute limiter is what bites in
  // this block rather than the daily ceiling.
  beforeAll(async () => {
    loaded = await loadApp(500);
  });

  afterEach(() => {
    loaded.resetLimits();
  });

  it("refuses a request with no Authorization header", async () => {
    const response = await transcribe(loaded.app);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Bearer token required",
    });
    // The finding was not "returns 200" — it was "spends money". Nothing may
    // reach the provider.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("matches the 401 that sibling MCP-operation routes return", async () => {
    const audio = await transcribe(loaded.app);
    const tools = await loaded.app.request("/api/web/tools/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "ws-1", serverId: "srv-1" }),
    });

    expect(audio.status).toBe(tools.status);
    await expect(audio.json()).resolves.toEqual(await tools.json());
  });

  it("transcribes for a valid guest token and forwards that caller's bearer", async () => {
    const response = await transcribe(loaded.app, { bearer: "guest-alice" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      text: "Transcript.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer guest-alice"
    );
  });

  it("rate limits one guest at 60/min and states when to retry", async () => {
    for (let index = 0; index < 60; index++) {
      const response = await transcribe(loaded.app, {
        bearer: "guest-bob",
        nonce: String(index),
      });
      // Every one of the 60 must be admitted. The route used to run the guest
      // limiter itself as well as inheriting it from the mount, which debited
      // the same bucket twice and silently halved the guest budget to 30.
      expect(response.status).toBe(200);
    }

    const limited = await transcribe(loaded.app, { bearer: "guest-bob" });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    await expect(limited.json()).resolves.toEqual({
      code: "RATE_LIMITED",
      message:
        "Guest rate limit exceeded. Try again later or sign in for higher limits.",
    });
    expect(fetch).toHaveBeenCalledTimes(60);
  });
});

describe("/api/web/audio/transcriptions — daily ceiling per address", () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp(5);
  });

  afterEach(() => {
    loaded.resetLimits();
  });

  it("stops a caller who mints a fresh guest identity for every request", async () => {
    // The threat the per-guest limiter cannot see: guest tokens are free to
    // mint, so a new identity per request means a new 60/min budget per
    // request. Only the address is common to all of them.
    for (let index = 0; index < 5; index++) {
      const response = await transcribe(loaded.app, {
        bearer: `guest-throwaway-${index}`,
        ip: "198.51.100.4",
        nonce: String(index),
      });
      expect(response.status).toBe(200);
    }

    const limited = await transcribe(loaded.app, {
      bearer: "guest-throwaway-5",
      ip: "198.51.100.4",
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    await expect(limited.json()).resolves.toEqual({
      code: "RATE_LIMITED",
      message:
        "Daily voice transcription limit reached for this address. Sign in for higher limits.",
    });
    // Distinguishable from the per-minute limiter, which is the point — the two
    // mean different things in Axiom and to the user.
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("charges the ceiling per address, not across unrelated callers", async () => {
    for (let index = 0; index < 5; index++) {
      await transcribe(loaded.app, {
        bearer: `guest-first-${index}`,
        ip: "198.51.100.10",
        nonce: String(index),
      });
    }

    const other = await transcribe(loaded.app, {
      bearer: "guest-second",
      ip: "198.51.100.11",
    });

    expect(other.status).toBe(200);
  });

  it("exempts a signed-in caller, who is metered by their own entitlement", async () => {
    // No `guestId`, so the ceiling does not apply — otherwise a team behind one
    // office NAT would share a guest-shaped budget.
    for (let index = 0; index < 8; index++) {
      const response = await transcribe(loaded.app, {
        bearer: "eyJsignedInSessionToken",
        ip: "198.51.100.20",
        nonce: String(index),
      });
      expect(response.status).toBe(200);
    }

    expect(fetch).toHaveBeenCalledTimes(8);
  });
});
