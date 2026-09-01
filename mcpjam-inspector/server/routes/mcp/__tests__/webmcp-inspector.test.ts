/**
 * Route-level behaviour: status codes, the kill switch, and the SSE stream.
 * The browser is a fake — protocol fidelity is covered against a real Chromium
 * in `services/webmcp-inspector/__tests__/`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const configState = vi.hoisted(() => ({ enabled: true, hostedBrowser: false }));
vi.mock("../../../config", () => ({
  get WEBMCP_INSPECTOR_ENABLED() {
    return configState.enabled;
  },
  hostedBrowserEnabled: () => configState.hostedBrowser,
  HOSTED_MODE: false,
}));

// The hosted transport's two live seams. Mocked so the switch can be tested
// without an E2B sandbox: what matters here is WHICH provider the route
// picks, and with what identity — the provider's own behaviour is covered in
// `services/webmcp-inspector/__tests__/browserd-provider.test.ts`.
const hostedState = vi.hoisted(() => ({
  ensureArgs: [] as Array<Record<string, unknown>>,
  createdProviders: 0,
}));
vi.mock("../../../services/browserd/live-session-deps.js", () => ({
  ensureLiveBrowserSession: (args: Record<string, unknown>) => {
    hostedState.ensureArgs.push(args);
    return Promise.reject(
      new Error("ensureLiveBrowserSession not reached in this test"),
    );
  },
}));

// The embedded-surface transport's seam. Mocked for the same reason as the
// hosted one: what matters at this layer is WHICH provider the route picks and
// with what id — attaching to a real `<webview>` needs an Electron main process
// and is covered against a fake one in
// `services/webmcp-inspector/__tests__/electron-webview-provider.test.ts`.
const webviewState = vi.hoisted(() => ({
  factoryArgs: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../../services/webmcp-inspector/electron-webview-provider", () => ({
  createElectronWebviewProvider: (args: Record<string, unknown>) => {
    webviewState.factoryArgs.push(args);
    return {
      createSession: () =>
        Promise.reject(
          new Error("createElectronWebviewProvider not reached in this test"),
        ),
    };
  },
  WebMcpWebviewAttachError: class WebMcpWebviewAttachError extends Error {},
}));

import {
  startWebMcpSession,
  webMcpSessions,
} from "../../../services/webmcp-inspector/session-registry";
import {
  FakeProvider,
  fakeTool,
} from "../../../services/webmcp-inspector/__tests__/fake-provider";
import webmcpInspector from "../webmcp-inspector";
import { Hono } from "hono";

const app = new Hono().route("/api/mcp/webmcp", webmcpInspector);

async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`http://local${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function json(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/** Open a session through the shared singleton the routes read. */
async function openSession(provider: FakeProvider) {
  return startWebMcpSession({
    url: "https://example.test/",
    provider,
    registry: webMcpSessions,
  });
}

describe("webmcp-inspector routes", () => {
  let provider: FakeProvider;

  beforeEach(async () => {
    configState.enabled = true;
    await webMcpSessions.disposeAll();
    provider = new FakeProvider();
  });

  it("404s every route when the kill switch is off", async () => {
    configState.enabled = false;
    // Not 403: a disabled capability should not be discoverable.
    expect(
      (await call("/api/mcp/webmcp/sessions", json({ url: "https://a.test" })))
        .status,
    ).toBe(404);
    expect((await call("/api/mcp/webmcp/sessions/anything")).status).toBe(404);
    const { status, body } = await call("/api/mcp/webmcp/sessions/x", {
      method: "DELETE",
    });
    expect(status).toBe(404);
    expect(body.code).toBe("webmcp-inspector-disabled");
  });

  it("rejects a non-http URL", async () => {
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "file:///etc/passwd" }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/http/i);
  });

  it.each([
    ["empty", ""],
    ["null", null],
  ])("rejects a %s session URL", async (_label, url) => {
    const { status } = await call("/api/mcp/webmcp/sessions", json({ url }));
    expect(status).toBe(400);
  });

  it("rejects a non-http navigation URL", async () => {
    const started = await openSession(provider);
    const { status, body } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "navigate", url: "file:///etc/passwd" }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/http/i);
  });

  it("rejects a null command body", async () => {
    const started = await openSession(provider);
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json(null),
    );
    expect(status).toBe(400);
  });

  it("rejects an invocation with an empty tool key", async () => {
    const started = await openSession(provider);
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "invoke_tool", toolKey: "", input: {} }),
    );
    expect(status).toBe(400);
  });

  it("404s an unknown session", async () => {
    const { status, body } = await call("/api/mcp/webmcp/sessions/nope");
    expect(status).toBe(404);
    expect(body.code).toBe("session-not-found");
  });

  it("describes a session with its current tools", async () => {
    const started = await openSession(provider);
    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
    ]);

    const { status, body } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}`,
    );
    expect(status).toBe(200);
    expect(body.session.sessionId).toBe(started.sessionId);
    expect(body.session.viewportTransport).toEqual({ kind: "native-window" });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].toolKey).toBe("https://example.test::echo");
  });

  it("accepts an invocation with 202 and an invokeId", async () => {
    const started = await openSession(provider);
    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
    ]);

    const { status, body } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({
        type: "invoke_tool",
        toolKey: "https://example.test::echo",
        input: { text: "hi" },
        source: "manual",
      }),
    );
    // 202: the invocation is queued, and its outcome arrives on the stream.
    expect(status).toBe(202);
    expect(body.invokeId).toBeTruthy();
  });

  it("409s navigation while a tool is running", async () => {
    const started = await openSession(provider);
    const session = provider.sessions[0];
    session.emitTools([fakeTool({ origin: "https://example.test" })]);
    session.hangOnInvoke = true;

    await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({
        type: "invoke_tool",
        toolKey: "https://example.test::echo",
        input: {},
      }),
    );
    await vi.waitFor(() => expect(session.invocations).toHaveLength(1));

    const { status, body } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "navigate", url: "https://elsewhere.test/" }),
    );
    // Navigating out from under a running tool would settle it as a mystery
    // failure.
    expect(status).toBe(409);
    expect(body.code).toBe("busy");

    session.pending?.resolve({ output: "done" });
  });

  it("reports cancelling an already-settled invocation as cancelled:false", async () => {
    const started = await openSession(provider);
    const { status, body } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "cancel_invocation", invokeId: "not-real" }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, cancelled: false });
  });

  it("starts and stops the viewport stream", async () => {
    const started = await openSession(provider);
    const session = provider.sessions[0];

    expect(
      await call(
        `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
        json({ type: "set_screencast", enabled: true }),
      ),
    ).toEqual({ status: 200, body: { ok: true, streaming: true } });
    expect(
      await call(
        `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
        json({ type: "set_screencast", enabled: false }),
      ),
    ).toEqual({ status: 200, body: { ok: true, streaming: false } });

    expect(session.screencastCalls).toEqual([true, false]);
  });

  it("says 200 with streaming:false when the browser cannot screencast", async () => {
    const started = await openSession(provider);
    provider.sessions[0].screencastAvailable = false;

    const { status, body } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "set_screencast", enabled: true }),
    );
    // The REQUEST was fine, so not an error — but the client has to be able to
    // tell "streaming" from "understood", or it waits forever for frames that
    // are never coming instead of falling back to polling.
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, streaming: false });
  });

  it("rejects a set_screencast with no enabled flag", async () => {
    const started = await openSession(provider);
    // `enabled` is the whole command. Defaulting it either way would make a
    // malformed client silently start or stop a stream it did not ask about.
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "set_screencast" }),
    );
    expect(status).toBe(400);
  });

  it("rejects a command this server does not know", async () => {
    const started = await openSession(provider);
    // The contract a NEWER client depends on: an unknown command is a 400, not
    // a 500 and not a silent success. That is what lets the client tell "this
    // server is older than me" from "something broke" and fall back to polling
    // screenshots instead of showing an empty pane.
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "set_something_invented_later", enabled: true }),
    );
    expect(status).toBe(400);
  });

  it("forwards a batch of input in order", async () => {
    const started = await openSession(provider);
    const session = provider.sessions[0];

    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({
        type: "input",
        events: [
          { kind: "mouse_move", x: 10, y: 20 },
          { kind: "mouse_down", x: 10, y: 20, button: "left" },
          { kind: "mouse_up", x: 10, y: 20, button: "left" },
        ],
      }),
    );

    expect(status).toBe(200);
    // Ordering within a batch is what makes this a click rather than three
    // unrelated events.
    expect(session.inputBatches).toHaveLength(1);
    expect(session.inputBatches[0].map((event) => event.kind)).toEqual([
      "mouse_move",
      "mouse_down",
      "mouse_up",
    ]);
  });

  it("refuses an input batch beyond the cap", async () => {
    const started = await openSession(provider);
    const events = Array.from({ length: 65 }, () => ({
      kind: "mouse_move",
      x: 1,
      y: 1,
    }));
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "input", events }),
    );
    // One request can never carry an unbounded amount of browser work.
    expect(status).toBe(400);
    expect(provider.sessions[0].inputBatches).toHaveLength(0);
  });

  it("refuses an empty input batch", async () => {
    const started = await openSession(provider);
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "input", events: [] }),
    );
    expect(status).toBe(400);
  });

  it.each([
    ["negative", { kind: "mouse_move", x: -1, y: 10 }],
    ["null (a NaN that survived JSON)", { kind: "mouse_move", x: null, y: 10 }],
    ["unknown button", { kind: "mouse_down", x: 1, y: 1, button: "extra" }],
    ["unknown kind", { kind: "teleport", x: 1, y: 1 }],
    ["empty key", { kind: "key_down", key: "" }],
  ])(
    "refuses an input event with a %s coordinate or field",
    async (_l, event) => {
      const started = await openSession(provider);
      const { status } = await call(
        `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
        json({ type: "input", events: [event] }),
      );
      expect(status).toBe(400);
      expect(provider.sessions[0].inputBatches).toHaveLength(0);
    },
  );

  it("accepts a signed wheel delta", async () => {
    const started = await openSession(provider);
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({
        type: "input",
        events: [{ kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: -120 }],
      }),
    );
    // Scrolling up is a negative number, not an error.
    expect(status).toBe(200);
  });

  it("rejects an in-app hosted session rather than downgrading it", async () => {
    configState.hostedBrowser = true;
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({
        url: "https://a.test/",
        transport: "hosted",
        projectId: "proj-1",
        display: "in-app",
      }),
    );
    // A hosted browser already has a viewport with its own take-control lease.
    // Honouring `in-app` would drive one desktop from two places.
    expect(status).toBe(400);
    expect(body.code).toBe("in-app-hosted-unsupported");
    configState.hostedBrowser = false;
  });

  it("bounds the device pixel ratio it will render at", async () => {
    for (const devicePixelRatio of [0.5, 3, 0]) {
      const { status } = await call(
        "/api/mcp/webmcp/sessions",
        json({ url: "https://a.test/", devicePixelRatio }),
      );
      // Below 1 is a client asking for a picture smaller than the page, and
      // above 2 is bytes growing faster than anyone can see. Both are refused
      // at the boundary rather than clamped silently.
      expect(status, `devicePixelRatio ${devicePixelRatio}`).toBe(400);
    }
  });

  it("accepts the ratios a real display reports", async () => {
    // Filling the registry first is what makes this land without launching a
    // browser: `reserve()` runs after the schema, so a 429 proves the request
    // got past validation — which is the half under test here. The forwarding
    // half is asserted against a fake provider in session-registry.test.ts.
    await openSession(new FakeProvider());
    await openSession(new FakeProvider());
    for (const devicePixelRatio of [1, 1.5, 2]) {
      const { status, body } = await call(
        "/api/mcp/webmcp/sessions",
        json({ url: "https://a.test/", display: "in-app", devicePixelRatio }),
      );
      expect(status, `devicePixelRatio ${devicePixelRatio}`).toBe(429);
      expect(body.code).toBe("capacity");
    }
  });

  it("rejects a display this server does not know", async () => {
    const { status } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", display: "hologram" }),
    );
    expect(status).toBe(400);
  });

  it("rejects a malformed command", async () => {
    const started = await openSession(provider);
    const { status } = await call(
      `/api/mcp/webmcp/sessions/${started.sessionId}/command`,
      json({ type: "teleport" }),
    );
    expect(status).toBe(400);
  });

  it("429s when the browser cap is reached", async () => {
    // Fill the shared registry to its real cap of 2.
    await openSession(provider);
    await openSession(provider);
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://third.test/" }),
    );
    expect(status).toBe(429);
    expect(body.code).toBe("capacity");
  });

  it("closes a session, and says so when there was nothing to close", async () => {
    const started = await openSession(provider);
    expect(
      (
        await call(`/api/mcp/webmcp/sessions/${started.sessionId}`, {
          method: "DELETE",
        })
      ).body,
    ).toEqual({ closed: true });
    expect(
      (
        await call(`/api/mcp/webmcp/sessions/${started.sessionId}`, {
          method: "DELETE",
        })
      ).body,
    ).toEqual({ closed: false });
  });

  it("streams replayed then live events over SSE", async () => {
    const started = await openSession(provider);
    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
    ]);

    const res = await app.request(
      `http://local/api/mcp/webmcp/sessions/${started.sessionId}/events?replay=50`,
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readUntil = async (predicate: (text: string) => boolean) => {
      for (let i = 0; i < 20 && !predicate(buffered); i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
      return buffered;
    };

    // Replay carries the history that happened before this client connected.
    await readUntil((text) => text.includes("https://example.test::echo"));
    expect(buffered).toContain("session_started");
    expect(buffered).toContain("https://example.test::echo");
    // The replayed session event carries real deadlines, not the zeros the
    // runtime had before the registry adopted it.
    expect(buffered).not.toContain('"expiresAt":0');

    // ...and the stream stays live afterwards.
    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
      fakeTool({ origin: "https://example.test", name: "later" }),
    ]);
    await readUntil((text) => text.includes("later"));
    expect(buffered).toContain("later");
    await reader.cancel();
  });

  /**
   * Read an SSE body until it goes quiet.
   *
   * Draining to quiet rather than stopping at the first interesting token,
   * because a frame does NOT arrive in seq order here: the route holds a
   * frame offered to a full queue in its one-slot `pendingFrame` and flushes
   * it from `pull`, so it lands after everything ahead of it. A reader that
   * stopped early would report "no frames" for a stream that was about to
   * deliver one — which is a green test for a broken filter.
   */
  async function drainSse(res: Response, quietMs = 80): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (let i = 0; i < 50; i += 1) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), quietMs),
          ),
        ]);
        if (!chunk || chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return buffered;
  }

  it("suppresses frames — live and replayed — for frames=off", async () => {
    const started = await openSession(provider);
    // Published BEFORE the connect, so this covers the REPLAYED path too: the
    // retained frame is delivered through the same `send` closure, and a
    // client on the binary socket would otherwise pay the base64-in-JSON tax
    // once per connect.
    provider.sessions[0].emitFrame({ data: "cmVwbGF5ZWQ=" });
    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
    ]);

    const res = await app.request(
      `http://local/api/mcp/webmcp/sessions/${started.sessionId}/events?replay=50&frames=off`,
    );
    // A live frame too, offered while the consumer is still draining.
    provider.sessions[0].emitFrame({ data: "bGl2ZQ==" });
    provider.sessions[0].emitTools([
      fakeTool({ origin: "https://example.test" }),
      fakeTool({ origin: "https://example.test", name: "later" }),
    ]);

    const buffered = await drainSse(res);
    // Everything else still flows: only the pixels move to the other socket.
    expect(buffered).toContain("session_started");
    expect(buffered).toContain("https://example.test::echo");
    expect(buffered).toContain("later");
    expect(buffered).not.toContain('"type":"frame"');
    expect(buffered).not.toContain("cmVwbGF5ZWQ=");
    expect(buffered).not.toContain("bGl2ZQ==");
  });

  it("still sends frames with no param, and with frames=on", async () => {
    // The old-client guard. A client that has never heard of this parameter —
    // every client older than the WebSocket — must get exactly today's stream.
    for (const query of [
      "replay=50",
      "replay=50&frames=on",
      // Only the exact string `off` suppresses. An empty or null-like value is
      // what a client building the query from an unset variable sends, and
      // treating it as "off" would blank the pane of a client that never opted
      // in to the socket.
      "replay=50&frames=",
      "replay=50&frames=null",
      "replay=50&frames=OFF",
    ]) {
      const started = await openSession(provider);
      const session = provider.sessions[provider.sessions.length - 1];
      session.emitFrame({ data: "cGFpbnQ=" });

      const res = await app.request(
        `http://local/api/mcp/webmcp/sessions/${started.sessionId}/events?${query}`,
      );
      const buffered = await drainSse(res);
      expect(buffered, query).toContain('"type":"frame"');
      expect(buffered, query).toContain("cGFpbnQ=");
      await webMcpSessions.close(started.sessionId);
    }
  });

  it("tells an SSE client the session is gone instead of hanging", async () => {
    const res = await app.request(
      "http://local/api/mcp/webmcp/sessions/does-not-exist/events",
    );
    const text = await new Response(res.body).text();
    expect(text).toContain("session_gone");
  });
});

/**
 * The W5 transport switch. `browserd-provider.ts` shipped tested but
 * unreferenced — nothing selected it, so every session ran locally no matter
 * what. These cover the selection itself, and the three refusals that guard
 * it: a hosted session spends someone's credits, so it must never be the
 * thing that happens by accident.
 */
describe("POST /sessions — transport selection", () => {
  beforeEach(() => {
    configState.hostedBrowser = false;
    hostedState.ensureArgs.length = 0;
  });

  it("refuses hosted while the hosted runtime is off", async () => {
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test", transport: "hosted", projectId: "p1" }),
    );
    expect(status).toBe(503);
    expect(body.code).toBe("hosted-browser-disabled");
    // Nothing was reserved: the refusal happens before any seam is touched.
    expect(hostedState.ensureArgs).toHaveLength(0);
  });

  it("refuses hosted with no project — there is no computer to run on", async () => {
    configState.hostedBrowser = true;
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test", transport: "hosted" }),
    );
    expect(status).toBe(400);
    expect(body.code).toBe("hosted-project-required");
    expect(hostedState.ensureArgs).toHaveLength(0);
  });

  it("refuses hosted with no Authorization — the computer is billed to someone", async () => {
    configState.hostedBrowser = true;
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test", transport: "hosted", projectId: "p1" }),
    );
    expect(status).toBe(401);
    expect(body.code).toBe("hosted-auth-required");
    expect(hostedState.ensureArgs).toHaveLength(0);
  });

  it("selects the hosted provider and passes the caller's identity through", async () => {
    configState.hostedBrowser = true;
    const { status } = await call("/api/mcp/webmcp/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        url: "https://a.test",
        transport: "hosted",
        projectId: "p1",
      }),
    });

    // The mocked seam rejects, so the request fails — but reaching it at all
    // is the proof the hosted provider was selected rather than the local one
    // (which would have tried to launch Chromium).
    expect(status).toBe(500);
    expect(hostedState.ensureArgs).toHaveLength(1);
    expect(hostedState.ensureArgs[0]).toMatchObject({
      bearer: "Bearer user-token",
      projectId: "p1",
      // A person driving their own page gets the persistent profile; an eval
      // would get `ephemeral`. Handing the wrong one over is a silent
      // correctness failure in either direction.
      contextMode: "persistent",
    });
  });

  it("leaves the LOCAL path untouched — an omitted transport reserves nothing", async () => {
    configState.hostedBrowser = true;
    // Invalid URL so the request stops at validation without launching a real
    // browser; the point is that the hosted seam is never consulted.
    const { status } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "file:///etc/passwd" }),
    );
    expect(status).toBe(400);
    expect(hostedState.ensureArgs).toHaveLength(0);
  });
});

describe("POST /sessions — the embedded surface", () => {
  const saved = process.env.ELECTRON_APP;

  beforeEach(async () => {
    webviewState.factoryArgs.length = 0;
    delete process.env.ELECTRON_APP;
    await webMcpSessions.disposeAll();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ELECTRON_APP;
    else process.env.ELECTRON_APP = saved;
  });

  it("refuses a webContentsId outside the desktop app", async () => {
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", display: "in-app", webContentsId: 7 }),
    );
    // There is no `webContents` to resolve outside Electron, and a server that
    // tried would fail with an unresolved-module stack instead of a sentence.
    expect(status).toBe(400);
    expect(body.code).toBe("electron-only");
    expect(webviewState.factoryArgs).toHaveLength(0);
  });

  it("refuses a surface asked to be a window", async () => {
    process.env.ELECTRON_APP = "true";
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", display: "window", webContentsId: 7 }),
    );
    // A surface the client mounted IS the in-app view. Honouring `window`
    // would report a transport whose pane the client is not rendering.
    expect(status).toBe(400);
    expect(body.code).toBe("webview-display-mismatch");
    expect(webviewState.factoryArgs).toHaveLength(0);
  });

  it("refuses a surface with no display at all — the wire default is `window`", async () => {
    process.env.ELECTRON_APP = "true";
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", webContentsId: 7 }),
    );
    expect(status).toBe(400);
    expect(body.code).toBe("webview-display-mismatch");
  });

  it.each([
    ["a non-integer", 1.5],
    ["zero", 0],
    ["a negative", -3],
    ["a string", "7"],
  ])("rejects %s webContentsId at the boundary", async (_label, id) => {
    process.env.ELECTRON_APP = "true";
    const { status } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", display: "in-app", webContentsId: id }),
    );
    expect(status).toBe(400);
    expect(webviewState.factoryArgs).toHaveLength(0);
  });

  it("selects the embedded provider and hands it the id", async () => {
    process.env.ELECTRON_APP = "true";
    const { status } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", display: "in-app", webContentsId: 7 }),
    );
    // The mocked factory's session rejects, so the request fails — reaching it
    // at all is the proof the embedded provider was selected rather than the
    // local one, which would have tried to launch Chromium.
    expect(status).toBe(500);
    expect(webviewState.factoryArgs).toEqual([{ webContentsId: 7 }]);
  });

  it("leaves an ordinary in-app session on the local provider", async () => {
    process.env.ELECTRON_APP = "true";
    // A VALID url, so the request actually reaches transport selection. With an
    // invalid one the route stops at schema validation and "the factory was not
    // called" would be true whatever the selection did — a test that passes for
    // a reason unrelated to what it claims.
    //
    // Filling the registry to its cap first is what makes the assertion land
    // without launching Chromium: `reserve()` runs INSIDE `startWebMcpSession`,
    // i.e. AFTER the provider has been chosen, so a 429 proves selection ran
    // and did not choose the embedded provider.
    await openSession(new FakeProvider());
    await openSession(new FakeProvider());
    const { status, body } = await call(
      "/api/mcp/webmcp/sessions",
      json({ url: "https://a.test/", display: "in-app" }),
    );
    expect(status).toBe(429);
    expect(body.code).toBe("capacity");
    // The compatibility path: a client too old to send a surface, or one
    // running in a browser, still takes the local provider and gets
    // frame-stream.
    expect(webviewState.factoryArgs).toHaveLength(0);
  });
});
