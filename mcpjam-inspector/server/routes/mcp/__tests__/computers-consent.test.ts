import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Router-level behavior of the consent routes: kill-switch 404, guest 403,
 * unverified 401, and the grant/verify/revoke round trip. The auth
 * middlewares are simulated by a controllable stand-in — their own behavior
 * (guest labeling, `unverified_passthrough` → reject) is covered by their own
 * suites; what THIS suite pins is that the router mounts them on every
 * consent path and applies its own gates in the right order. The inspector
 * session layer sits above (app-level `sessionAuthMiddleware` on /api/mcp)
 * and is exercised by the app-level suites.
 */
const scratch = mkdtempSync(join(tmpdir(), "mcpjam-consent-routes-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

const authState = vi.hoisted(() => ({
  verified: true,
  guest: false,
  bearerSeen: 0,
  verifySeen: 0,
}));
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: (c: any, next: any) => {
    authState.bearerSeen += 1;
    if (authState.guest) c.set("guestId", "guest-1");
    return next();
  },
}));
vi.mock("../../../middleware/require-verified-auth.js", () => ({
  requireVerifiedAuth: () => (c: any, next: any) => {
    authState.verifySeen += 1;
    if (!authState.verified) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  },
}));

const configState = vi.hoisted(() => ({ localEnabled: true }));
vi.mock("../../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../../config.js")>(
    "../../../config.js"
  );
  return {
    ...actual,
    get LOCAL_COMPUTER_ENABLED() {
      return configState.localEnabled;
    },
  };
});

import computers from "../computers.js";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  app.route("/api/mcp/computers", computers);
  return app;
}

async function post(
  app: Hono,
  path: string,
  body?: unknown
): Promise<Response> {
  return app.request(`/api/mcp/computers${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("local-consent routes", () => {
  beforeEach(() => {
    authState.verified = true;
    authState.guest = false;
    authState.bearerSeen = 0;
    authState.verifySeen = 0;
    configState.localEnabled = true;
  });

  it("mounts BOTH auth middlewares on every consent path", async () => {
    for (const path of [
      "/local-consent/grant",
      "/local-consent/verify",
      "/local-consent/revoke",
    ]) {
      await post(makeApp(), path, {});
    }
    expect(authState.bearerSeen).toBe(3);
    expect(authState.verifySeen).toBe(3);
  });

  it("404s everything when the kill switch is off", async () => {
    configState.localEnabled = false;
    const response = await post(makeApp(), "/local-consent/grant");
    expect(response.status).toBe(404);
  });

  it("401s an unverified bearer BEFORE any capability work", async () => {
    authState.verified = false;
    const response = await post(makeApp(), "/local-consent/grant");
    expect(response.status).toBe(401);
  });

  it("403s guests", async () => {
    authState.guest = true;
    const response = await post(makeApp(), "/local-consent/grant");
    expect(response.status).toBe(403);
  });

  it("grant → verify(token) → revoke → verify(false) round trip", async () => {
    const app = makeApp();
    const granted = await post(app, "/local-consent/grant");
    expect(granted.status).toBe(200);
    const { token } = (await granted.json()) as { token: string };
    expect(token.length).toBeGreaterThan(30);

    const verified = await post(app, "/local-consent/verify", { token });
    expect(await verified.json()).toEqual({ valid: true });

    const revoked = await post(app, "/local-consent/revoke");
    expect(revoked.status).toBe(200);

    const after = await post(app, "/local-consent/verify", { token });
    expect(await after.json()).toEqual({ valid: false });
  });

  it("verify tolerates a malformed body", async () => {
    const response = await post(makeApp(), "/local-consent/verify");
    expect(await response.json()).toEqual({ valid: false });
  });
});
