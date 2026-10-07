import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import capabilities from "../capabilities.js";

function app() {
  return new Hono().route("/api/web/capabilities", capabilities);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/web/capabilities", () => {
  it("reports a tokenless server's hosted-only and fallback features by name", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const res = await app().request("/api/web/capabilities");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.hostedServices).toBe(false);
    expect(body.hostedUrl).toBe("https://app.mcpjam.com");
    expect(body.hostedOnly).toEqual(
      expect.arrayContaining(["browser-profiles", "public-site-relays"]),
    );
    expect(body.degraded).toContainEqual({ id: "api-keys", via: "relay" });
  });

  it("reports a credentialed server as having hosted services, without the value", async () => {
    const secret = "capabilities-test-service-token";
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", secret);
    vi.stubEnv("WORKOS_API_KEY", "sk_admin");
    const res = await app().request("/api/web/capabilities");
    const text = await res.text();
    expect(text).not.toContain(secret);
    const body = JSON.parse(text);
    expect(body.hostedServices).toBe(true);
    expect(body.hostedOnly).toEqual([]);
  });
});
