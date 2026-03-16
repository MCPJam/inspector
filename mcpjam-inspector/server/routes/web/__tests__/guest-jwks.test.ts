import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import webRoutes from "../index.js";

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: vi.fn(),
  isMCPAuthError: vi.fn().mockReturnValue(false),
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_FETCH = global.fetch;

describe("GET /api/web/guest-jwks", () => {
  let app: Hono;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [
            {
              kid: "guest-1",
              alg: "RS256",
              use: "sig",
              kty: "RSA",
              n: "test-modulus",
              e: "AQAB",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ) as typeof fetch;

    app = new Hono();
    app.route("/api/web", webRoutes);
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    global.fetch = ORIGINAL_FETCH;
  });

  it("returns a non-cacheable JWKS document", async () => {
    const response = await app.request("/api/web/guest-jwks");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body).toMatchObject({
      keys: [
        expect.objectContaining({
          kid: "guest-1",
          alg: "RS256",
          use: "sig",
        }),
      ],
    });
  });

  it("returns a valid RSA public key with required JWK fields", async () => {
    const response = await app.request("/api/web/guest-jwks");
    const body = await response.json();
    const key = body.keys[0];

    // RSA public keys must have kty, n (modulus), and e (exponent)
    expect(key.kty).toBe("RSA");
    expect(key.n).toEqual(expect.any(String));
    expect(key.e).toEqual(expect.any(String));
    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/jwks",
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );
  });

  it("returns exactly one key", async () => {
    const response = await app.request("/api/web/guest-jwks");
    const body = await response.json();

    expect(body.keys).toHaveLength(1);
  });
});

describe("GET /api/web/guest-jwks (upstream unavailable)", () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    global.fetch = ORIGINAL_FETCH;
  });

  it("returns 503 when Convex JWKS cannot be fetched", async () => {
    process.env.NODE_ENV = "test";
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as typeof fetch;
    const app = new Hono();
    app.route("/api/web", webRoutes);

    const response = await app.request("/api/web/guest-jwks");

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("Guest JWKS unavailable");
  });
});
