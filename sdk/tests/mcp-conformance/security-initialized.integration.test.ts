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
  /** Answer `initialize` with a JSON-RPC error on HTTP 200. */
  refuseInitialize?: boolean;
  /** Answer the notification with a stream that is never ended. */
  hangNotification?: boolean;
  /** Status for the notification. Defaults to 202. */
  notificationStatus?: number;
}

async function serve(options: FixtureOptions = {}): Promise<{
  url: string;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}> {
  const seen: SeenRequest[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      seen.push({ method: req.method ?? "", headers: req.headers, body });

      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (body?.method === "initialize") {
        if (options.refuseInitialize) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32602, message: "Unsupported protocol version" },
            }),
          );
          return;
        }
        const params = body.params as { protocolVersion: string };
        res.writeHead(200, {
          "Content-Type": "application/json",
          ...(options.sessionId ? { "Mcp-Session-Id": options.sessionId } : {}),
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: options.answerVersion ?? params.protocolVersion,
              capabilities: {},
              serverInfo: { name: "fixture", version: "1.0.0" },
            },
          }),
        );
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server did not bind to a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seen,
    stop: () =>
      new Promise<void>((resolve, reject) => {
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
) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: url,
    ...(protocolVersion ? { protocolVersion } : {}),
    checkTimeout,
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

  it("carries the version the server agreed to, not the one it was asked for", async () => {
    const server = await serve({
      sessionId: "older",
      answerVersion: "2025-06-18",
    });
    try {
      await run(server.url, VALID_HOST, "2025-11-25");

      expect(wire(server.seen)).toEqual([
        "initialize",
        "notifications/initialized",
        "DELETE",
      ]);
      expect(server.seen[1].headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(server.seen[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
    } finally {
      await server.stop();
    }
  });

  it("disconnects without initialized when the answered version is unsupported", async () => {
    const server = await serve({
      sessionId: "future",
      answerVersion: "2099-01-01",
    });
    try {
      const results = await run(server.url, VALID_HOST, "2025-11-25");

      // The check is about the Host header, and that was accepted.
      expect(results[0].status).toBe("passed");
      expect(wire(server.seen)).toEqual(["initialize", "DELETE"]);
      expect(results[0].details?.handshake).toMatchObject({
        initialized: "not sent",
        sessionCloseStatus: 200,
      });
    } finally {
      await server.stop();
    }
  });

  it("sends nothing more when initialize was refused in the body", async () => {
    const server = await serve({ sessionId: "unused", refuseInitialize: true });
    try {
      await run(server.url, VALID_HOST, "2025-11-25");

      expect(wire(server.seen)).toEqual(["initialize"]);
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
