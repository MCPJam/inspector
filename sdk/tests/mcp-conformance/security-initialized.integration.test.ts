/**
 * The valid-host probe finishes the handshake it opens.
 *
 * `localhost-host-valid-accepted` builds its own `initialize` with `node:http`
 * (`fetch` cannot set `Host`), so it is a session the normal client never
 * sees. "After successful initialization, the client MUST send an
 * `initialized` notification": the probe used to read the answer and stop.
 *
 * A real listener is required for the same reason as in
 * `security-origin.integration.test.ts`: there is no fetchFn to stub. The
 * listener records every request, so the assertions are on the wire.
 */

import http from "node:http";
import { runSecurityChecks } from "../../src/mcp-conformance/checks/security.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

interface SeenRequest {
  method: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON body, or undefined when the request had none. */
  body?: Record<string, unknown>;
}

interface FixtureOptions {
  /** Session id to issue on `initialize`. Omit for a stateless server. */
  sessionId?: string;
  /** Version to answer `initialize` with. Defaults to the requested one. */
  answerVersion?: string;
  /**
   * What the 2xx `initialize` answer carries instead of a result: a JSON-RPC
   * error, or a body with no result at all.
   */
  initializeBody?: "error" | "no-result";
  /**
   * Refuse `initialize` with this status. The refusal still carries the
   * session id when one is set, so a DELETE after it would be seen.
   */
  refuseStatus?: number;
  /** Wait this long before answering `initialize`. */
  initializeDelayMs?: number;
  /**
   * Answer `initialize` on an event stream that does not end: the result and
   * then a comment every 50 ms, half a frame and then a dropped connection, or
   * comments and never the result.
   */
  initializeStream?: "result-then-pings" | "cut-mid-body" | "pings-only";
  /** Answer the notification with a stream that is never ended. */
  hangNotification?: boolean;
  /** Never send a status line for the notification or the DELETE. */
  silentFollowUps?: boolean;
  /** Status for the notification. Defaults to 202. */
  notificationStatus?: number;
  /** Address to bind. Defaults to 127.0.0.1. */
  host?: string;
}

async function serve(options: FixtureOptions = {}): Promise<{
  url: string;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}> {
  const seen: SeenRequest[] = [];
  const open = new Set<http.ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      seen.push({ method: req.method ?? "", headers: req.headers, body });

      if (body?.method !== "initialize" && options.silentFollowUps) {
        open.add(res);
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (body?.method === "initialize") {
        const session = options.sessionId
          ? { "Mcp-Session-Id": options.sessionId }
          : {};
        const params = body.params as { protocolVersion: string };
        const result = {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: options.answerVersion ?? params.protocolVersion,
            capabilities: {},
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        };
        const answer = () => {
          if (options.refuseStatus) {
            res.writeHead(options.refuseStatus, {
              "Content-Type": "application/json",
              ...session,
            });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32000, message: "Host not allowed" },
              }),
            );
            return;
          }
          if (options.initializeStream) {
            open.add(res);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              ...session,
            });
            if (options.initializeStream === "cut-mid-body") {
              res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"res');
              const timer = setTimeout(() => res.destroy(), 30);
              timers.add(timer);
              return;
            }
            if (options.initializeStream === "result-then-pings") {
              res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
            }
            const timer = setInterval(() => res.write(": ping\n\n"), 50);
            timers.add(timer);
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json", ...session });
          if (options.initializeBody === "error") {
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32603, message: "initialize handler threw" },
              }),
            );
          } else if (options.initializeBody === "no-result") {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id }));
          } else {
            res.end(JSON.stringify(result));
          }
        };
        if (options.initializeDelayMs) {
          timers.add(setTimeout(answer, options.initializeDelayMs));
        } else {
          answer();
        }
        return;
      }
      if (options.hangNotification) {
        // Headers go out, the body never ends.
        open.add(res);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": waiting\n\n");
        return;
      }
      res.writeHead(options.notificationStatus ?? 202).end();
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to a port");
  }
  const authority = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${authority}:${address.port}/mcp`,
    seen,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of timers) clearTimeout(timer);
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const VALID_HOST = new Set<MCPCheckId>(["localhost-host-valid-accepted"]);
const REBINDING = new Set<MCPCheckId>(["localhost-host-rebinding-rejected"]);

async function run(
  url: string,
  selected: Set<MCPCheckId>,
  protocolVersion?: string,
  checkTimeout = 3_000,
  signal?: AbortSignal,
) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: url,
    ...(protocolVersion ? { protocolVersion } : {}),
    checkTimeout,
    ...(signal ? { signal } : {}),
  });
  return await runSecurityChecks(
    { config, serverUrl: url, fetchFn: config.fetchFn },
    selected,
  );
}

/** `METHOD` for a request with no body, else the JSON-RPC method. */
function wire(seen: SeenRequest[]): string[] {
  return seen.map((request) =>
    request.body ? String(request.body.method) : request.method,
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the valid-host probe finishes its handshake", () => {
  it.each(["2025-03-26", "2025-06-18", "2025-11-25"])(
    "sends initialized and closes the session on %s",
    async (version) => {
      const server = await serve({ sessionId: "session-abc" });
      try {
        const results = await run(server.url, VALID_HOST, version);

        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("passed");
        expect(wire(server.seen)).toEqual([
          "initialize",
          "notifications/initialized",
          "DELETE",
        ]);

        const host = new URL(server.url).host;
        const [, initialized, close] = server.seen;
        // A notification: no id, and nothing but the method.
        expect(initialized.body).toEqual({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        expect(initialized.method).toBe("POST");
        expect(initialized.headers["mcp-session-id"]).toBe("session-abc");
        expect(initialized.headers["mcp-protocol-version"]).toBe(version);
        // Same Host and Origin as the probe, so a server that validates them
        // sees the same client on every request of the session.
        expect(initialized.headers.host).toBe(host);
        expect(initialized.headers.origin).toBe(`http://${host}`);

        expect(close.headers["mcp-session-id"]).toBe("session-abc");
        expect(close.headers["mcp-protocol-version"]).toBe(version);

        expect(results[0].details?.handshake).toEqual({
          initialized: "sent",
          initializedStatus: 202,
          sessionCloseStatus: 200,
        });
      } finally {
        await server.stop();
      }
    },
  );

  it("sends initialized and no DELETE when the server gives no session id", async () => {
    const server = await serve();
    try {
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      expect(results[0].status).toBe("passed");
      expect(wire(server.seen)).toEqual([
        "initialize",
        "notifications/initialized",
      ]);
      expect(server.seen[1].headers["mcp-session-id"]).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("keeps the verdict when the server refuses the notification", async () => {
    const server = await serve({ sessionId: "strict", notificationStatus: 400 });
    try {
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      expect(results[0].status).toBe("passed");
      expect(results[0].details?.handshake).toMatchObject({
        initialized: "sent",
        initializedStatus: 400,
      });
      // The session is still closed.
      expect(wire(server.seen)).toEqual([
        "initialize",
        "notifications/initialized",
        "DELETE",
      ]);
    } finally {
      await server.stop();
    }
  });

  it("does not wait on a notification answer that never ends", async () => {
    const server = await serve({ sessionId: "slow", hangNotification: true });
    try {
      const startedAt = Date.now();
      const results = await run(server.url, VALID_HOST, "2025-11-25", 5_000);

      expect(results[0].status).toBe("passed");
      // Well under the 5 s timeout: the status line is enough.
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(wire(server.seen)).toEqual([
        "initialize",
        "notifications/initialized",
        "DELETE",
      ]);
    } finally {
      await server.stop();
    }
  });
});

describe("answers that do not finish the handshake", () => {
  it.each([
    ["an older version MCPJam supports", "2025-06-18"],
    ["the stateless revision, which has no initialize lifecycle", "2026-07-28"],
    ["a version MCPJam does not support", "2099-01-01"],
  ])(
    "disconnects without initialized when the server answers %s",
    async (_label, answerVersion) => {
      // The run is pinned to one version. A server that answers another does
      // not support the one it was asked for, and MCPJam's pinned client
      // refuses that answer too, so the probe does what it does: it leaves.
      const server = await serve({ sessionId: "other", answerVersion });
      try {
        const results = await run(server.url, VALID_HOST, "2025-11-25");

        // The check is about the Host header, and that was accepted.
        expect(results[0].status).toBe("passed");
        expect(wire(server.seen)).toEqual(["initialize", "DELETE"]);
        // The DELETE carries the version the run asked for, not the answer.
        expect(server.seen[1].headers["mcp-protocol-version"]).toBe(
          "2025-11-25",
        );
        expect(results[0].details?.handshake).toMatchObject({
          initialized: "not sent",
          sessionCloseStatus: 200,
        });
      } finally {
        await server.stop();
      }
    },
  );

  it("still closes the session when the answered version cannot go in a header", async () => {
    // A line break is not a legal header value: putting the server's own
    // answer in `MCP-Protocol-Version` made the DELETE throw before it left.
    const server = await serve({
      sessionId: "bad-version",
      answerVersion: "2025-11-25\n",
    });
    try {
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      expect(wire(server.seen)).toEqual(["initialize", "DELETE"]);
      expect(results[0].details?.handshake).not.toHaveProperty(
        "sessionCloseError",
      );
    } finally {
      await server.stop();
    }
  });

  it("closes the session a 2xx error answer opened, and says what the server did", async () => {
    // The official TS SDK hands out the session id before the server's
    // initialize handler runs, so a handler that throws answers 200 with a
    // session id and a JSON-RPC error. There is a session to close.
    const server = await serve({ sessionId: "errored", initializeBody: "error" });
    try {
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      expect(wire(server.seen)).toEqual(["initialize", "DELETE"]);
      expect(server.seen[1].headers["mcp-session-id"]).toBe("errored");
      // 2xx is a pass for this check, so the note must not contradict it.
      expect(results[0].status).toBe("passed");
      expect(results[0].details?.handshake).toMatchObject({
        initialized: "not sent",
        reason:
          "The server answered initialize with a JSON-RPC error, so the handshake was not finished.",
        sessionCloseStatus: 200,
      });
    } finally {
      await server.stop();
    }
  });

  it("closes the session when the 2xx answer has no result", async () => {
    const server = await serve({
      sessionId: "empty",
      initializeBody: "no-result",
    });
    try {
      await run(server.url, VALID_HOST, "2025-11-25");

      expect(wire(server.seen)).toEqual(["initialize", "DELETE"]);
    } finally {
      await server.stop();
    }
  });

  it("sends nothing after a refusal, even one that carries a session id", async () => {
    // A status outside 2xx fails the check, and it is not an answer that
    // opened anything: no notification and no DELETE.
    const server = await serve({ sessionId: "refused", refuseStatus: 403 });
    try {
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      expect(results[0].status).toBe("failed");
      expect(wire(server.seen)).toEqual(["initialize"]);
      expect(results[0].details?.handshake).toEqual({
        initialized: "not sent",
        reason:
          "The server did not accept initialize, so there was no handshake to finish.",
      });
    } finally {
      await server.stop();
    }
  });

  it("sends nothing more when a 2xx error answer opened no session", async () => {
    const server = await serve({ initializeBody: "error" });
    try {
      await run(server.url, VALID_HOST, "2025-11-25");

      expect(wire(server.seen)).toEqual(["initialize"]);
    } finally {
      await server.stop();
    }
  });
});

describe("a run that is cancelled", () => {
  it("sends nothing after the cancel", async () => {
    // The user stops the run while initialize is in flight. The follow-ups
    // used to go out anyway, to a server the run had already left.
    const server = await serve({
      sessionId: "cancelled",
      initializeDelayMs: 300,
    });
    try {
      const controller = new AbortController();
      const pending = run(
        server.url,
        VALID_HOST,
        "2025-11-25",
        3_000,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 100);

      await expect(pending).rejects.toThrow();
      await pause(600);
      expect(wire(server.seen)).toEqual(["initialize"]);
    } finally {
      await server.stop();
    }
  });
});

describe("a server that never answers the follow-ups", () => {
  it("costs at most 3 s per follow-up, not the whole check timeout", async () => {
    // With no cap, a 10 s check timeout made this run take 20 s.
    const server = await serve({ sessionId: "silent", silentFollowUps: true });
    try {
      const startedAt = Date.now();
      const results = await run(server.url, VALID_HOST, "2025-11-25", 10_000);

      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(results[0].status).toBe("passed");
      expect(results[0].details?.handshake).toMatchObject({
        initialized: "not delivered",
      });
    } finally {
      await server.stop();
    }
  }, 15_000);
});

describe("an initialize answer on a stream that does not end", () => {
  it("is read as soon as the answer is on it", async () => {
    // The server sends the result and keeps the stream open with comments.
    // The probe used to wait for an end that never came.
    const server = await serve({
      sessionId: "streamed",
      initializeStream: "result-then-pings",
    });
    try {
      const startedAt = Date.now();
      const results = await run(server.url, VALID_HOST, "2025-11-25", 1_500);

      expect(Date.now() - startedAt).toBeLessThan(1_200);
      expect(results[0].status).toBe("passed");
      expect(wire(server.seen)).toEqual([
        "initialize",
        "notifications/initialized",
        "DELETE",
      ]);
    } finally {
      await server.stop();
    }
  }, 8_000);

  it("settles when the connection drops in the middle of the body", async () => {
    // It used to wait for an end that a dropped connection never sends.
    const server = await serve({
      sessionId: "cut",
      initializeStream: "cut-mid-body",
    });
    try {
      const startedAt = Date.now();
      const results = await run(server.url, VALID_HOST, "2025-11-25", 1_500);

      expect(Date.now() - startedAt).toBeLessThan(1_200);
      // A request whose answer never arrived whole is a failed request, the
      // same as a connection that is refused.
      expect(results[0].status).toBe("failed");
      expect(results[0].error?.message).toMatch(/closed before/);
      expect(wire(server.seen)).toEqual(["initialize"]);
    } finally {
      await server.stop();
    }
  }, 8_000);

  it("stops at the check timeout when the stream never carries the answer", async () => {
    // Comments every 50 ms kept an idle timer from ever firing.
    const server = await serve({ initializeStream: "pings-only" });
    try {
      const startedAt = Date.now();
      const results = await run(server.url, VALID_HOST, "2025-11-25", 600);

      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(results[0].status).toBe("failed");
      expect(results[0].error?.message).toBe("Request timed out after 600ms");
    } finally {
      await server.stop();
    }
  }, 8_000);
});

describe("an IPv6 loopback URL", () => {
  it("is reached, brackets and all", async () => {
    let server: Awaited<ReturnType<typeof serve>>;
    try {
      server = await serve({ sessionId: "v6", host: "::1" });
    } catch {
      // No IPv6 loopback on this machine: nothing to test.
      return;
    }
    try {
      expect(server.url).toContain("[::1]");
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      expect(results[0].status).toBe("passed");
      expect(wire(server.seen)).toEqual([
        "initialize",
        "notifications/initialized",
        "DELETE",
      ]);
    } finally {
      await server.stop();
    }
  });
});

describe("the rebinding probe is left alone", () => {
  it("sends one request with the bad Host and nothing after it", async () => {
    // This server accepts the forged Host, which is the failure the check
    // reports. Even then the probe must not go on to finish a handshake: its
    // request is wrong on purpose.
    const server = await serve({ sessionId: "should-not-be-used" });
    try {
      const results = await run(server.url, REBINDING, "2025-11-25");

      expect(results[0].status).toBe("failed");
      expect(wire(server.seen)).toEqual(["initialize"]);
      expect(server.seen[0].headers.host).toBe("evil.example.com");
    } finally {
      await server.stop();
    }
  });
});
