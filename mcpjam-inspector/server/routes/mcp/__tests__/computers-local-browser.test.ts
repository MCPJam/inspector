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
  /** browser key → bootId, so a lookup can distinguish two live browsers. */
  byKey: new Map<string, string>(),
  /** Every set of arguments a route actually asked to launch a browser with. */
  launched: [] as Array<Record<string, unknown>>,
  /** Runs while a browser is "starting", to place a race deterministically. */
  onLaunch: null as null | (() => Promise<void>),
  /** Everything the pane's input actually reached CDP as. */
  cdpSent: [] as Array<{ method: string }>,
  /** Which Chromium this machine has: a downloaded one, or Electron's own. */
  runtime: "playwright" as "playwright" | "electron",
  /** Every session a route marked as in use, so "watching" is provable. */
  touched: [] as string[],
  /** Whether the desktop app builds its context with views the pane can show. */
  surface: "native" as "native" | "frames",
}));
/** The production key rule, so the mock and the assertions cannot disagree. */
const browserKeyFor = vi.hoisted(
  () =>
    (args: {
      projectId: string;
      contextMode?: string;
      ownerKey?: string;
      captureTypedText?: boolean;
    }) =>
      args.contextMode === "ephemeral"
        ? `${args.projectId}:ephemeral:${
            args.captureTypedText ? "typed" : "redacted"
          }:${args.ownerKey}`
        : `${args.projectId}:persistent`,
);

vi.mock("../../../services/browserd/local/local-browser-session.js", () => ({
  // The session store derives every path from this, and `homedir` is already
  // pointed at the scratch tree — so the real rule, not a stub, keeps the
  // store's own path checks doing their job.
  getLocalBrowserRoot: () =>
    join(scratch, ".mcpjam", "computer", "browser"),
  listLocalBrowserSessions: () =>
    [...browserState.sessions.values()].map((s: any) => ({
      key: "proj",
      handle: s.handle,
      lastUsedAt: 0,
      leaseHeld: s.lease.isBlocking(),
    })),
  findLocalBrowserSession: (bootId: string) =>
    browserState.sessions.get(bootId),
  // The real rule, kept in one place here as it is there: a persistent context
  // is the project's, an ephemeral one belongs to the run that owns it, and the
  // capture mode precedes the owner so an owner key cannot forge it.
  //
  // ONE HELPER, used by `ensureLocalBrowserSession` below too. A mock that
  // derived the key a second way drifted from production the moment the format
  // changed — and a test asserting a production-format key was then asserting
  // about a key this mock had never minted, which passes for the worst reason
  // there is.
  localBrowserKeyFor: browserKeyFor,
  findLocalBrowserSessionByKey: (key: string) => {
    const bootId = browserState.byKey.get(key);
    return bootId ? browserState.sessions.get(bootId) : undefined;
  },
  closeLocalBrowserSession: async (bootId: string) => {
    const session = browserState.sessions.get(bootId);
    if (!session) return { closed: false, reason: "not_found" } as const;
    if (session.lease.isBlocking()) {
      return { closed: false, reason: "lease_held" } as const;
    }
    browserState.sessions.delete(bootId);
    for (const [key, id] of browserState.byKey) {
      if (id === bootId) browserState.byKey.delete(key);
    }
    return { closed: true } as const;
  },
  // The read-only lookup the Tools pane uses. Deliberately NOT the ensure
  // path: it answers `undefined` when nothing is running rather than launching
  // a Chromium, and this fake models exactly that.
  findLocalBrowserSessionForProject: (projectId: string) => {
    if (projectId === "bad/project") throw new Error("invalid project key");
    return [...browserState.sessions.values()][0];
  },
  touchLocalBrowserSession: (handle: { bootId: string }) => {
    browserState.touched.push(handle.bootId);
  },
  resolveLocalBrowserRuntime: () => browserState.runtime,
  resolveLocalBrowserSurface: (
    _env: NodeJS.ProcessEnv,
    runtime: "playwright" | "electron",
  ) => (runtime === "electron" ? browserState.surface : "frames"),
  ensureLocalBrowserSession: async (args: {
    projectId: string;
    contextMode?: string;
    ownerKey?: string;
    captureTypedText?: boolean;
  }) => {
    browserState.launched.push({ ...args });
    const key = browserKeyFor(args);
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
    if (browserState.onLaunch) {
      const hook = browserState.onLaunch;
      browserState.onLaunch = null;
      await hook();
    }
    const existingId = browserState.byKey.get(key);
    const existing = existingId
      ? browserState.sessions.get(existingId)
      : undefined;
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
    browserState.byKey.set(key, stack.bootId);
    browserState.sessions.set(stack.bootId, {
      key,
      projectKey: args.projectId,
      ledger: stack.ledger,
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
  browserState.byKey.clear();
  browserState.launched = [];
  browserState.onLaunch = null;
  authState.verified = true;
  authState.guest = false;
  configState.browserEnabled = true;
  chromiumState.installed = false;
  chromiumState.installs = 0;
  browserState.runtime = "playwright";
  browserState.surface = "native";
  browserState.touched = [];
});

describe("POST /local-browser/watch", () => {
  const watch = (body: unknown, token: string | null) =>
    createApp().request("/api/mcp/computers/local-browser/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { [LOCAL_CONSENT_HEADER]: token } : {}),
      },
      body: JSON.stringify(body),
    });

  it("counts a watcher as use, so the idle reap does not close it underneath them", async () => {
    // The NATIVE Electron surface has no frame socket, and the socket's own
    // heartbeat was the only thing that said "somebody is looking at this".
    // Without this route a person watching the agent work — and not holding
    // the lease — has their browser closed while they are looking at it.
    const token = await grantConsent();
    const start = await createApp().request(
      "/api/mcp/computers/local-browser/ensure",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({ projectId: "proj" }),
      },
    );
    const { bootId } = (await start.json()) as { bootId: string };
    browserState.touched.length = 0;

    const res = await watch({ bootId }, token);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      watching: true,
      lease: { state: "free" },
    });
    expect(browserState.touched).toEqual([bootId]);
  });

  it("says who has the browser, so a refused pane can hear the hand-back", async () => {
    // The refusal reaches the pane on the frame socket. The HAND-BACK reaches
    // it as nothing at all — the frames were flowing the whole time — so this
    // is the only thing that can tell it. Answered HERE rather than by making
    // the pane call `ensure`, which would START a browser when the watched one
    // has gone: a Chromium nobody asked for, whose lease belongs to a
    // different boot than the pane is looking at.
    const token = await grantConsent();
    const start = await createApp().request(
      "/api/mcp/computers/local-browser/ensure",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({ projectId: "proj" }),
      },
    );
    const { bootId } = (await start.json()) as { bootId: string };
    const session = browserState.sessions.get(bootId)!;
    session.lease.acquire("someone-else");

    const held = await watch({ bootId }, token);
    expect(await held.json()).toMatchObject({
      watching: true,
      lease: { state: "held", holder: "someone-else" },
    });

    session.lease.release("someone-else");
    expect(await (await watch({ bootId }, token)).json()).toMatchObject({
      lease: { state: "free" },
    });
  });

  it("says so about a browser that has already gone", async () => {
    const res = await watch({ bootId: "boot-nope" }, await grantConsent());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ watching: false });
  });

  it("requires consent, like everything that touches the browser", async () => {
    expect((await watch({ bootId: "boot-1" }, null)).status).toBe(403);
  });
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

  it("says how the pane will see this browser", async () => {
    // The pane BRANCHES on this: a native surface has no frame socket to open,
    // and a pane that opened one anyway would make the engine encode JPEGs at
    // 30 fps that nobody ever draws. A Playwright browser is a separate
    // process with no view to place, so it is always frames.
    expect(await (await status()).json()).toMatchObject({ surface: "frames" });

    browserState.runtime = "electron";
    expect(await (await status()).json()).toMatchObject({ surface: "native" });

    // `MCPJAM_BROWSER_NATIVE_SURFACE=false` — hidden windows and frames over a
    // socket, exactly as before this wave.
    browserState.surface = "frames";
    expect(await (await status()).json()).toMatchObject({ surface: "frames" });
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

/**
 * The Tools pane's read of the local browser's page.
 *
 * The gate that matters beyond the usual four: this route must NEVER start a
 * browser. A tool list appearing in a side panel is not consent to open a
 * Chromium window on somebody's desk, so a project with nothing running gets a
 * `no_browser_session` answer rather than a launch.
 */
describe("POST /local-browser/page-tools", () => {
  const pageTools = (body: unknown, token: string | null) =>
    createApp().request("/api/mcp/computers/local-browser/page-tools", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { [LOCAL_CONSENT_HEADER]: token } : {}),
      },
      body: JSON.stringify(body),
    });

  async function startBrowser(token: string): Promise<void> {
    await createApp().request("/api/mcp/computers/local-browser/ensure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LOCAL_CONSENT_HEADER]: token,
      },
      body: JSON.stringify({ projectId: "proj" }),
    });
  }

  /**
   * Drive the browser to a page, the way a chat turn's `browser_navigate`
   * does. Sent straight to the daemon rather than through a route, because
   * navigation is a MODEL action — there is no human route for it, which is
   * exactly why the pane's read has to cope with there being no page yet.
   */
  async function openAPage(): Promise<void> {
    const session = [...browserState.sessions.values()][0];
    await session.client.sendCommand(
      {
        commandId: "open-a-page",
        source: "chat",
        action: { kind: "navigate", url: "https://webmcp.dev/" },
      },
      session.handle.bootId,
    );
  }

  it("requires consent", async () => {
    const res = await pageTools({ projectId: "proj" }, null);
    expect(res.status).toBe(403);
  });

  it("reads the page against a running browser", async () => {
    const token = await grantConsent();
    await startBrowser(token);
    await openAPage();

    const res = await pageTools({ projectId: "proj" }, token);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tools: unknown[];
      webmcpSupported: boolean;
    };
    expect(body.ok).toBe(true);
    // The fake page has no WebMCP bridge, which is the ordinary case for most
    // real pages too — and it must read as an ANSWER, not an error.
    expect(body.webmcpSupported).toBe(false);
    expect(body.tools).toEqual([]);
  });

  it("says a running browser has no page yet, rather than failing", async () => {
    // The state between a session starting and the model's first navigation.
    // The driver will not conjure an `about:blank` tab to observe, so the pane
    // has to be able to say "nothing loaded yet" about a browser that is up.
    const token = await grantConsent();
    await startBrowser(token);

    const res = await pageTools({ projectId: "proj" }, token);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "no_page" });
  });

  it("does not start a browser to answer", async () => {
    const token = await grantConsent();
    // Nothing running for this project.
    const res = await pageTools({ projectId: "proj" }, token);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "no_browser_session",
    });
    expect(browserState.sessions.size).toBe(0);
  });

  it("400s a malformed project key rather than reporting no browser", async () => {
    // The two are different things for the caller to do about, and collapsing
    // an invalid id into "nothing is running" hides a bug in the caller.
    const token = await grantConsent();
    const res = await pageTools({ projectId: "bad/project" }, token);
    expect(res.status).toBe(400);
  });

  it("does not count the read as use of the machine", async () => {
    // A pane polling a tool list is not somebody using the browser; counting it
    // would keep the idle reap from ever closing an abandoned one.
    const token = await grantConsent();
    await startBrowser(token);
    browserState.touched.length = 0;

    await pageTools({ projectId: "proj" }, token);

    expect(browserState.touched).toEqual([]);
  });
});

/**
 * WHICH BROWSER a logical session drives.
 *
 * A project does not name one. An ephemeral context belongs to the run that
 * owns it, so a project can have a person's persistent browser and several
 * throwaway ones at once — and resolving a session by project alone reached the
 * persistent one, which is somebody's real logged-in Chromium being driven
 * under a policy they never agreed to.
 */
describe("the agent door's session routes", () => {
  const openSession = (body: unknown, token: string) =>
    createApp().request("/api/mcp/computers/local-browser/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LOCAL_CONSENT_HEADER]: token,
      },
      body: JSON.stringify(body),
    });

  const command = (body: unknown, token: string) =>
    createApp().request("/api/mcp/computers/local-browser/command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LOCAL_CONSENT_HEADER]: token,
      },
      body: JSON.stringify(body),
    });

  it("drives the EPHEMERAL session's own browser, not the project's", async () => {
    const token = await grantConsent();
    // The person's browser first, so there is a wrong answer available.
    const persistent = await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    expect(persistent.status).toBe(200);
    const personBoot = ((await persistent.json()) as any).bootId;

    const ephemeral = await openSession(
      {
        projectId: "proj",
        profile: "ephemeral",
        runKey: "run-7",
        policy: { mode: "allow_all" },
        observe: "none",
      },
      token,
    );
    expect(ephemeral.status).toBe(200);
    const run = (await ephemeral.json()) as any;
    expect(run.bootId).not.toBe(personBoot);

    const ran = await command(
      {
        projectId: "proj",
        sessionId: run.session.sessionId,
        command: { op: "observe", mode: "a11y" },
      },
      token,
    );
    expect(ran.status).toBe(200);
    // The row lands in the throwaway browser's ledger. Landing in the other
    // one would mean the command RAN there.
    const ephemeralLedger = browserState.sessions.get(run.bootId).ledger;
    const personLedger = browserState.sessions.get(personBoot).ledger;
    expect(ephemeralLedger.read({}).entries.length).toBeGreaterThan(0);
    expect(personLedger.read({}).entries).toHaveLength(0);
  });

  it("refuses ephemeral + attach: require BEFORE launching anything", async () => {
    // `require` can never be satisfied by a throwaway context, which is never
    // shared. Checking only for a live persistent session let the pair through
    // whenever the project happened to have one — and the store's refusal then
    // arrived one launched Chromium too late, leaving a browser on somebody's
    // desk that no session owns.
    const token = await grantConsent();
    await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    browserState.launched = [];

    const res = await openSession(
      {
        projectId: "proj",
        profile: "ephemeral",
        runKey: "run-8",
        attach: "require",
        policy: { mode: "allow_all" },
      },
      token,
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as any).toMatchObject({
      error: "nothing_to_attach",
    });
    expect(browserState.launched).toEqual([]);
  });

  it("reads the EPHEMERAL session's own trace, not the person's browser", async () => {
    // Mirroring is a WRITE into the session's durable history. Reading an
    // ephemeral session's trace off the persistent ring copied the person's
    // browsing into an unattended run's ledger — and, the boot ids differing,
    // wrote a `daemon_restart` gap claiming the run's browser had relaunched.
    const token = await grantConsent();
    await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const ephemeral = await openSession(
      {
        projectId: "proj",
        profile: "ephemeral",
        runKey: "run-t",
        policy: { mode: "allow_all" },
        observe: "none",
      },
      token,
    );
    const run = (await ephemeral.json()) as any;

    // Something drives the PERSON's browser.
    const personBoot = browserState.byKey.get("proj:persistent")!;
    const personLedger = browserState.sessions.get(personBoot).ledger;
    personLedger.record({
      command: {
        commandId: "person-1",
        source: "manual",
        action: { kind: "navigate", url: "https://bank.example/statements" },
      },
      actor: { kind: "human", id: "pane:u" },
      ts: Date.now(),
      durationMs: 1,
      outcome: "executed",
      ok: true,
    });

    const trace = await createApp().request(
      "/api/mcp/computers/local-browser/trace",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({
          projectId: "proj",
          sessionId: run.session.sessionId,
        }),
      },
    );
    expect(trace.status).toBe(200);
    const body = (await trace.json()) as any;
    // Nothing of the person's, and no invented restart.
    expect(JSON.stringify(body)).not.toContain("bank.example");
    expect(
      (body.entries ?? []).some((e: any) => e.reason === "daemon_restart"),
    ).toBe(false);
  });

  it("terminates the EPHEMERAL session's browser, not the person's", async () => {
    // `live` was the project's persistent Chromium whatever session was
    // closing, so ending a throwaway run shut the window somebody was signed
    // into and left the run's own process up.
    const token = await grantConsent();
    await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const ephemeral = await openSession(
      {
        projectId: "proj",
        profile: "ephemeral",
        runKey: "run-x",
        policy: { mode: "allow_all" },
        observe: "none",
      },
      token,
    );
    const run = (await ephemeral.json()) as any;

    const closed = await createApp().request(
      "/api/mcp/computers/local-browser/close",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({
          projectId: "proj",
          sessionId: run.session.sessionId,
          terminate: true,
        }),
      },
    );

    expect(closed.status).toBe(200);
    expect((await closed.json()) as any).toMatchObject({ terminated: true });
    // The run's browser is gone; the person's is untouched.
    expect(browserState.byKey.has("proj:ephemeral:redacted:run-x")).toBe(false);
    expect(browserState.byKey.has("proj:persistent")).toBe(true);
  });

  it("does not keep writing history into a session that has CLOSED", async () => {
    // A closed session's trace still reads — that is what durable means — but
    // it must stop GROWING. The project's next session gets the same
    // `proj:persistent` browser, so a closed session that still mirrors would
    // absorb the next person's browsing under a name that had already left.
    const token = await grantConsent();
    const opened = await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const person = (await opened.json()) as any;
    await createApp().request("/api/mcp/computers/local-browser/close", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LOCAL_CONSENT_HEADER]: token,
      },
      body: JSON.stringify({
        projectId: "proj",
        sessionId: person.session.sessionId,
        terminate: true,
      }),
    });

    // Somebody else opens the project's browser and uses it.
    await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const boot = browserState.byKey.get("proj:persistent")!;
    browserState.sessions.get(boot).ledger.record({
      command: {
        commandId: "after-1",
        source: "manual",
        action: { kind: "navigate", url: "https://after.example/private" },
      },
      actor: { kind: "human", id: "pane:u" },
      ts: Date.now(),
      durationMs: 1,
      outcome: "executed",
      ok: true,
    });

    const trace = await createApp().request(
      "/api/mcp/computers/local-browser/trace",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({
          projectId: "proj",
          sessionId: person.session.sessionId,
        }),
      },
    );
    expect(trace.status).toBe(200);
    expect(JSON.stringify(await trace.json())).not.toContain("after.example");
  });

  it("will not serve another session's artifact from the shared store", async () => {
    // The payload store is the PROJECT's, so the path stopped scoping the read.
    // The descriptor lookup is the only thing left that says whose artifact it
    // is — and reading it without acting on it made a guessed id enough.
    const token = await grantConsent();
    const mine = await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const session = (await mine.json()) as any;
    const res = await createApp().request(
      "/api/mcp/computers/local-browser/artifact",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({
          projectId: "proj",
          sessionId: session.session.sessionId,
          // Never in this session's ledger.
          artifactId: "art_someone_elses",
        }),
      },
    );
    // 404, not 410: 410 would confirm the id is real somewhere.
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toMatchObject({
      error: "no_such_artifact",
    });
  });

  it("refuses a misspelled profile rather than opening the real browser", async () => {
    const token = await grantConsent();
    const res = await openSession(
      {
        projectId: "proj",
        profile: "ephermal",
        policy: { mode: "allow_all" },
      },
      token,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      error: "invalid_profile",
    });
    // Nothing was started on the strength of a typo.
    expect(browserState.launched).toEqual([]);
  });

  it("refuses a malformed runKey rather than minting a different one", async () => {
    // Two opens naming one run would otherwise get two browsers, and neither
    // could be reattached with the key the caller actually sent.
    const token = await grantConsent();
    const res = await openSession(
      {
        projectId: "proj",
        profile: "ephemeral",
        runKey: "not a valid key!",
        policy: { mode: "allow_all" },
      },
      token,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      error: "invalid_run_key",
    });
    expect(browserState.launched).toEqual([]);
  });

  it("terminate does not kill a browser a new session just attached to", async () => {
    // The close route marked the session closed, listed the others, then
    // disposed — three awaits with nothing holding them together. An `open`
    // whose session appeared in that gap was invisible to the check and had
    // its Chromium shut underneath it.
    const token = await grantConsent();
    const first = await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const person = (await first.json()) as any;

    // A SEPARATE session on the same browser — `attach: "never"` makes it its
    // own record rather than joining the first, which is the case where the
    // browser genuinely has two users.
    const second = await openSession(
      {
        projectId: "proj",
        attach: "never",
        policy: { mode: "allow_all" },
        observe: "none",
      },
      token,
    );
    expect(second.status).toBe(200);

    const closed = await createApp().request(
      "/api/mcp/computers/local-browser/close",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({
          projectId: "proj",
          sessionId: person.session.sessionId,
          terminate: true,
        }),
      },
    );

    expect(closed.status).toBe(200);
    expect((await closed.json()) as any).toMatchObject({ terminated: false });
    // The browser the second session is using is still there.
    expect(browserState.byKey.has("proj:persistent")).toBe(true);
  });

  it("does not leave a browser behind when the attach race is lost", async () => {
    // `require` pre-checks for an open session, then starts a browser. A close
    // landing in between means the claim fails — and a browser this request
    // started is then owned by nobody, sitting on somebody's desk until the
    // idle reaper notices. A browser reaped for idleness while its logical
    // session stayed open makes that sequence real, not theoretical.
    const token = await grantConsent();
    const opened = await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const person = (await opened.json()) as any;
    // The browser goes away, the logical session does not — what an idle reap
    // leaves behind.
    browserState.sessions.clear();
    browserState.byKey.clear();
    browserState.launched = [];

    // The close lands AFTER the pre-check and BEFORE the claim — the only
    // window in which this goes wrong, placed deterministically rather than
    // hoped for.
    const { leaveAgentSession } = await import(
      "../../../services/browserd/local/agent-session-store.js"
    );
    browserState.onLaunch = async () => {
      await leaveAgentSession({
        projectId: "proj",
        sessionId: person.session.sessionId,
        actorId: "cli:abc",
        terminate: true,
      });
    };
    const res = await openSession(
      {
        projectId: "proj",
        attach: "require",
        policy: { mode: "allow_all" },
        observe: "none",
      },
      token,
    );
    // The browser really was started, which is what makes this a leak.
    expect(browserState.launched).toHaveLength(1);

    expect(res.status).toBe(409);
    expect((await res.json()) as any).toMatchObject({
      error: "nothing_to_attach",
    });
    // Nothing left running that no session owns.
    expect(browserState.sessions.size).toBe(0);
  });

  it("an unrelated run does not keep somebody's browser open", async () => {
    // Two sessions can share one browser, so terminate waits on the others —
    // but an ephemeral run has its own Chromium, and counting it made a
    // throwaway box the stated reason a person's browser stayed up.
    const token = await grantConsent();
    const persistent = await openSession(
      { projectId: "proj", policy: { mode: "allow_all" }, observe: "none" },
      token,
    );
    const person = (await persistent.json()) as any;
    await openSession(
      {
        projectId: "proj",
        profile: "ephemeral",
        runKey: "run-9",
        policy: { mode: "allow_all" },
        observe: "none",
      },
      token,
    );

    const closed = await createApp().request(
      "/api/mcp/computers/local-browser/close",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_CONSENT_HEADER]: token,
        },
        body: JSON.stringify({
          projectId: "proj",
          sessionId: person.session.sessionId,
          terminate: true,
        }),
      },
    );

    expect(closed.status).toBe(200);
    expect((await closed.json()) as any).toMatchObject({ terminated: true });
    // The run's own browser is untouched by the person's session ending.
    expect(browserState.byKey.has("proj:ephemeral:redacted:run-9")).toBe(true);
  });
});
