/**
 * An unpinned connect against a server that answers the first modern request
 * with HTTP 400 and JSON-RPC `-32022` ("protocol version not supported").
 *
 * "A recognized modern JSON-RPC error ... identifies a modern server: the
 * client retries with a supported version rather than falling back." The
 * fallback here is the older HTTP+SSE transport, which opens with a GET. The
 * server below logs every request, so a GET it should not have received shows.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCPAuthError,
  MCPClientManager,
  ModernProtocolVersionRefused,
  ProtocolVersionPinUnsupported,
} from "../src/mcp-client-manager/index.js";

type Shape =
  /**
   * Modern server: refuses the probe with -32022 and lists `supported`.
   * `initialize` says how it answers the 2025 handshake for a 2025 version it
   * listed: properly (`ok`, the default), with an HTTP 404 (`not-found`),
   * with an HTTP 400 carrying another JSON-RPC error (`bad-request`), or with
   * an HTTP 401 (`unauthorized`).
   */
  | {
      kind: "modern";
      supported: string[];
      initialize?: "ok" | "not-found" | "bad-request" | "unauthorized";
    }
  /** An old HTTP+SSE server: it does not take a POST at this URL at all. */
  | { kind: "sse-only" };

async function serve(shape: Shape) {
  const wire: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text
      ? (JSON.parse(text) as { id?: unknown; method?: string })
      : undefined;
    wire.push(`${req.method} ${body?.method ?? "-"}`);

    const json = (
      status: number,
      payload: unknown,
      headers: Record<string, string> = {}
    ) =>
      res
        .writeHead(status, { "Content-Type": "application/json", ...headers })
        .end(JSON.stringify(payload));

    if (req.method !== "POST" || shape.kind === "sse-only") {
      res.writeHead(405).end();
      return;
    }

    const legacyOffer = shape.supported.find((version) =>
      version.startsWith("2025-")
    );
    const version = String(req.headers["mcp-protocol-version"] ?? "");
    const isLegacyRequest =
      body?.method === "initialize" ||
      req.headers["mcp-session-id"] !== undefined;

    if (isLegacyRequest && shape.initialize === "not-found") {
      res.writeHead(404).end();
      return;
    }
    if (isLegacyRequest && shape.initialize === "unauthorized") {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }
    if (isLegacyRequest && shape.initialize === "bad-request") {
      return json(400, {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }

    if (isLegacyRequest && legacyOffer) {
      switch (body?.method) {
        case "initialize":
          return json(
            200,
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: legacyOffer,
                capabilities: { tools: {} },
                serverInfo: { name: "refusal-fixture", version: "1" },
              },
            },
            { "Mcp-Session-Id": "session-1" }
          );
        case "notifications/initialized":
          res.writeHead(202).end();
          return;
        default:
          return json(200, {
            jsonrpc: "2.0",
            id: body?.id,
            result: { tools: [] },
          });
      }
    }

    return json(400, {
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: {
        code: -32022,
        message: `Unsupported protocol version: ${version || "none"}`,
        data: { supported: shape.supported, requested: version },
      },
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    wire,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(
  shape: Shape,
  config: {
    mcpProtocolVersion?: "2026-07-28";
    disableSseFallback?: boolean;
  } = {}
) {
  const served = await serve(shape);
  const manager = new MCPClientManager();
  cleanups.push(served.close, () =>
    manager.disconnectAllServers().catch(() => undefined)
  );
  const connected = manager
    .connectToServer("fixture", { url: served.url, timeout: 5_000, ...config })
    .then(() => manager.getInitializationInfo("fixture")?.protocolVersion);
  return { connected, wire: served.wire };
}

/** The rejection itself, so a test can read its class and message. */
const failure = (connected: Promise<unknown>) =>
  connected.then(
    () => undefined,
    (reason: unknown) => reason as Error
  );

const NO_SHARED_VERSION = `MCP server "fixture" doesn't support an MCP protocol version this client speaks. It offers 2099-01-01.`;

describe("an unpinned connect refused with the modern version error", () => {
  it("stops without trying the SSE transport when no version is shared", async () => {
    const { connected, wire } = await connect({
      kind: "modern",
      supported: ["2099-01-01"],
    });

    const error = await failure(connected);

    expect(error).toBeInstanceOf(ModernProtocolVersionRefused);
    expect(error?.message).toBe(NO_SHARED_VERSION);
    expect((error as ModernProtocolVersionRefused).supportedVersions).toEqual([
      "2099-01-01",
    ]);
    // One request reached the server: the probe. No GET for an SSE stream.
    expect(wire).toEqual(["POST server/discover"]);
  });

  it("retries with the 2025 handshake when the server lists a version it shares", async () => {
    const { connected, wire } = await connect({
      kind: "modern",
      supported: ["2099-01-01", "2025-06-18"],
    });

    await expect(connected).resolves.toBe("2025-06-18");
    expect(wire.slice(0, 2)).toEqual([
      "POST server/discover",
      "POST initialize",
    ]);
  });

  it("still connects to a server that lists only a 2025 version", async () => {
    const { connected, wire } = await connect({
      kind: "modern",
      supported: ["2025-11-25"],
    });

    await expect(connected).resolves.toBe("2025-11-25");
    expect(wire.slice(0, 2)).toEqual([
      "POST server/discover",
      "POST initialize",
    ]);
  });
});

describe("what counts as a version the server shares", () => {
  // The list comes from the server. Only a 2025 version this client knows is
  // a reason to retry: an empty string or an older revision is not.
  it.each([
    ["an empty string", ["2099-01-01", ""]],
    [
      "a revision older than any this client pins",
      ["2099-01-01", "2024-11-05"],
    ],
    ["text that is not a version", ["2099-01-01", "latest"]],
  ])("does not retry for %s", async (_label, supported) => {
    const { connected, wire } = await connect({ kind: "modern", supported });

    expect(await failure(connected)).toBeInstanceOf(
      ModernProtocolVersionRefused
    );
    expect(wire).toEqual(["POST server/discover"]);
  });
});

describe("the retry on a server already known to be modern", () => {
  // The 2025 handshake fails with something that is not the modern refusal.
  // On a server not yet known to be modern, that is where SSE would be tried.
  it.each(["not-found", "bad-request"] as const)(
    "does not open the SSE transport when the 2025 handshake fails too (%s)",
    async (initialize) => {
      const { connected, wire } = await connect({
        kind: "modern",
        supported: ["2099-01-01", "2025-06-18"],
        initialize,
      });

      const error = await failure(connected);

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain("SSE error");
      // The probe, then one 2025 handshake. No GET for an SSE stream.
      expect(wire).toEqual(["POST server/discover", "POST initialize"]);
    }
  );

  it("keeps an auth failure on the 2025 handshake an MCPAuthError", async () => {
    const { connected, wire } = await connect({
      kind: "modern",
      supported: ["2099-01-01", "2025-06-18"],
      initialize: "unauthorized",
    });

    const error = await failure(connected);

    // The OAuth hooks key on this class; a plain Error would skip them.
    expect(error).toBeInstanceOf(MCPAuthError);
    expect(wire).toEqual(["POST server/discover", "POST initialize"]);
  });

  it("says why SSE was not tried", async () => {
    const { connected } = await connect({
      kind: "modern",
      supported: ["2099-01-01", "2025-06-18"],
      initialize: "bad-request",
    });

    expect((await failure(connected))?.message).toContain(
      "The server answered as a modern MCP server, so the older SSE transport was not tried."
    );
  });
});

describe("a server whose declared transport rules out SSE", () => {
  it("gets the same clear error when no version is shared", async () => {
    const { connected, wire } = await connect(
      { kind: "modern", supported: ["2099-01-01"] },
      { disableSseFallback: true }
    );

    const error = await failure(connected);

    expect(error).toBeInstanceOf(ModernProtocolVersionRefused);
    expect(error?.message).toBe(NO_SHARED_VERSION);
    expect(wire).toEqual(["POST server/discover"]);
  });

  it("gets the 2025 retry when it lists a version it shares", async () => {
    const { connected, wire } = await connect(
      { kind: "modern", supported: ["2099-01-01", "2025-06-18"] },
      { disableSseFallback: true }
    );

    await expect(connected).resolves.toBe("2025-06-18");
    expect(wire.slice(0, 2)).toEqual([
      "POST server/discover",
      "POST initialize",
    ]);
  });
});

describe("what must not change", () => {
  it("an old HTTP+SSE server still gets the SSE fallback", async () => {
    const { connected, wire } = await connect({ kind: "sse-only" });

    await expect(connected).rejects.toThrow();
    // No modern error was seen, so the server may be a legacy one: the GET
    // that opens the SSE transport is still sent.
    expect(wire).toContain("GET -");
  });

  it("a pinned connect still reports the pin, and sends no GET", async () => {
    const { connected, wire } = await connect(
      { kind: "modern", supported: ["2099-01-01"] },
      { mcpProtocolVersion: "2026-07-28" }
    );

    await expect(connected).rejects.toBeInstanceOf(
      ProtocolVersionPinUnsupported
    );
    expect(wire).not.toContain("GET -");
  });
});
