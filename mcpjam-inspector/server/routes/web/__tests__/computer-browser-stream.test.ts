/**
 * The stream proxy: who may open it, and what they may send through it.
 *
 * The tests that matter are the negative ones. This socket is the only path
 * from a browser to a member's desktop input queue, and the two things
 * protecting it are the token check at the handshake and the message filter
 * afterwards — neither of which the client can be trusted to apply to itself.
 */
import { describe, expect, it } from "vitest";
import {
  createComputerBrowserStreamWsHandler,
  noVncWebSocketUrl,
  type BrowserStreamDeps,
  type UpstreamSocket,
} from "../computer-browser-stream";
import {
  RFB_PROTOCOL_VERSION_3_8,
  RFB_SECURITY,
  vncAuthResponse,
} from "../../../utils/computers/rfb-handshake";

const CLAIMS = {
  userId: "users_1",
  computerId: "computers_1",
  projectId: "projects_1",
};

const SESSION = {
  sessionId: "bs_1",
  computerId: "computers_1",
  bootId: "boot-1",
  browserdToken: "daemon-token",
  browserdPort: 8791,
  publicOrigin: "https://8791-box.e2b.dev",
  streamUrl: "https://6080-box.e2b.dev/vnc.html",
  streamPassword: "s3cret-pw",
  bundleHash: "hash-1",
  contextMode: "persistent" as const,
};

/** A fake upstream we can drive byte by byte. */
function fakeUpstream() {
  const sent: Buffer[] = [];
  const handlers: Record<string, ((arg: never) => void) | undefined> = {};
  const socket: UpstreamSocket = {
    send: (data) => sent.push(Buffer.from(data)),
    close: () => handlers.close?.(undefined as never),
    onMessage: (h) => (handlers.message = h as never),
    onClose: (h) => (handlers.close = h as never),
    onError: (h) => (handlers.error = h as never),
    onOpen: (h) => (handlers.open = h as never),
  };
  return {
    socket,
    sent,
    /** Feed bytes as if the VNC server sent them. */
    deliver: (data: Buffer) =>
      (handlers.message as never as (d: Uint8Array) => void)(data),
    fail: (error: unknown) =>
      (handlers.error as never as (e: unknown) => void)(error),
  };
}

/** Captures what the browser-facing socket received and how it closed. */
function fakeClientSocket() {
  const sent: Buffer[] = [];
  let closed: { code: number; reason: string } | null = null;
  return {
    sent,
    get closed() {
      return closed;
    },
    ws: {
      send: (data: unknown) => sent.push(Buffer.from(data as Uint8Array)),
      close: (code: number, reason: string) => {
        closed ??= { code, reason };
      },
    },
  };
}

function build(overrides: Partial<BrowserStreamDeps> = {}) {
  const upstream = fakeUpstream();
  const deps: BrowserStreamDeps = {
    verifyToken: (async () => CLAIMS) as never,
    sandboxInfo: (async () => ({
      ok: true,
      value: {
        computerId: CLAIMS.computerId,
        providerComputerId: "sbx_1",
        provider: "e2b",
        status: "ready",
        projectId: CLAIMS.projectId,
        ownerUserId: CLAIMS.userId,
      },
    })) as never,
    lookupSession: (async () => ({ session: SESSION })) as never,
    configured: () => true,
    bundleHash: () => "hash-1",
    connectUpstream: () => upstream.socket,
    leaseHolder: async () => null,
    ...overrides,
  };

  /** The handler factory hands its callbacks straight back to us. */
  let events: Record<string, Function> = {};
  const upgrade = ((factory: Function) => async (c: unknown) => {
    events = (await factory(c)) as Record<string, Function>;
  }) as never;

  const handler = createComputerBrowserStreamWsHandler(upgrade, deps);
  const client = fakeClientSocket();

  async function open(protocolHeader = "browser-token") {
    const c = {
      req: {
        header: (name: string) =>
          name === "sec-websocket-protocol" ? protocolHeader : undefined,
      },
    };
    await (handler as unknown as (c: unknown) => Promise<void>)(c);
    await events.onOpen?.({}, client.ws);
    return { client, upstream };
  }

  return { open, client, upstream, events: () => events };
}

/** The server side of a successful RFB 3.8 + VncAuth handshake. */
function serverHandshake(): Buffer[] {
  return [
    Buffer.from(RFB_PROTOCOL_VERSION_3_8, "ascii"),
    Buffer.from([1, RFB_SECURITY.VNC_AUTH]),
    Buffer.alloc(16, 0xab), // challenge
    Buffer.from([0, 0, 0, 0]), // SecurityResult: ok
  ];
}

async function connected(overrides: Partial<BrowserStreamDeps> = {}) {
  const harness = build(overrides);
  const opened = await harness.open();
  for (const chunk of serverHandshake()) opened.upstream.deliver(chunk);
  return { ...harness, ...opened };
}

describe("browser stream — who may open it", () => {
  it("closes 4401 when the token does not verify", async () => {
    const { open, client } = build({
      verifyToken: (async () => null) as never,
    });
    await open();
    expect(client.closed?.code).toBe(4401);
  });

  it("closes 4401 when the row's CURRENT owner is somebody else", async () => {
    // The token is good for ~60s and ownership can change inside it.
    const { open, client } = build({
      sandboxInfo: (async () => ({
        ok: true,
        value: {
          computerId: CLAIMS.computerId,
          providerComputerId: "sbx_1",
          provider: "e2b",
          status: "ready",
          projectId: CLAIMS.projectId,
          ownerUserId: "someone_else",
        },
      })) as never,
    });
    await open();
    expect(client.closed?.code).toBe(4401);
  });

  it("closes 4503 when computers are not configured on this server", async () => {
    const { open, client } = build({ configured: () => false });
    await open();
    expect(client.closed?.code).toBe(4503);
  });

  it("closes 4404 when no browser is running on the computer", async () => {
    const { open, client } = build({
      lookupSession: (async () => ({ session: null })) as never,
    });
    await open();
    expect(client.closed?.code).toBe(4404);
  });
});

describe("browser stream — the password stays on the server", () => {
  it("answers the upstream challenge itself", async () => {
    const { upstream } = await connected();
    const expected = vncAuthResponse(
      Buffer.alloc(16, 0xab),
      SESSION.streamPassword,
    );
    expect(
      upstream.sent.some((chunk) => chunk.equals(expected)),
      "the DES response to the server's challenge",
    ).toBe(true);
  });

  it("offers the browser None, and never sends it a challenge", async () => {
    const { client } = await connected();
    const toBrowser = Buffer.concat(client.sent);
    expect(toBrowser.subarray(0, 12).toString("ascii")).toBe(
      RFB_PROTOCOL_VERSION_3_8,
    );
    // One security type, `None`, then a success result. No challenge, because
    // the browser has no password to answer one with.
    expect(toBrowser.subarray(12, 14)).toEqual(
      Buffer.from([1, RFB_SECURITY.NONE]),
    );
    expect(toBrowser.subarray(14, 18)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(toBrowser.toString("latin1")).not.toContain(SESSION.streamPassword);
  });

  it("gives up rather than continuing when the upstream rejects our credentials", async () => {
    const harness = build();
    const opened = await harness.open();
    opened.upstream.deliver(Buffer.from(RFB_PROTOCOL_VERSION_3_8, "ascii"));
    opened.upstream.deliver(Buffer.from([1, RFB_SECURITY.VNC_AUTH]));
    opened.upstream.deliver(Buffer.alloc(16, 1));
    opened.upstream.deliver(Buffer.from([0, 0, 0, 1])); // failed
    expect(harness.client.closed?.code).toBe(4503);
  });
});

describe("browser stream — the browser's own handshake", () => {
  /** What every RFB client sends back once we offer it version/None/ok. */
  const CLIENT_HANDSHAKE = [
    Buffer.from(RFB_PROTOCOL_VERSION_3_8, "ascii"), // 12 bytes
    Buffer.from([RFB_SECURITY.NONE]), // chosen security type
    Buffer.from([1]), // ClientInit: shared
  ];
  const WATCH = Buffer.concat([Buffer.from([3, 1]), Buffer.alloc(8)]);

  it("consumes the reply instead of reading it as messages", async () => {
    // The bug this pins: fed to the filter, `R` (0x52) is message type 82,
    // which is unknown — so the socket closed on the first thing every real
    // client says, and no test noticed because none drove the client side.
    const { events, client } = await connected();
    for (const chunk of CLIENT_HANDSHAKE) {
      await events().onMessage?.({ data: chunk }, client.ws);
    }
    expect(client.closed).toBeNull();
  });

  it("does not relay the reply upstream", async () => {
    // Our own handshake with the VNC server is already complete, ClientInit
    // included; echoing the browser's would be a second one.
    const { events, client, upstream } = await connected();
    const before = upstream.sent.length;
    for (const chunk of CLIENT_HANDSHAKE) {
      await events().onMessage?.({ data: chunk }, client.ws);
    }
    expect(upstream.sent.length).toBe(before);
  });

  it("forwards the first real message that follows it", async () => {
    const { events, client, upstream } = await connected();
    for (const chunk of CLIENT_HANDSHAKE) {
      await events().onMessage?.({ data: chunk }, client.ws);
    }
    const before = upstream.sent.length;
    await events().onMessage?.({ data: WATCH }, client.ws);
    expect(upstream.sent.length).toBe(before + 1);
    expect(upstream.sent.at(-1)).toEqual(WATCH);
  });

  it("handles a handshake split across frames, with a message trailing it", async () => {
    // websockify relays TCP: the whole reply plus the first request can
    // arrive as one chunk, or dribble in a byte at a time.
    const { events, client, upstream } = await connected();
    const stream = Buffer.concat([...CLIENT_HANDSHAKE, WATCH]);
    for (let i = 0; i < stream.length; i += 5) {
      await events().onMessage?.(
        { data: stream.subarray(i, i + 5) },
        client.ws,
      );
    }
    expect(client.closed).toBeNull();
    expect(upstream.sent.at(-1)).toEqual(WATCH);
  });
});

describe("browser stream — the lease is enforced here or nowhere", () => {
  /** A pointer event: the thing a watching viewer must not be able to send. */
  const POINTER = Buffer.concat([Buffer.from([5, 1]), Buffer.alloc(4)]);
  /** A framebuffer request: watching, always fine. */
  const WATCH = Buffer.concat([Buffer.from([3, 1]), Buffer.alloc(8)]);

  /** Every client must clear its handshake before its messages are parsed. */
  async function past(
    harness: Awaited<ReturnType<typeof connected>>,
  ): Promise<void> {
    for (const chunk of [
      Buffer.from(RFB_PROTOCOL_VERSION_3_8, "ascii"),
      Buffer.from([RFB_SECURITY.NONE]),
      Buffer.from([1]),
    ]) {
      await harness.events().onMessage?.({ data: chunk }, harness.client.ws);
    }
  }

  it("derives the noVNC endpoint, and refuses a host shape it cannot", () => {
    // E2B's `getHost(port)` returns `<port>-<sandbox>.<domain>`, so the
    // daemon's origin already names a port in its hostname and the stream is
    // the same sandbox at 6080.
    expect(noVncWebSocketUrl("https://49983-abc123.e2b.app")).toBe(
      "wss://6080-abc123.e2b.app/websockify",
    );
    // The SDK's debug mode returns `localhost:<port>` instead, where the port
    // is a real URL port rather than part of the hostname.
    expect(noVncWebSocketUrl("http://localhost:49983")).toBe(
      "wss://localhost:6080/websockify",
    );
    // And an unfamiliar shape is a named failure, not a silent no-op. A
    // `replace` that matched nothing dialled the DAEMON's port, where the RFB
    // handshake hangs against an HTTP server until the timeout.
    expect(() => noVncWebSocketUrl("https://box-8791.e2b.dev")).toThrow(
      /cannot derive the noVNC endpoint/,
    );
  });

  it("drops input from a viewer who does not hold the lease", async () => {
    // The threat is not a misbehaving UI: it is a raw RFB client pointed at
    // this socket with a valid panel token. `view_only` is a client-side flag
    // and cannot be relied on for anything.
    const harness = await connected({
      leaseHolder: async () => null,
    });
    await past(harness);
    const { events, upstream, client } = harness;
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before);
  });

  it("passes input once the lease is held by THIS viewer", async () => {
    const harness = await connected({
      leaseHolder: async () => CLAIMS.userId,
    });
    await past(harness);
    const { events, upstream, client } = harness;
    await new Promise((r) => setTimeout(r, 0));
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before + 1);
    expect(upstream.sent.at(-1)).toEqual(POINTER);
  });

  it("drops input while SOMEONE ELSE holds the lease", async () => {
    const harness = await connected({
      leaseHolder: async () => "another_user",
    });
    await past(harness);
    const { events, upstream, client } = harness;
    await new Promise((r) => setTimeout(r, 0));
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before);
  });

  it("fails closed when the lease cannot be read at all", async () => {
    // Not knowing who holds the browser is not a reason to let someone type
    // on it.
    const harness = await connected({
      leaseHolder: async () => {
        throw new Error("daemon unreachable");
      },
    });
    await past(harness);
    const { events, upstream, client } = harness;
    await new Promise((r) => setTimeout(r, 0));
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before);
  });

  it(
    "never lets a stale lease read re-enable input",
    { timeout: 15_000 },
    async () => {
      // The cache window bounds how OFTEN a read starts, not how long one takes.
      // A slow read saying "you hold it" landing after a fast one saying "they
      // took it back" puts a viewer's keyboard on somebody else's desktop until
      // the next tick.
      const gates: Array<(holder: string | null) => void> = [];
      const harness = await connected({
        leaseHolder: () =>
          new Promise<string | null>((resolve) => gates.push(resolve)),
      });
      await past(harness);
      const { events, upstream, client } = harness;

      // Two reads in flight, the second started after the first.
      // The refresh runs on an interval, so a SECOND read starts while the first
      // is still in flight — the overlap this exists to order. Waited out in
      // real time rather than with fake timers: this harness drives real
      // promises through a WebSocket, and swapping the timer source under it
      // would change what is being tested.
      const deadline = Date.now() + 6_000;
      while (gates.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(gates.length).toBeGreaterThanOrEqual(2);

      // The NEWER one answers first: control was handed back.
      gates.at(-1)!(null);
      await new Promise((r) => setTimeout(r, 0));
      // …then the older one arrives claiming this viewer still holds it.
      gates[0]!(CLAIMS.userId);
      await new Promise((r) => setTimeout(r, 0));

      const before = upstream.sent.length;
      await events().onMessage?.({ data: POINTER }, client.ws);
      expect(upstream.sent.length).toBe(before);
    },
  );

  it("always forwards watching messages, lease or not", async () => {
    const harness = await connected();
    await past(harness);
    const { events, upstream, client } = harness;
    const before = upstream.sent.length;
    await events().onMessage?.({ data: WATCH }, client.ws);
    expect(upstream.sent.length).toBe(before + 1);
  });

  it("closes a stream it cannot parse rather than forwarding blind", async () => {
    const harness = await connected();
    await past(harness);
    const { events, client } = harness;
    await events().onMessage?.({ data: Buffer.from([99, 1, 2, 3]) }, client.ws);
    expect(client.closed?.code).toBe(4503);
  });
});
