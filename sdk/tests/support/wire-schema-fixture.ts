/**
 * Hand-rolled 2026-07-28 servers whose responses are DEFECTIVE in exactly the
 * ways the 2026-07 conformance sweep found in production.
 *
 * Hand-rolled and not built on `@modelcontextprotocol/server` on purpose: the
 * official server emits conforming envelopes, so it cannot express the defects
 * under test. These handlers write the bytes literally, which is the only way
 * to fixture "hubspot returned a `tools/list` with no `ttlMs`" or "canva
 * answered with `id: null`".
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { readJsonRpcBody } from "./json-rpc-fixture.js";

export interface WireFixtureOptions {
  /** Drop `ttlMs` and `cacheScope` from list results (the hubspot shape). */
  omitCacheHints?: boolean;
  /** Drop `resultType` from every result. */
  omitResultType?: boolean;
  /** Answer every request with `"id": null` (the canva shape). */
  nullEnvelopeId?: boolean;
}

const SERVER_INFO = { name: "mcpjam-wire-fixture", version: "1.0.0" };

function resultFor(
  method: string,
  options: WireFixtureOptions,
): Record<string, unknown> | undefined {
  const cacheHints = options.omitCacheHints
    ? {}
    : { ttlMs: 60_000, cacheScope: "public" };
  const resultType = options.omitResultType ? {} : { resultType: method };
  const meta = {
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
  };

  switch (method) {
    case "server/discover":
      return {
        ...resultType,
        ...cacheHints,
        ...meta,
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      };
    case "tools/list":
      return {
        ...resultType,
        ...cacheHints,
        ...meta,
        tools: [
          {
            name: "echo",
            description: "Echoes its input.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    default:
      return undefined;
  }
}

/**
 * Serve the fixture on a loopback port. Returns the URL; the caller closes it.
 */
export async function serveWireFixture(
  options: WireFixtureOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    void (async () => {
      const parsed = await readJsonRpcBody(req, res);
      if (!parsed) return;

      const method = String(parsed.method ?? "");
      const id = options.nullEnvelopeId ? null : (parsed.id ?? null);
      const result = resultFor(method, options);

      if (!result) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          }),
        );
        return;
      }

      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    })();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        // `close` only stops new connections; the conformance client leaves
        // keep-alive sockets open, and without this the promise never settles.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
