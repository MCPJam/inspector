/**
 * The hosted browser's frame socket.
 *
 * What these hold in place: the socket is reachable only with a valid browser
 * token whose claims still match the row's live owner; the daemon-side holder
 * is the VERIFIED user and never anything the client sent; a lease refusal
 * closes with its own retryable code rather than looking like an error; and a
 * watching pane keeps the box awake, since it issues no commands to do it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createComputerBrowserFramesWsHandler,
  resetBrowserFramesForTests,
  shutdownBrowserFrameSockets,
  type BrowserFramesDeps,
} from "../computer-browser-frames";

const CLAIMS = {
  userId: "users_1",
  computerId: "computers_1",
  projectId: "projects_1",
};

const SESSION = {
  sessionId: "sessions_1",
  computerId: "computers_1",
  bootId: "boot-1",
  browserdToken: "daemon-secret",
  browserdPort: 8791,
  publicOrigin: "https://box-8791.e2b.dev",
  streamUrl: "https://box-6080.e2b.dev/vnc.html",
  streamPassword: "pw",
  bundleHash: "hash-1",
  contextMode: "persistent" as const,
};

/** A `WSContext` double that records what the route did to the socket. */
function fakeSocket() {
  return {
    sent: [] as string[],
    closed: undefined as { code: number; reason: string } | undefined,
    send(data: string) {
      this.sent.push(data);
    },
    close(code: number, reason: string) {
      this.closed ??= { code, reason };
    },
  };
}

type Upstream = NonNullable<BrowserFramesDeps["openUpstream"]>;

function build(over: Partial<BrowserFramesDeps> = {}) {
  const upstreamCalls: Parameters<Upstream>[0][] = [];
  const touchSession = vi.fn(async () => ({ counted: true }));
  const touchActivity = vi.fn(async () => {});

  // Captures the handlers the route hands back, so a test can drive the socket
  // lifecycle without a real upgrade.
  let events: Record<string, (...args: never[]) => unknown> = {};
  const upgradeWebSocket = ((createEvents: (c: unknown) => Promise<unknown>) => {
    return async (c: unknown) => {
      events = (await createEvents(c)) as typeof events;
      return events;
    };
  }) as never;

  const handler = createComputerBrowserFramesWsHandler(upgradeWebSocket, {
    configured: () => true,
    verifyToken: (async (token: string) =>
      token === "tok" ? CLAIMS : null) as BrowserFramesDeps["verifyToken"],
    sandboxInfo: (async () => ({
      ok: true,
      value: {
        ownerUserId: CLAIMS.userId,
        projectId: CLAIMS.projectId,
        providerComputerId: "sbx_1",
      },
    })) as unknown as BrowserFramesDeps["sandboxInfo"],
    lookupSession: (async () => ({
      reachable: true,
      session: SESSION,
    })) as unknown as BrowserFramesDeps["lookupSession"],
    touchSession: touchSession as unknown as BrowserFramesDeps["touchSession"],
    touchActivity:
      touchActivity as unknown as BrowserFramesDeps["touchActivity"],
    bundleHash: () => "hash-1",
    openUpstream: (async (args) => {
      upstreamCalls.push(args);
      return { ok: true };
    }) as Upstream,
    ...over,
  });

  /** Run the pre-upgrade resolution and open the socket. */
  async function connect(token: string | null = "tok", query = "") {
    const ctx = {
      req: {
        header: (name: string) =>
          name.toLowerCase() === "sec-websocket-protocol" && token
            ? token
            : undefined,
        query: (name: string) =>
          new URLSearchParams(query).get(name) ?? undefined,
      },
    };
    await (handler as unknown as (c: unknown) => Promise<unknown>)(ctx);
    const ws = fakeSocket();
    await (events.onOpen as unknown as (e: unknown, w: unknown) => Promise<void>)(
      {},
      ws,
    );
    return { ws, events };
  }

  return { connect, upstreamCalls, touchSession, touchActivity };
}

beforeEach(() => {
  resetBrowserFramesForTests();
  vi.useRealTimers();
});

describe("browser frames socket — who may watch", () => {
  it("closes 4401 without a token, and never opens an upstream", async () => {
    const f = build();
    const { ws } = await f.connect(null);
    expect(ws.closed?.code).toBe(4401);
    expect(f.upstreamCalls).toHaveLength(0);
  });

  it("closes 4401 when the row's owner no longer matches the token", async () => {
    // The mint authorized this about a minute ago; ownership can move inside
    // that window, and the socket shows a live screen.
    const f = build({
      sandboxInfo: (async () => ({
        ok: true,
        value: {
          ownerUserId: "users_someone_else",
          projectId: CLAIMS.projectId,
          providerComputerId: "sbx_1",
        },
      })) as unknown as BrowserFramesDeps["sandboxInfo"],
    });
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4401);
    expect(f.upstreamCalls).toHaveLength(0);
  });

  it("closes 4404 when no browser is running on that computer", async () => {
    const f = build({
      lookupSession: (async () => ({
        reachable: true,
        session: null,
      })) as unknown as BrowserFramesDeps["lookupSession"],
    });
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4404);
  });

  it("asks the daemon on behalf of the VERIFIED user, not the caller", async () => {
    // The daemon lets a subscriber through when `holder === lease.holder`. A
    // holder taken from the client would let anyone who echoed the right id
    // watch somebody else's HELD session — a password field mid-typing.
    const f = build();
    await f.connect("tok", "holder=users_victim&tabId=tab-9");
    expect(f.upstreamCalls[0]).toMatchObject({
      holder: CLAIMS.userId,
      tabId: "tab-9",
    });
    expect(f.upstreamCalls[0].holder).not.toBe("users_victim");
  });
});

describe("browser frames socket — carrying frames", () => {
  it("relays a frame in the envelope the local pane already reads", async () => {
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onFrame({
      data: "AAAA",
      deviceWidth: 1024,
      deviceHeight: 768,
      scale: 1,
      ts: 5,
      seq: 3,
    });
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "frame",
      frame: {
        data: "AAAA",
        deviceWidth: 1024,
        deviceHeight: 768,
        scale: 1,
        ts: 5,
        seq: 3,
      },
    });
  });

  it("closes 4409 — retryable — when the lease moves", async () => {
    // Its own code because it is TEMPORARY: a pane should hold its place and
    // come back, not show the person an error about a browser that is fine.
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onEnd("lease_held");
    expect(ws.closed).toMatchObject({ code: 4409, reason: "lease_held" });
  });

  it("closes 4404 for a tab that went away", async () => {
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onEnd("tab_gone");
    expect(ws.closed?.code).toBe(4404);
  });

  it("treats an UNEXPLAINED end as a drop, not as a refusal", async () => {
    // `undefined` means the daemon never said why — a dropped link rather than
    // a decision, and the pane should reconnect rather than stand down.
    const f = build();
    const { ws } = await f.connect();
    f.upstreamCalls[0].onEnd(undefined);
    expect(ws.closed?.code).toBe(4503);
  });

  it("closes when the upstream refuses to start", async () => {
    const f = build({
      openUpstream: (async () => ({
        ok: false as const,
        status: 404,
        error: "http_404",
      })) as Upstream,
    });
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4404);
  });
});

describe("browser frames socket — keeping the box awake", () => {
  it("touches the session and the computer as soon as somebody watches", async () => {
    // A watching pane issues no COMMANDS, so nothing else defers the idle
    // sweep — and the browser would be reaped out from under the person
    // looking at it.
    const f = build();
    await f.connect();
    expect(f.touchSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION.sessionId, kind: "panel" }),
    );
    expect(f.touchActivity).toHaveBeenCalledWith({
      computerId: SESSION.computerId,
    });
  });

  it("stops touching once the socket is gone", async () => {
    vi.useFakeTimers();
    const f = build();
    const { events } = await f.connect();
    f.touchSession.mockClear();
    (events.onClose as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.touchSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("hangs up the daemon stream when the pane closes", async () => {
    // Otherwise the screencast and its encoder keep running on a box the agent
    // is still using, for a pane nobody has open.
    const f = build();
    const { events } = await f.connect();
    const { signal } = f.upstreamCalls[0];
    expect(signal.aborted).toBe(false);
    (events.onClose as unknown as () => void)();
    expect(signal.aborted).toBe(true);
  });

  it("refuses new sockets once the server is shutting down", async () => {
    shutdownBrowserFrameSockets();
    const f = build();
    const { ws } = await f.connect();
    expect(ws.closed?.code).toBe(4503);
    expect(f.upstreamCalls).toHaveLength(0);
  });
});
