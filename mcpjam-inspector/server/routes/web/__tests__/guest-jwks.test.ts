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
});
