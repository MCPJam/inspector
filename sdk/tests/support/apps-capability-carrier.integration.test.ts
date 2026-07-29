/**
 * Phase 3 §11.4 investigation: does the modern (2026-07-28) era carry the
 * `io.modelcontextprotocol/ui` client-capability extension the same way the
 * legacy era does?
 *
 * Legacy carries `capabilities.extensions` once, in the `initialize` request
 * `params`. The 2026-07-28 wire moves client capabilities into the
 * per-request `_meta["io.modelcontextprotocol/clientCapabilities"]` envelope
 * (see `RequestMetaEnvelopeSchema` / `outboundEnvelope()` in
 * `@modelcontextprotocol/client`'s 2026 codec) — declared per request rather
 * than once at initialization. This test connects a REAL `MCPClientManager`
 * (exercising the actual merge path: `MCPClientManager.ts` constructor ->
 * `buildCapabilities` -> `ClientOptions.capabilities`) to the dual-era
 * fixture over a raw-capture `fetch`, once per era, and asserts the wire
 * carrier for each.
 *
 * `MCPClientManager` does not expose a `fetch` override in its server config
 * (only `requestInit`), and the underlying `StreamableHTTPClientTransport`
 * falls back to `globalThis.fetch` when none is supplied. So this test
 * patches `globalThis.fetch` for the duration of a single connection — the
 * capturing fetch still dials the real loopback HTTP server underneath, it
 * just also records every exchange.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  MCPClientManager,
} from "../../src/mcp-client-manager/index.js";
import { createFixtureHandler } from "./dual-era-fixture.js";
import {
  createCapturingFetch,
  getWireField,
  type CapturingFetch,
  type RawExchange,
} from "./raw-capture.js";

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixtureOnPort(): Promise<ServedFixture> {
  const handler = createFixtureHandler();
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function byMethod(
  exchanges: RawExchange[],
  method: string,
): RawExchange | undefined {
  return exchanges.find((e) => getWireField(e.request.json, "method") === method);
}

/**
 * Run `run` with `globalThis.fetch` swapped for a capturing fetch that still
 * dials the real underlying fetch. Restores the original afterward even on
 * throw.
 */
async function withCapturingFetch<T>(
  run: (cap: CapturingFetch) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const cap = createCapturingFetch(originalFetch.bind(globalThis));
  globalThis.fetch = cap.fetch as typeof fetch;
  try {
    return await run(cap);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("MCP Apps client-capability carrier — legacy vs 2026-07-28", () => {
  let served: ServedFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    served = await serveFixtureOnPort();
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("legacy: advertises io.modelcontextprotocol/ui in the initialize request's params.capabilities.extensions", async () => {
    const cap = await withCapturingFetch(async (cap) => {
      await manager.connectToServer("fixture", {
        url: served.url,
        timeout: 10_000,
      });
      return cap;
    });

    const init = byMethod(cap.exchanges, "initialize");
    expect(init, "initialize exchange captured").toBeDefined();
    const extension = getWireField(init!.request.json, [
      "params",
      "capabilities",
      "extensions",
      MCP_UI_EXTENSION_ID,
    ]) as { mimeTypes?: unknown } | undefined;
    expect(extension?.mimeTypes).toContain(MCP_UI_RESOURCE_MIME_TYPE);
  });

  it("modern (2026-07-28): the empirical carrier for io.modelcontextprotocol/ui", async () => {
    const cap = await withCapturingFetch(async (cap) => {
      await manager.connectToServer("fixture", {
        url: served.url,
        mcpProtocolVersion: "2026-07-28",
        timeout: 10_000,
      });
      // Exercise a second, ordinary request so we're not only looking at
      // whatever server/discover or the negotiation probe carries.
      await manager.listTools("fixture");
      return cap;
    });

    const list = byMethod(cap.exchanges, "tools/list");
    expect(list, "tools/list exchange captured").toBeDefined();

    // The modern per-request `_meta` envelope carries the negotiated
    // protocol version on every request (already covered by
    // dual-era-fixture.test.ts) — confirm it's present alongside whatever we
    // find for capabilities, so the two assertions are known to be looking
    // at the same envelope.
    expect(
      getWireField(list!.request.json, [
        "params",
        "_meta",
        "io.modelcontextprotocol/protocolVersion",
      ]),
    ).toBe("2026-07-28");

    // EMPIRICAL: the 2026 codec's `outboundEnvelope()` places client
    // capabilities under `_meta["io.modelcontextprotocol/clientCapabilities"]`
    // on every outbound request (verified by reading
    // `@modelcontextprotocol/client`'s installed beta.4 dist: `rev2026Codec
    // .outboundEnvelope` in `src-CMjk3S93.mjs`, sourced from `this._capabilities`
    // — the same `ClientOptions.capabilities` MCPClientManager.buildCapabilities
    // constructs). This assertion is the wire-level confirmation of that
    // reading, not a guess: if the installed SDK version ever stops emitting
    // this carrier, this assertion is expected to fail loudly rather than
    // silently pass.
    const extension = getWireField(list!.request.json, [
      "params",
      "_meta",
      "io.modelcontextprotocol/clientCapabilities",
      "extensions",
      MCP_UI_EXTENSION_ID,
    ]) as { mimeTypes?: unknown } | undefined;
    expect(extension?.mimeTypes).toContain(MCP_UI_RESOURCE_MIME_TYPE);
  });
});
