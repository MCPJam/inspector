import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  getAllFlags: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(() => ({
    getAllFlags: mocks.getAllFlags,
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

import clientFlags, {
  CLIENT_FLAGS_RATE_LIMIT_PER_MIN,
  resetClientFlagsRateLimitForTests,
} from "../flags.js";
import { shutdownAnalytics } from "../../../utils/analytics.js";

const ANONYMOUS_ID = "0192a3f1-8c5e-7b3d-8f21-6a4c9e0d1b2f";

// A distinct anonymous (v7 UUID) PostHog id per `n`.
function anonymousId(n: number): string {
  return `0192a3f1-8c5e-7b3d-8f21-${n.toString(16).padStart(12, "0")}`;
}

function createApp() {
  const app = new Hono();
  app.route("/api/web/flags", clientFlags);
  return app;
}

function getFlags(app: Hono, ip: string, headers: Record<string, string> = {}) {
  return app.request(`/api/web/flags?distinct_id=${ANONYMOUS_ID}`, {
    headers: {
      "cf-connecting-ip": ip,
      "x-mcpjam-edge-secret": "flags-test-edge-secret",
      ...headers,
    },
  });
}

describe("GET /api/web/flags per-address ceiling (hosted)", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_EDGE_SECRET", "flags-test-edge-secret");
    vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "flags-test-previous-secret");
    resetClientFlagsRateLimitForTests();
    mocks.getAllFlags.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await shutdownAnalytics();
  });

  it("answers 429 past the per-minute ceiling without evaluating flags", async () => {
    const app = createApp();
    for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN; i++) {
      const response = await getFlags(app, "203.0.113.7");
      expect(response.status).toBe(200);
    }
    const evaluations = mocks.getAllFlags.mock.calls.length;

    const refused = await getFlags(app, "203.0.113.7");

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ flags: {} });
    expect(mocks.getAllFlags.mock.calls.length).toBe(evaluations);
  });

  it("keeps each address's window separate", async () => {
    const app = createApp();
    for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN; i++) {
      await getFlags(app, "203.0.113.7");
    }
    expect((await getFlags(app, "203.0.113.7")).status).toBe(429);

    const other = await getFlags(app, "198.51.100.23");

    expect(other.status).toBe(200);
  });

  it.each([undefined, "incorrect-secret"])(
    "pools rotating forwarding headers when edge attestation is %s",
    async (secret) => {
      const app = createApp();
      const forwardingHeaders = [
        "cf-connecting-ip",
        "x-real-ip",
        "x-forwarded-for",
      ];
      for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN + 3; i++) {
        const headers: Record<string, string> = {
          [forwardingHeaders[i % forwardingHeaders.length]]: `203.0.113.${
            i + 1
          }`,
        };
        if (secret !== undefined) headers["x-mcpjam-edge-secret"] = secret;
        const response = await app.request(
          `/api/web/flags?distinct_id=${anonymousId(i)}`,
          { headers },
        );

        expect(response.status).toBe(
          i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN ? 200 : 429,
        );
      }
      expect(mocks.getAllFlags).toHaveBeenCalledTimes(
        CLIENT_FLAGS_RATE_LIMIT_PER_MIN,
      );
      expect((await getFlags(app, "198.51.100.23")).status).toBe(200);
    },
  );

  it("shares an address's window across current and previous edge secrets", async () => {
    const app = createApp();
    const previousSecret = {
      "x-mcpjam-edge-secret": "flags-test-previous-secret",
    };
    for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN; i++) {
      const response = await getFlags(app, "203.0.113.7", previousSecret);
      expect(response.status).toBe(200);
    }

    expect((await getFlags(app, "203.0.113.7")).status).toBe(429);
    expect((await getFlags(app, "203.0.113.7", previousSecret)).status).toBe(
      429,
    );
    expect((await getFlags(app, "198.51.100.23", previousSecret)).status).toBe(
      200,
    );
  });

  it("pools untrusted proxy headers without edge attestation configured", async () => {
    vi.stubEnv("MCPJAM_EDGE_SECRET", "");
    vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "");
    vi.stubEnv("MCPJAM_TRUSTED_CLIENT_IP_HEADER", "");
    const app = createApp();

    for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN + 2; i++) {
      const response = await app.request(
        `/api/web/flags?distinct_id=${ANONYMOUS_ID}`,
        {
          headers: {
            [i % 2 === 0 ? "x-real-ip" : "x-forwarded-for"]: `203.0.113.${
              i + 1
            }`,
          },
        },
      );

      expect(response.status).toBe(
        i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN ? 200 : 429,
      );
    }
    expect(mocks.getAllFlags).toHaveBeenCalledTimes(
      CLIENT_FLAGS_RATE_LIMIT_PER_MIN,
    );
  });
});
