/**
 * Route-level behaviour: status codes, the kill switch, and the SSE stream.
 * The browser is a fake — protocol fidelity is covered against a real Chromium
 * in `services/webmcp-inspector/__tests__/`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const configState = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../../config", () => ({
  get WEBMCP_INSPECTOR_ENABLED() {
    return configState.enabled;
  },
  HOSTED_MODE: false,
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
    expect((await call("/api/mcp/webmcp/sessions", json({ url: "https://a.test" }))).status).toBe(404);
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

  it("404s an unknown session", async () => {
    const { status, body } = await call("/api/mcp/webmcp/sessions/nope");
    expect(status).toBe(404);
    expect(body.code).toBe("session-not-found");
  });

  it("describes a session with its current tools", async () => {
    const started = await openSession(provider);
    provider.sessions[0].emitTools([fakeTool({ origin: "https://example.test" })]);

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
    provider.sessions[0].emitTools([fakeTool({ origin: "https://example.test" })]);

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
      json({ type: "invoke_tool", toolKey: "https://example.test::echo", input: {} }),
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
      (await call(`/api/mcp/webmcp/sessions/${started.sessionId}`, { method: "DELETE" }))
        .body,
    ).toEqual({ closed: true });
    expect(
      (await call(`/api/mcp/webmcp/sessions/${started.sessionId}`, { method: "DELETE" }))
        .body,
    ).toEqual({ closed: false });
  });

  it("streams replayed then live events over SSE", async () => {
    const started = await openSession(provider);
    provider.sessions[0].emitTools([fakeTool({ origin: "https://example.test" })]);

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

  it("tells an SSE client the session is gone instead of hanging", async () => {
    const res = await app.request(
      "http://local/api/mcp/webmcp/sessions/does-not-exist/events",
    );
    const text = await new Response(res.body).text();
    expect(text).toContain("session_gone");
  });
});
