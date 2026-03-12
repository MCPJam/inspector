import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import webRoutes from "../index.js";
import { initGuestTokenSecret } from "../../../services/guest-token.js";

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: vi.fn(),
  isMCPAuthError: vi.fn().mockReturnValue(false),
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_GUEST_JWT_KEY_DIR = process.env.GUEST_JWT_KEY_DIR;

describe("GET /api/web/guest-jwks", () => {
  let app: Hono;
  let testGuestKeyDir: string;

  beforeEach(() => {
    testGuestKeyDir = mkdtempSync(path.join(os.tmpdir(), "guest-jwks-test-"));
    process.env.NODE_ENV = "test";
    process.env.GUEST_JWT_KEY_DIR = testGuestKeyDir;
    initGuestTokenSecret();

    app = new Hono();
    app.route("/api/web", webRoutes);
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_GUEST_JWT_KEY_DIR === undefined) {
      delete process.env.GUEST_JWT_KEY_DIR;
    } else {
      process.env.GUEST_JWT_KEY_DIR = ORIGINAL_GUEST_JWT_KEY_DIR;
    }
    rmSync(testGuestKeyDir, { recursive: true, force: true });
  });

  it("returns a public, cacheable JWKS document", async () => {
    const response = await app.request("/api/web/guest-jwks");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
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
    // n should be a base64url-encoded RSA modulus (at least 100 chars for 2048-bit)
    expect(key.n.length).toBeGreaterThan(100);
  });

  it("returns exactly one key", async () => {
    const response = await app.request("/api/web/guest-jwks");
    const body = await response.json();

    expect(body.keys).toHaveLength(1);
  });
});

describe("GET /api/web/guest-jwks (uninitialized)", () => {
  it("returns 500 when initGuestTokenSecret() was not called", async () => {
    // Simulate the crash that happens when getGuestJwks() is called before
    // initGuestTokenSecret(). We can't un-initialize the module-level keys,
    // so we build a minimal Hono app that throws the same error and uses
    // the same onError handler as the real web routes.
    const { mapRuntimeError, webError } = await import("../errors.js");

    const errorApp = new Hono();
    errorApp.get("/api/web/guest-jwks", () => {
      throw new Error(
        "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
      );
    });
    errorApp.onError((error, c) => {
      const routeError = mapRuntimeError(error);
      return webError(
        c,
        routeError.status,
        routeError.code,
        routeError.message,
      );
    });

    const response = await errorApp.request("/api/web/guest-jwks");

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("not initialized");
  });
});
