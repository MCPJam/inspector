/**
 * The store's hosted behaviour: a different base path, a different transport
 * for events, and an invocation identity the CLIENT owns.
 *
 * Its own file because `isHostedMode()` is read once at module load — the mode
 * is a build constant and cannot change under a running tab, so the two modes
 * cannot share a module instance.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => true }));

const fetches = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init?: RequestInit }>,
  /** url → response, consulted in order of insertion. */
  handlers: [] as Array<{
    match: (url: string) => boolean;
    respond: (url: string, init?: RequestInit) => Response;
  }>,
}));

vi.mock("@/lib/session-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session-token")>();
  return {
    ...actual,
    authFetch: vi.fn(async (url: string, init?: RequestInit) => {
      fetches.calls.push({ url, init });
      const handler = fetches.handlers.find((h) => h.match(url));
      if (handler) return handler.respond(url, init);
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  };
});

import { useWebmcpInspectorStore } from "../webmcp-inspector-store";
import type { WebMcpSessionPublic } from "@/shared/webmcp-inspector-protocol";

const SESSION: WebMcpSessionPublic = {
  sessionId: "hosted:proj-1:comp-1",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 0,
  expiresAt: 0,
  hardExpiresAt: 0,
  viewportTransport: { kind: "remote-interactive-url", url: "" },
  protocolVersion: 1,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A never-ending SSE body, so `connect` does not immediately reconnect. */
function openStream(): Response {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  // The stream handles are MODULE state, not store state, so setting the
  // store below does not release them. Without this a stream opened by the
  // previous test stays live and the next `reconnect()` correctly declines to
  // open a second one for the same session id.
  useWebmcpInspectorStore.getState().disconnect();
  fetches.calls.length = 0;
  fetches.handlers.length = 0;
  fetches.handlers.push({
    match: (url) => url.includes("/events"),
    respond: () => openStream(),
  });
  useWebmcpInspectorStore.setState({
    session: undefined,
    tools: [],
    pending: [],
    activity: [],
    error: undefined,
  });
});

describe("hosted store — where it talks", () => {
  it("uses the hosted mount, not the local-only /api/mcp family", async () => {
    // `/api/mcp/*` is 410'd on a hosted replica, so the local base path would
    // fail every call with a message about a feature not being supported.
    await useWebmcpInspectorStore.getState().sendCommand({
      type: "capture_screenshot",
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    await useWebmcpInspectorStore
      .getState()
      .sendCommand({ type: "capture_screenshot" });

    const commandCall = fetches.calls.find((c) => c.url.includes("/command"));
    expect(commandCall?.url).toContain("/api/web/webmcp/");
    expect(commandCall?.url).not.toContain("/api/mcp/");
  });

  it("sends the events stream through authFetch rather than EventSource", async () => {
    // `EventSource` cannot set headers, and hosted auth is a bearer. The
    // local query-string token means nothing here.
    useWebmcpInspectorStore.setState({ session: SESSION });
    // `reconnect()` is the public entry to the stream; `connect` is internal.
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() =>
      expect(fetches.calls.some((c) => c.url.includes("/events"))).toBe(true),
    );
    const stream = fetches.calls.find((c) => c.url.includes("/events"))!;
    expect(stream.url).toContain("/api/web/webmcp/");
    expect(stream.url).not.toContain("token=");
  });

  it("opens ONE stream however many times the surface reconnects", async () => {
    // `reconnect()` runs on every mount and is documented as idempotent for
    // the same session. Its guard used to check only for an `EventSource`,
    // which hosted never creates — so hosted took the teardown-and-rebuild
    // path every time, replaying two hundred events per mount.
    useWebmcpInspectorStore.setState({ session: SESSION });
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() =>
      expect(
        fetches.calls.filter((c) => c.url.includes("/events")),
      ).toHaveLength(1),
    );
    useWebmcpInspectorStore.getState().reconnect();
    useWebmcpInspectorStore.getState().reconnect();
    await Promise.resolve();
    expect(fetches.calls.filter((c) => c.url.includes("/events"))).toHaveLength(
      1,
    );
  });

  it("lets a session be picked back up after the stream gave up", async () => {
    // A 409 means the computer is asleep — recoverable, not gone. The handle
    // is what `connect()` reads to decide whether a stream is already open, so
    // leaving it set after giving up made a dead stream look live forever, and
    // every later reconnect declined to replace it.
    fetches.handlers.unshift({
      match: (url) => url.includes("/events"),
      respond: () =>
        json({ error: "asleep", code: "hosted-desktop-asleep" }, 409),
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() =>
      expect(useWebmcpInspectorStore.getState().error?.code).toBe(
        "hosted-desktop-asleep",
      ),
    );

    // The computer wakes; the next reconnect must actually try again.
    fetches.handlers.shift();
    const before = fetches.calls.filter((c) =>
      c.url.includes("/events"),
    ).length;
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() =>
      expect(
        fetches.calls.filter((c) => c.url.includes("/events")).length,
      ).toBe(before + 1),
    );
  });

  it("stops reading a stream it has replaced", async () => {
    // A reader left running keeps pulling its old response body and applying
    // what it finds — to whatever session took its place.
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    fetches.handlers.unshift({
      match: (url) => url.includes("/events"),
      respond: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => void controllers.push(controller),
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });

    useWebmcpInspectorStore.setState({ session: SESSION });
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() => expect(controllers).toHaveLength(1));

    // The tab moves to another session, then the ABANDONED stream speaks.
    useWebmcpInspectorStore.getState().disconnect();
    const event = {
      type: "activity",
      entry: {
        id: "a1",
        ts: 1,
        kind: "navigated",
        url: "https://evil.test/",
        origin: "https://evil.test",
      },
    };
    controllers[0]!.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWebmcpInspectorStore.getState().activity).toEqual([]);
  });

  it("retries a BODYLESS 5xx rather than treating it as terminal", async () => {
    // A proxy with no upstream and a replica shutting down both answer with a
    // status and nothing else. Requiring a body before retrying excluded
    // exactly those, so the deploy this retry loop exists for killed the
    // stream for the life of the tab.
    let attempts = 0;
    fetches.handlers.unshift({
      match: (url) => url.includes("/events"),
      respond: () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 502 })
          : openStream();
      },
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    useWebmcpInspectorStore.getState().reconnect();

    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1), {
      timeout: 3_000,
    });
    // Retried, not reported: a 5xx is the replica, not the session.
    expect(useWebmcpInspectorStore.getState().error).toBeUndefined();
  });
});

describe("hosted store — replacing a session settles what was waiting on it", () => {
  beforeEach(() => {
    fetches.calls.length = 0;
    fetches.handlers.length = 0;
    useWebmcpInspectorStore.getState().disconnect();
  });

  it("does not leave the old session's caller waiting out the timeout", async () => {
    // `startSession` advanced the generation but settled nothing, so a tool
    // still in flight on the page being replaced parked for the full 90-second
    // invocation timeout — with no page left that could ever answer it.
    fetches.handlers.push(
      {
        // No inline `outcome`, so the caller parks on the settle event.
        match: (url) => url.includes("/command"),
        respond: () => json({ ok: true, invokeId: "inv-parked" }),
      },
      {
        match: (url) => url.includes("/events"),
        respond: () => openStream(),
      },
      {
        match: (url) => url.endsWith("/sessions"),
        respond: () => json({ ...SESSION, sessionId: "hosted:proj-1:comp-2" }),
      },
    );
    useWebmcpInspectorStore.setState({ session: SESSION });
    const parked = useWebmcpInspectorStore
      .getState()
      .invokeToolForResult("origin::pay", {});
    // The caller has to be PARKED ON ITS WAITER before the replacement, not
    // merely to have sent the POST: a replacement landing mid-flight is caught
    // by the generation guard instead, which is a different branch and was
    // never the broken one.
    await vi.waitFor(() =>
      expect(fetches.calls.some((c) => c.url.includes("/command"))).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await useWebmcpInspectorStore
      .getState()
      .startSession("https://other.test/");

    const result = await parked;
    expect(result.state).toBe("failed");
    expect(result.errorMessage).toMatch(/replaced/i);
  });
});

describe("hosted store — one identity per invocation", () => {
  it("mints the invokeId itself and sends it", async () => {
    // A server-issued id cannot survive a retry: the retry would get a new
    // one, and the daemon would run a side-effecting page tool twice.
    fetches.handlers.unshift({
      match: (url) => url.includes("/command"),
      respond: () => json({ ok: true, invokeId: "ignored" }),
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    await useWebmcpInspectorStore
      .getState()
      .invokeTool("origin::pay", { amount: 1 });

    const call = fetches.calls.find((c) => c.url.includes("/command"))!;
    const body = JSON.parse(String(call.init?.body));
    expect(body.invokeId).toEqual(expect.any(String));
    expect(body.invokeId.length).toBeGreaterThan(8);
  });

  it("takes the inline outcome as authoritative", async () => {
    // The event stream carrying the settle may be attached to a different
    // replica than the one that ran the tool, so hosted answers inline.
    fetches.handlers.unshift({
      match: (url) => url.includes("/command"),
      respond: () =>
        json({
          ok: true,
          invokeId: "inv-1",
          outcome: { state: "succeeded", output: { ok: true } },
        }),
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    const result = await useWebmcpInspectorStore
      .getState()
      .invokeToolForResult("origin::pay", {});
    expect(result).toMatchObject({ state: "succeeded" });
  });

  it("surfaces an `unknown` outcome as itself, not as a failure", async () => {
    // It RAN. Reporting "failed" would tell someone their payment did not go
    // through when it may well have.
    fetches.handlers.unshift({
      match: (url) => url.includes("/command"),
      respond: () =>
        json({
          ok: true,
          invokeId: "inv-2",
          outcome: { state: "unknown", error: "outcome not knowable" },
        }),
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    const result = await useWebmcpInspectorStore
      .getState()
      .invokeToolForResult("origin::pay", {});
    expect(result.state).toBe("unknown");
  });

  it("does not hand a closed session's caller an inline outcome", async () => {
    // The inline arm returns BEFORE the generation check further down, so a
    // session torn down while the tool was running would answer its caller
    // with a result from a page that no longer exists — and chat would hand
    // that to the model as the answer.
    fetches.handlers.unshift({
      match: (url) => url.includes("/command"),
      respond: () => {
        // The session goes away while the POST is in flight — the person hit
        // "Close browser", or the stream reported it gone.
        void useWebmcpInspectorStore.getState().closeSession();
        return json({
          ok: true,
          invokeId: "inv-3",
          outcome: { state: "succeeded", output: { charged: true } },
        });
      },
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    const result = await useWebmcpInspectorStore
      .getState()
      .invokeToolForResult("origin::pay", {});
    // `unknown`, not `failed`: it may well have run, and the id is kept so the
    // caller can ask again rather than paying twice to find out.
    expect(result.state).toBe("unknown");
    expect(result.invokeId).toBeDefined();
    expect(result.output).toBeUndefined();
  });

  it("gives two distinct invocations two distinct ids", async () => {
    const seen: string[] = [];
    fetches.handlers.unshift({
      match: (url) => url.includes("/command"),
      respond: (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).invokeId);
        return json({
          ok: true,
          invokeId: "x",
          outcome: { state: "succeeded" },
        });
      },
    });
    useWebmcpInspectorStore.setState({ session: SESSION });
    // Two DISTINCT invocations get distinct ids — the id identifies a call,
    // not a tool.
    await useWebmcpInspectorStore.getState().invokeToolForResult("t", {});
    await useWebmcpInspectorStore.getState().invokeToolForResult("t", {});
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("hosted store — a detached session is not a dead one", () => {
  it("re-fetches the session instead of tearing it down", async () => {
    // `detached` means this replica let go of a browser that is still running
    // on the member's computer, and any replica can pick it up again.
    // Treating it like `closed` would tell someone their live browser had
    // ended and drop a timeline they can still add to.
    let push: ((chunk: string) => void) | undefined;
    fetches.handlers.unshift({
      match: (url) => url.includes("/events"),
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              push = (chunk) => controller.enqueue(encoder.encode(chunk));
            },
          }),
          { status: 200 },
        ),
    });
    fetches.handlers.unshift({
      match: (url) =>
        /\/sessions\/[^/]+(\?|$)/.test(url) && !url.includes("/events"),
      respond: () =>
        json({
          session: { ...SESSION, url: "https://shop.test/cart" },
          tools: [{ toolKey: "origin::checkout", name: "checkout" }],
        }),
    });

    useWebmcpInspectorStore.setState({ session: SESSION });
    // `reconnect()` is the public entry to the stream; `connect` is internal.
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() => expect(push).toBeDefined());

    push!(
      `data: ${JSON.stringify({
        type: "session",
        seq: 9,
        session: { ...SESSION, status: "detached" },
      })}\n\n`,
    );

    await vi.waitFor(() => {
      const state = useWebmcpInspectorStore.getState();
      // Recovered, and NOT reported as an error or cleared away.
      expect(state.session?.status).toBe("ready");
      expect(state.session?.url).toBe("https://shop.test/cart");
      expect(state.tools).toHaveLength(1);
      expect(state.error).toBeUndefined();
    });
  });

  it("reports a refusal when the session cannot be picked back up", async () => {
    // An asleep computer is the interesting one: recoverable, but only by
    // starting it again, which a view must not do on its own.
    let push: ((chunk: string) => void) | undefined;
    fetches.handlers.unshift({
      match: (url) => url.includes("/events"),
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              push = (chunk) => controller.enqueue(encoder.encode(chunk));
            },
          }),
          { status: 200 },
        ),
    });
    fetches.handlers.unshift({
      match: (url) =>
        /\/sessions\/[^/]+(\?|$)/.test(url) && !url.includes("/events"),
      respond: () =>
        json(
          { error: "Your computer is asleep.", code: "hosted-desktop-asleep" },
          409,
        ),
    });

    useWebmcpInspectorStore.setState({ session: SESSION });
    // `reconnect()` is the public entry to the stream; `connect` is internal.
    useWebmcpInspectorStore.getState().reconnect();
    await vi.waitFor(() => expect(push).toBeDefined());

    push!(
      `data: ${JSON.stringify({
        type: "session",
        seq: 9,
        session: { ...SESSION, status: "detached" },
      })}\n\n`,
    );

    await vi.waitFor(() => {
      expect(useWebmcpInspectorStore.getState().error?.code).toBe(
        "hosted-desktop-asleep",
      );
    });
  });
});
