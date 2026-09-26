import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashGuestSpendIp } from "../../../utils/guest-spend-ip.js";
import { createWebTestApp } from "./helpers/test-app.js";

const REDEEM_OK = {
  ok: true,
  resourceType: "evalRun",
  resourceId: "run_1",
  role: "viewer",
  mode: "anyone_with_link",
  projectId: null,
  accessVersion: 1,
  payload: null,
};

describe("web routes: shared redeem", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://test-deployment.convex.site");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-secret");
    vi.stubEnv("GUEST_SESSION_HASH_PEPPER", "pepper");
    vi.stubEnv("MCPJAM_EDGE_SECRET", "");
    vi.stubEnv("MCPJAM_EDGE_SECRET_PREVIOUS", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function redeemFrom(clientIp: string) {
    const upstream = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(REDEEM_OK), { status: 200 }),
      );
    vi.stubGlobal("fetch", upstream);
    const response = await app.request("/api/web/shared/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-forwarded-for": clientIp,
      },
      body: JSON.stringify({ resourceType: "evalRun", token: "share-token" }),
    });
    expect(response.status).toBe(200);
    return new Headers(upstream.mock.calls[0][1].headers);
  }

  it("forwards the caller's hashed IP with the service token that proves it", async () => {
    const headers = await redeemFrom("203.0.113.7");

    expect(headers.get("x-mcpjam-guest-ip-hash")).toBe(
      await hashGuestSpendIp("203.0.113.7"),
    );
    expect(headers.get("x-inspector-service-token")).toBe("service-secret");
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  // The point of forwarding: the backend's per-IP redeem limit must see two
  // visitors as two keys, not as this server's one address.
  it("keys two callers separately", async () => {
    const first = await redeemFrom("203.0.113.7");
    const second = await redeemFrom("198.51.100.4");

    expect(first.get("x-mcpjam-guest-ip-hash")).toBeTruthy();
    expect(second.get("x-mcpjam-guest-ip-hash")).toBeTruthy();
    expect(first.get("x-mcpjam-guest-ip-hash")).not.toBe(
      second.get("x-mcpjam-guest-ip-hash"),
    );
  });
});
