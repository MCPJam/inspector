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
  const actual =
    await vi.importActual<typeof import("../../../config.js")>(
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

/**
 * A real browserd stack over the fake browser, so these routes are exercised
 * against the actual lease rather than a mock of it. The lease is the whole
 * point of the pane's routes; a stubbed one would test nothing.
 */
const browserState = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  /** Everything the pane's input actually reached CDP as. */
  cdpSent: [] as Array<{ method: string }>,
  /** Which Chromium this machine has: a downloaded one, or Electron's own. */
  runtime: "playwright" as "playwright" | "electron",
}));
vi.mock("../../../services/browserd/local/local-browser-session.js", () => ({
  listLocalBrowserSessions: () =>
    [...browserState.sessions.values()].map((s: any) => ({
      key: "proj",
      handle: s.handle,
      lastUsedAt: 0,
      leaseHeld: s.lease.isBlocking(),
    })),
  findLocalBrowserSession: (bootId: string) =>
    browserState.sessions.get(bootId),
  touchLocalBrowserSession: () => {},
  resolveLocalBrowserRuntime: () => browserState.runtime,
  ensureLocalBrowserSession: async () => {
    const { buildBrowserdStack } =
      await import("../../../services/browserd/daemon/server.js");
    const { ChromiumDriver } =
      await import("../../../services/browserd/daemon/chromium-driver.js");
    const { HandoffLease } =
      await import("../../../services/browserd/daemon/lease.js");
    const { createInProcessBrowserdClient } =
      await import("../../../services/browserd/in-process-client.js");
    const { fakeContext, fakePage, fakeCdpSession } =
      await import("../../../services/browserd/daemon/__tests__/fake-page.js");
    const existing = [...browserState.sessions.values()][0];
    if (existing) return existing.handle;

    const lease = new HandoffLease();
    // A page whose CDP session RECORDS, so a test can count what the pane's
    // input actually reached the browser as.
    const page = fakePage();
    const recording = fakeCdpSession();
    page.cdpSession = recording;
    browserState.cdpSent = recording.sent;
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { lease });
    const stack = buildBrowserdStack(driver, { token: "tok", lease });
    const client = createInProcessBrowserdClient(stack, "tok");
    const handle = {
      engine: "local" as const,
      bootId: stack.bootId,
      client,
      contextMode: "persistent" as const,
      reused: false,
    };
    browserState.sessions.set(stack.bootId, {
      client,
      handler: stack.handler,
      handle,
      lease,
    });
    return handle;
  },
  LocalBrowserUnavailableError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
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
  // Each test gets a fresh browser: these sessions carry a LEASE, and a lease
  // held over from a previous test is the kind of shared state that makes a
  // suite pass in isolation and fail in order.
  browserState.sessions.clear();
  authState.verified = true;
  authState.guest = false;
  configState.browserEnabled = true;
  chromiumState.installed = false;
  chromiumState.installs = 0;
  browserState.runtime = "playwright";
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

  it("has nothing to install in the desktop app", async () => {
    // Electron IS a Chromium. Probing for a DOWNLOADED one reports
    // `installed: false` on a machine with a browser already open, and the
    // consent screen then offers a hundreds-of-megabyte download for nothing.
    browserState.runtime = "electron";
    chromiumState.installed = false;

    const body = await (await status()).json();

    expect(body).toMatchObject({
      runtime: "electron",
      installed: true,
      install: { status: "ready" },
    });
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

describe("driving the browser from the pane", () => {
  async function ensured(token: string) {
    const res = await createApp().request(
      "/api/mcp/computers/local-browser/ensure",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({ projectId: "proj-1" }),
      },
    );
    return (await res.json()) as { bootId: string };
  }

  function post(path: string, token: string, body: unknown) {
    return createApp().request(`/api/mcp/computers/local-browser/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LOCAL_CONSENT_HEADER]: token,
      },
      body: JSON.stringify(body),
    });
  }

  it("starts a browser and reports how to reach it", async () => {
    const token = await grantConsent();
    const { bootId } = await ensured(token);
    expect(bootId).toBeTruthy();
  });

  it("refuses input until somebody takes control", async () => {
    // With the lease free the agent may be mid-turn, and two drivers on one
    // page is exactly what the lease prevents.
    const token = await grantConsent();
    const { bootId } = await ensured(token);
    const res = await post("input", token, {
      bootId,
      holder: "pane-1",
      events: [{ type: "text", text: "hello" }],
    });
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "lease_required" });
  });

  it("takes control, accepts that pane's input, and refuses another's", async () => {
    const token = await grantConsent();
    const { bootId } = await ensured(token);

    const taken = await post("lease", token, {
      bootId,
      action: "acquire",
      holder: "pane-1",
    });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({
      lease: { state: "held", holder: "pane-1", holderKind: "human" },
    });

    expect(
      (
        await post("input", token, {
          bootId,
          holder: "pane-1",
          events: [{ type: "text", text: "hunter2" }],
        })
      ).status,
    ).toBe(200);

    const other = await post("input", token, {
      bootId,
      holder: "pane-2",
      events: [{ type: "text", text: "steal" }],
    });
    expect(other.status).toBe(423);
    expect(await other.json()).toMatchObject({ error: "lease_held_by_other" });
  });

  it("accepts at most 64 events per request, and says so by dropping the rest", async () => {
    // The client chunks at the same number (`INPUT_BATCH_LIMIT` in
    // `client/src/lib/local-browser/client.ts`). This is the server half of
    // that pair: if the two ever drift, an oversized batch loses its tail
    // silently, which for keys means a page holding one nobody pressed.
    const token = await grantConsent();
    const { bootId } = await ensured(token);
    await post("lease", token, { bootId, action: "acquire", holder: "pane-1" });

    const before = browserState.cdpSent.filter(
      (c) => c.method === "Input.insertText",
    ).length;
    const events = Array.from({ length: 100 }, (_, i) => ({
      type: "text" as const,
      text: `k${i}`,
    }));
    expect(
      (await post("input", token, { bootId, holder: "pane-1", events })).status,
    ).toBe(200);

    const after = browserState.cdpSent.filter(
      (c) => c.method === "Input.insertText",
    ).length;
    expect(after - before).toBe(64);
  });

  it("tells a second pane it did not get control", async () => {
    const token = await grantConsent();
    const { bootId } = await ensured(token);
    await post("lease", token, { bootId, action: "acquire", holder: "pane-1" });
    const second = await post("lease", token, {
      bootId,
      action: "acquire",
      holder: "pane-2",
    });
    // 409, never a silent no-op: a pane that believes it has the browser would
    // show a person a live view while the agent kept driving.
    expect(second.status).toBe(409);
  });

  it("records that a SCRIPT is driving, so the resume note can say so", async () => {
    const token = await grantConsent();
    const { bootId } = await ensured(token);
    const res = await post("lease", token, {
      bootId,
      action: "acquire",
      holder: "cdp-1",
      kind: "script",
    });
    expect(await res.json()).toMatchObject({
      lease: { holderKind: "script" },
    });
  });

  it("needs consent for every one of these", async () => {
    const token = await grantConsent();
    const { bootId } = await ensured(token);
    for (const [path, body] of [
      ["ensure", { projectId: "proj-1" }],
      ["token", { projectId: "proj-1" }],
      ["lease", { bootId, action: "acquire", holder: "p" }],
      ["input", { bootId, holder: "p", events: [{ type: "text", text: "x" }] }],
    ] as const) {
      const res = await createApp().request(
        `/api/mcp/computers/local-browser/${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(res.status, `${path} must require consent`).toBe(403);
    }
  });

  it("mints a frames nonce that is single-use and kind-bound", async () => {
    const { consumeLocalNonce } =
      await import("../../../utils/computers/local-terminal-auth.js");
    const token = await grantConsent();
    const res = await post("token", token, { projectId: "proj-1" });
    const { nonce } = (await res.json()) as { nonce: string };

    // A frames nonce must not open a shell.
    expect(consumeLocalNonce("terminal", nonce)).toBeNull();
    // And having been tried, it is spent — probing which kind it is must not
    // be free.
    expect(consumeLocalNonce("browser-frames", nonce)).toBeNull();
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

  it("does not try to download a browser the desktop app already has", async () => {
    // The packaged app has no `node_modules` for the Playwright CLI to live
    // in, so starting an install here does not merely waste a download — it
    // fails. The status route already answers `ready`; this must not
    // contradict it.
    browserState.runtime = "electron";
    const token = await grantConsent();

    const res = await install({ [LOCAL_CONSENT_HEADER]: token });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ install: { status: "ready" } });
    expect(chromiumState.installs).toBe(0);
  });

  it("refuses a consent token that is not this machine's", async () => {
    await grantConsent();
    const res = await install({ [LOCAL_CONSENT_HEADER]: "not-the-capability" });
    expect(res.status).toBe(403);
    expect(chromiumState.installs).toBe(0);
  });
});
