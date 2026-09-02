import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ACTOR ENUMERATION for the local agent browser's routes, mirroring the
 * terminal mint's suite. The install route in particular downloads hundreds of
 * megabytes onto someone's machine, so every gate gets a negative test:
 *
 *   verified sign-in — `requireVerifiedAuth` (401)
 *   non-guest        — explicit guest check (403)
 *   kill switch      — MCPJAM_LOCAL_BROWSER_ENABLED off (404)
 *   consent          — server-verified capability, install only (403)
 *
 * `status` deliberately does NOT require consent: the consent screen itself
 * has to know whether to offer an install, and a screen that cannot describe
 * the machine until you have authorized it cannot explain what it is asking.
 */
const scratch = mkdtempSync(join(tmpdir(), "mcpjam-local-browser-routes-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

const authState = vi.hoisted(() => ({ verified: true, guest: false }));
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: (c: any, next: any) => {
    if (authState.guest) c.set("guestId", "guest-1");
    return next();
  },
}));
vi.mock("../../../middleware/require-verified-auth.js", () => ({
  requireVerifiedAuth: () => (c: any, next: any) =>
    authState.verified ? next() : c.json({ error: "unauthorized" }, 401),
}));

const configState = vi.hoisted(() => ({ browserEnabled: true }));
vi.mock("../../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../../config.js")>(
    "../../../config.js",
  );
  return {
    ...actual,
    get LOCAL_BROWSER_ENABLED() {
      return configState.browserEnabled;
    },
  };
});

const chromiumState = vi.hoisted(() => ({
  installed: false,
  installs: 0,
}));
vi.mock("../../../utils/browser-rendering-setup.js", () => ({
  isChromiumInstalled: async () => chromiumState.installed,
  getChromiumInstallState: () => ({ status: "idle" as const }),
  startChromiumInstall: async () => {
    chromiumState.installs += 1;
    return { status: "installing" as const, percent: 0 };
  },
}));

vi.mock("../../../services/browserd/local/local-browser-session.js", () => ({
  listLocalBrowserSessions: () => [],
}));

import computers from "../computers.js";
import { LOCAL_CONSENT_HEADER } from "../../../utils/computers/local-consent.js";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function createApp() {
  const app = new Hono();
  app.route("/api/mcp/computers", computers);
  return app;
}

async function grantConsent(): Promise<string> {
  const response = await createApp().request(
    "/api/mcp/computers/local-consent/grant",
    { method: "POST" },
  );
  return ((await response.json()) as { token: string }).token;
}

beforeEach(() => {
  authState.verified = true;
  authState.guest = false;
  configState.browserEnabled = true;
  chromiumState.installed = false;
  chromiumState.installs = 0;
});

describe("GET /local-browser/status", () => {
  const status = () =>
    createApp().request("/api/mcp/computers/local-browser/status");

  it("reports whether this machine has a Chromium to drive", async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      installed: false,
      running: false,
      leaseHeld: false,
    });
  });

  it("answers without consent, so the consent screen can describe itself", async () => {
    expect((await status()).status).toBe(200);
  });

  it("404s when the operator turned the local browser off", async () => {
    configState.browserEnabled = false;
    // 404 rather than 403: a disabled capability should not be discoverable.
    expect((await status()).status).toBe(404);
  });

  it("401s an unverified caller and 403s a guest", async () => {
    authState.verified = false;
    expect((await status()).status).toBe(401);
    authState.verified = true;
    authState.guest = true;
    expect((await status()).status).toBe(403);
  });
});

describe("POST /local-browser/install", () => {
  const install = (headers: Record<string, string> = {}) =>
    createApp().request("/api/mcp/computers/local-browser/install", {
      method: "POST",
      headers,
    });

  it("refuses to download anything without consent", async () => {
    const res = await install();
    expect(res.status).toBe(403);
    expect(chromiumState.installs).toBe(0);
  });

  it("starts the install for a consenting user", async () => {
    const token = await grantConsent();
    const res = await install({ [LOCAL_CONSENT_HEADER]: token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      install: { status: "installing" },
    });
    expect(chromiumState.installs).toBe(1);
  });

  it("refuses a consent token that is not this machine's", async () => {
    await grantConsent();
    const res = await install({ [LOCAL_CONSENT_HEADER]: "not-the-capability" });
    expect(res.status).toBe(403);
    expect(chromiumState.installs).toBe(0);
  });
});
