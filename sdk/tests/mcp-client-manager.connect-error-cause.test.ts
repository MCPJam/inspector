import { createServer, type Server } from "node:http";

import { MCPClientManager } from "../src/mcp-client-manager";
import { describeError, extractNodeErrno } from "../src/error-describer";

// What a refused HTTP connect used to classify as, and why it mattered:
// undici reports the failure as `TypeError: fetch failed` and appends the real
// reason ("... connect ECONNREFUSED 127.0.0.1:9999"). The manager's rethrow
// dropped `cause`, and the describer matched `fetch failed` before looking for
// the errno, so a refused port surfaced as the generic `transport/fetch_failed`
// ("we could not reach it") instead of `transport/econnrefused` ("nothing is
// listening on that host and port") — the only half a user can act on.
describe("HTTP connect failures keep their provenance", () => {
  let deadUrl: string;

  // Bind a real server to get a port the OS just confirmed is ours, then close
  // it. Connecting to that port is a deterministic ECONNREFUSED, without
  // gambling on which ports happen to be free on the host.
  beforeAll(async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected an AddressInfo from the test server");
    }
    deadUrl = `http://127.0.0.1:${address.port}/mcp`;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function captureConnectError(
    serverId: string,
    config: Record<string, unknown>,
  ): Promise<unknown> {
    const manager = new MCPClientManager({});
    try {
      await manager.connectToServer(serverId, config as never);
      throw new Error("expected the connect to reject");
    } finally {
      await manager.disconnectAllServers();
    }
  }

  it("classifies a refused Streamable-HTTP+SSE connect as transport/econnrefused", async () => {
    const error = await captureConnectError("dead", { url: deadUrl }).catch(
      (e) => e,
    );

    expect(describeError(error).slug).toBe("transport/econnrefused");
  }, 20000);

  it("preserves both transport failures on the combined connect error", async () => {
    const error = (await captureConnectError("dead-both", {
      url: deadUrl,
    }).catch((e) => e)) as Error & { streamableCause?: unknown };

    expect(error.cause).toBeDefined();
    expect(error.streamableCause).toBeDefined();
    // Non-enumerable: it must not widen a log line or JSON.stringify output.
    expect(Object.keys(error)).not.toContain("streamableCause");
  }, 20000);

  it("preserves the cause on the declared-transport connect error", async () => {
    // `disableSseFallback` rethrows from its own branch — a second throw site
    // that has to carry the cause too.
    //
    // Documented limit: this path CANNOT reach `transport/econnrefused`. The
    // upstream era-negotiation probe (@modelcontextprotocol/client) wraps the
    // failure in an `SdkError` that neither keeps undici's `cause` nor repeats
    // the errno in its message, so the errno is destroyed before MCPJam sees
    // it. `transport/fetch_failed` is the honest answer here; recovering more
    // requires an upstream change.
    const error = (await captureConnectError("dead-declared", {
      url: deadUrl,
      disableSseFallback: true,
    }).catch((e) => e)) as Error;

    expect(error.cause).toBeDefined();
    expect(describeError(error).slug).toBe("transport/fetch_failed");
  }, 20000);
});

describe("mixed auth and transport failure", () => {
  let server: Server;
  let url: string;

  // Streamable HTTP (POST) answers 401 while SSE (GET) fails for an unrelated
  // reason. The auth challenge that triggers the MCPAuthError therefore lives
  // ONLY on the Streamable error — `cause` holds the SSE failure.
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("sse exploded");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected an AddressInfo from the test server");
    }
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("keeps the Streamable HTTP auth failure reachable on the auth error", async () => {
    const manager = new MCPClientManager({});
    let captured: unknown;
    try {
      await manager.connectToServer("mixed", { url } as never);
    } catch (error) {
      captured = error;
    } finally {
      await manager.disconnectAllServers();
    }

    const error = captured as Error & {
      streamableCause?: unknown;
      statusCode?: number;
    };
    // Pin the branch: this must be the auth throw, not the combined transport
    // throw below it, or the assertion proves nothing.
    expect(error.name).toBe("MCPAuthError");
    expect(error.statusCode).toBe(401);
    // Without this the 401 is unrecoverable: `cause` is the SSE 500.
    expect(error.streamableCause).toBeDefined();
    expect(Object.keys(error)).not.toContain("streamableCause");
  }, 20000);
});

describe("extractNodeErrno — wrapper codes must not shadow the real errno", () => {
  it("walks past an E-prefixed wrapper code that merely looks like an errno", () => {
    // `EWRAPPER` has the shape of a Node errno without being one. Recognition
    // by pattern would end the walk here and lose the errno below.
    const systemError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const wrapper = Object.assign(new Error("wrapped"), {
      code: "EWRAPPER",
      cause: systemError,
    });

    expect(extractNodeErrno(wrapper)).toBe("ECONNREFUSED");
    expect(describeError(wrapper).slug).toBe("transport/econnrefused");
  });

  it("walks past an unrecognized string code to the errno below it", () => {
    // Exactly the production shape: the MCP SDK's era-negotiation failure
    // stamps `code: "ERA_NEGOTIATION_FAILED"` on the outside of the chain.
    const systemError = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:9999"),
      { code: "ECONNREFUSED" },
    );
    const wrapper = Object.assign(new Error("Version negotiation failed"), {
      code: "ERA_NEGOTIATION_FAILED",
      cause: systemError,
    });

    expect(extractNodeErrno(wrapper)).toBe("ECONNREFUSED");
    expect(describeError(wrapper).slug).toBe("transport/econnrefused");
  });

  it("still returns an unrecognized code when the chain holds no errno", () => {
    const wrapper = Object.assign(new Error("Version negotiation failed"), {
      code: "ERA_NEGOTIATION_FAILED",
    });

    expect(extractNodeErrno(wrapper)).toBe("ERA_NEGOTIATION_FAILED");
  });
});

describe("errno recovered from message text", () => {
  it("checks every errno-shaped token, not just the first", () => {
    // The first token here maps to nothing. Stopping at it would fall through
    // to the generic `fetch failed` slug and discard the ECONNREFUSED that
    // says what actually happened.
    const error = new Error(
      "SSE ERROR: TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
    );

    expect(describeError(error).slug).toBe("transport/econnrefused");
  });

  it("still reports fetch_failed when no errno is present anywhere", () => {
    const error = new Error("TypeError: fetch failed");

    expect(describeError(error).slug).toBe("transport/fetch_failed");
  });
});
