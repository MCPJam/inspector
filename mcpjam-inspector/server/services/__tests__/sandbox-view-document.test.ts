// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
vi.mock("../../config.js", () => ({
  HOSTED_MODE: true,
  SANDBOX_HOSTS: new Set(["sandbox.example"]),
  MCPJAM_HOSTED_ORIGIN: "https://app.example",
  WEB_ALLOWED_ORIGINS: [],
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("../sandbox-view-hosted.js", () => ({ readHostedSandboxView: read }));
import { serveSandboxViewDocument } from "../../routes/apps/mcp-apps/view-document.js";
import { sandboxDigest, sealSandboxViewCapability } from "../sandbox-view-policy.js";

const keyHash = sandboxDigest("fixture-admission");
const identityHash = sandboxDigest("fixture-identity");
const origin = `https://v-${keyHash.slice(0, 16)}.sandbox.example`;
const policy = "default-src 'none'; script-src 'unsafe-inline'; object-src 'none'";
const lease = () => ({
  keyHash,
  identityHash,
  htmlHash: sandboxDigest("<p>fixture</p>"),
  hostOrigin: "https://app.example",
  viewOrigin: origin,
  policy,
  expiresAt: Date.now() + 60_000,
});
function request(host = origin, token = sealSandboxViewCapability(keyHash, identityHash, origin)) {
  const app = new Hono();
  app.get("/api/web/apps/mcp-apps/sandbox-proxy", serveSandboxViewDocument);
  return app.request(`${host}/api/web/apps/mcp-apps/sandbox-proxy?view_token=${token}`, {
    headers: { Host: new URL(host).host },
  });
}
beforeEach(() => {
  vi.stubEnv("SANDBOX_VIEW_SIGNING_SECRET", "document-fixture-signing-secret-at-least-32-chars");
  read.mockReset().mockResolvedValue(lease());
});
afterEach(() => vi.unstubAllEnvs());

describe("hosted admitted App HTTP document", () => {
  it("serves the admitted policy as HTTP headers and binds the delivered HTML digest", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(policy);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Origin-Agent-Cluster")).toBe("?1");
    expect(await response.text()).toContain(lease().htmlHash);
    expect(read).toHaveBeenCalledWith(keyHash, identityHash);
  });

  it("rejects HEAD before reading a lease", async () => {
    const app = new Hono();
    app.get("/api/web/apps/mcp-apps/sandbox-proxy", serveSandboxViewDocument);
    const token = sealSandboxViewCapability(keyHash, identityHash, origin);
    const response = await app.request(`${origin}/api/web/apps/mcp-apps/sandbox-proxy?view_token=${token}`, {
      method: "HEAD",
      headers: { Host: new URL(origin).host },
    });
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["", "invalid"])("refuses missing or invalid capability %s without reading the lease", async token => {
    const response = await request(origin, token);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await response.text()).not.toContain("<script");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["https://sandbox.example", "https://0123456789abcdef.sandbox.example", "https://v-0123456789abcdef.sandbox.example"])("does not accept a capability on another origin %s", async host => {
    const response = await request(host);
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an expired or mismatched lease with restrictive headers", async () => {
    for (const changed of [{ expiresAt: 1 }, { viewOrigin: "https://wrong.example" }]) {
      read.mockResolvedValue({ ...lease(), ...changed });
      const response = await request();
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    }
  });

  it("keeps service failure retryable without serving a fallback document", async () => {
    read.mockRejectedValue(new Error("Fixture service unavailable"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await response.text()).not.toContain("<script");
  });
});
