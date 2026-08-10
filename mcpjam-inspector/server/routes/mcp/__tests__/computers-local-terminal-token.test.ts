import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ACTOR ENUMERATION for the local-terminal nonce mint. This route hands out the
 * only credential that opens an interactive shell on the user's machine — with
 * no per-command approval, unlike the chat `bash` tool. Every gate gets a
 * negative test here:
 *
 *   session          — app-level `/api/mcp` middleware (its own suites)
 *   verified sign-in — `requireVerifiedAuth` (401)
 *   non-guest        — explicit guest check (403)
 *   kill switch      — MCPJAM_LOCAL_COMPUTER_ENABLED off (404)
 *   consent          — server-verified capability (403)
 *   availability     — node-pty / engine probe (503)
 *   project key      — one bounded path segment (400)
 *
 * Hosted mode is covered structurally elsewhere: `/api/mcp` isn't mounted at
 * all hosted, and `LOCAL_COMPUTER_ENABLED` is forced off there.
 */
const scratch = mkdtempSync(join(tmpdir(), "mcpjam-local-terminal-token-"));
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

const terminalState = vi.hoisted(() => ({
  availability: { available: true } as
    | { available: true }
    | { available: false; reason: string },
}));
vi.mock("../../../utils/computers/local-pty.js", () => ({
  getLocalTerminalAvailability: async () => terminalState.availability,
}));

import computers from "../computers.js";
import { LOCAL_CONSENT_HEADER } from "../../../utils/computers/local-consent.js";
import {
  consumeLocalTerminalNonce,
  resetLocalTerminalNoncesForTests,
} from "../../../utils/computers/local-terminal-auth.js";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function createApp() {
  const app = new Hono();
  app.route("/api/mcp/computers", computers);
  return app;
}

async function grantConsent(): Promise<string> {
  const response = await createApp().request(
    "/api/mcp/computers/local-consent/grant",
    { method: "POST" }
  );
  const json = (await response.json()) as { token: string };
  return json.token;
}

function mint(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return Promise.resolve(
    createApp().request("/api/mcp/computers/local-terminal-token", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  authState.verified = true;
  authState.guest = false;
  authState.bearerSeen = 0;
  authState.verifySeen = 0;
  configState.localEnabled = true;
  terminalState.availability = { available: true };
  resetLocalTerminalNoncesForTests();
});

describe("POST /api/mcp/computers/local-terminal-token", () => {
  it("mints a redeemable, project-bound nonce for a consented member", async () => {
    const consent = await grantConsent();
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      nonce: string;
      expiresAtMs: number;
    };
    expect(typeof json.nonce).toBe("string");
    expect(json.expiresAtMs).toBeGreaterThan(Date.now());
    expect(consumeLocalTerminalNonce(json.nonce)).toEqual({
      projectId: "proj_1",
    });
  });

  it("returns the nonce and its deadline — and NOTHING else", async () => {
    const consent = await grantConsent();
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    // No workspace path, no shell, no OS username may leave the server here.
    expect(Object.keys((await response.json()) as object).sort()).toEqual([
      "expiresAtMs",
      "nonce",
    ]);
  });

  it("APPLIES the auth middleware stack exactly once", async () => {
    const consent = await grantConsent();
    authState.bearerSeen = 0;
    authState.verifySeen = 0;
    await mint({ projectId: "proj_1" }, { [LOCAL_CONSENT_HEADER]: consent });
    // The gates must actually run on this path (an unmatched registration would
    // silently leave the mint ungated) — and exactly once, so the bearer isn't
    // resolved twice per mint.
    expect(authState.bearerSeen).toBe(1);
    expect(authState.verifySeen).toBe(1);
  });

  it("401s an unverified caller", async () => {
    const consent = await grantConsent();
    authState.verified = false;
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    expect(response.status).toBe(401);
  });

  it("403s a guest", async () => {
    const consent = await grantConsent();
    authState.guest = true;
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    expect(response.status).toBe(403);
  });

  it("404s when the kill switch is off", async () => {
    const consent = await grantConsent();
    configState.localEnabled = false;
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    expect(response.status).toBe(404);
  });

  it("403s with NO consent header — an unauthorized machine never mints", async () => {
    await grantConsent();
    const response = await mint({ projectId: "proj_1" });
    expect(response.status).toBe(403);
  });

  it("403s a WRONG consent token", async () => {
    await grantConsent();
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: "n".repeat(43) }
    );
    expect(response.status).toBe(403);
  });

  it("403s once consent has been revoked", async () => {
    const consent = await grantConsent();
    await createApp().request("/api/mcp/computers/local-consent/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: consent }),
    });
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    expect(response.status).toBe(403);
  });

  it("503s when the local terminal isn't available (node-pty missing)", async () => {
    const consent = await grantConsent();
    terminalState.availability = {
      available: false,
      reason: "node-pty is not available on this server",
    };
    const response = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    expect(response.status).toBe(503);
  });

  it("400s a project key that isn't one bounded path segment", async () => {
    const consent = await grantConsent();
    for (const projectId of ["../../etc", "a/b", "", 42]) {
      const response = await mint(
        { projectId },
        { [LOCAL_CONSENT_HEADER]: consent }
      );
      expect(response.status).toBe(400);
    }
  });

  it("mints a DISTINCT nonce per call (no reuse across reconnects)", async () => {
    const consent = await grantConsent();
    const a = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    const b = await mint(
      { projectId: "proj_1" },
      { [LOCAL_CONSENT_HEADER]: consent }
    );
    const first = (await a.json()) as { nonce: string };
    const second = (await b.json()) as { nonce: string };
    expect(first.nonce).not.toBe(second.nonce);
  });
});
