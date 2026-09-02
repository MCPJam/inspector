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

describe("browser stream — the lease is enforced here or nowhere", () => {
  /** A pointer event: the thing a watching viewer must not be able to send. */
  const POINTER = Buffer.concat([Buffer.from([5, 1]), Buffer.alloc(4)]);
  /** A framebuffer request: watching, always fine. */
  const WATCH = Buffer.concat([Buffer.from([3, 1]), Buffer.alloc(8)]);

  it("drops input from a viewer who does not hold the lease", async () => {
    // The threat is not a misbehaving UI: it is a raw RFB client pointed at
    // this socket with a valid panel token. `view_only` is a client-side flag
    // and cannot be relied on for anything.
    const { events, upstream, client } = await connected({
      leaseHolder: async () => null,
    });
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before);
  });

  it("passes input once the lease is held by THIS viewer", async () => {
    const { events, upstream, client } = await connected({
      leaseHolder: async () => CLAIMS.userId,
    });
    await new Promise((r) => setTimeout(r, 0));
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before + 1);
    expect(upstream.sent.at(-1)).toEqual(POINTER);
  });

  it("drops input while SOMEONE ELSE holds the lease", async () => {
    const { events, upstream, client } = await connected({
      leaseHolder: async () => "another_user",
    });
    await new Promise((r) => setTimeout(r, 0));
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before);
  });

  it("fails closed when the lease cannot be read at all", async () => {
    // Not knowing who holds the browser is not a reason to let someone type
    // on it.
    const { events, upstream, client } = await connected({
      leaseHolder: async () => {
        throw new Error("daemon unreachable");
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const before = upstream.sent.length;
    await events().onMessage?.({ data: POINTER }, client.ws);
    expect(upstream.sent.length).toBe(before);
  });

  it("always forwards watching messages, lease or not", async () => {
    const { events, upstream, client } = await connected();
    const before = upstream.sent.length;
    await events().onMessage?.({ data: WATCH }, client.ws);
    expect(upstream.sent.length).toBe(before + 1);
  });

  it("closes a stream it cannot parse rather than forwarding blind", async () => {
    const { events, client } = await connected();
    await events().onMessage?.({ data: Buffer.from([99, 1, 2, 3]) }, client.ws);
    expect(client.closed?.code).toBe(4503);
  });
});
