/**
 * SEP-2549 cache test fixture (dual-era).
 *
 * `buildCacheFixtureServer` registers the same primitive surface as the base
 * dual-era fixture but attaches a server-level `cacheHints` entry so its
 * `tools/list` result carries `ttlMs: 60_000` (+ `cacheScope: 'public'`). On a
 * 2026-07-28 connection the modern wire codec emits those fields, so a still-
 * fresh cached `tools/list` is SERVED without a round trip under
 * `cacheMode: 'use'` (the default) — the invisible serve this PR makes
 * observable. The 2025-era codec has no cache path, so a legacy connection
 * never carries `ttlMs`: the same fixture refetches every time (the cache
 * engine is era-blind, but the wire body only has `ttlMs` when the modern
 * codec put it there).
 *
 * `serveCountingFixtureOnPort` serves any handler over a loopback port while
 * counting JSON-RPC request methods that actually reach the server — the wire
 * evidence a debugger needs to prove "the cache answered, not the server".
 * (The `MCPClientManager` transport takes no injectable `fetch`, so wire
 * counting is done at the server handler rather than with `createCapturingFetch`.)
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";

export const CACHE_FIXTURE_SERVER_INFO = {
  name: "mcpjam-cache-fixture",
  version: "1.0.0",
} as const;

/** The server-declared cache lifetime for `tools/list` in the ttl fixture. */
export const CACHE_FIXTURE_TTL_MS = 60_000;

export const CACHE_FIXTURE_GREETING_URI = "test://greeting";

function registerSurface(server: McpServer): void {
  server.registerTool(
    "echo",
    {
      description: "Echoes the provided message back as text.",
      inputSchema: { message: z.string() },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: String(args.message) }],
    }),
  );
  server.registerResource(
    "greeting",
    CACHE_FIXTURE_GREETING_URI,
    { description: "A static greeting resource.", mimeType: "text/plain" },
    async () => ({
      contents: [
        {
          uri: CACHE_FIXTURE_GREETING_URI,
          mimeType: "text/plain",
          text: "hello from the cache fixture",
        },
      ],
    }),
  );
  server.registerPrompt(
    "welcome",
    { description: "A trivial welcome prompt." },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: "welcome" },
        },
      ],
    }),
  );
}

/**
 * Fixture whose `tools/list` carries `ttlMs: 60_000` on the modern era. The
 * hint is server configuration (era-blind); only the 2026 codec emits it.
 */
export function buildCacheFixtureServer(): McpServer {
  const server = new McpServer(CACHE_FIXTURE_SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    cacheHints: {
      "tools/list": { ttlMs: CACHE_FIXTURE_TTL_MS, cacheScope: "public" },
    },
  });
  registerSurface(server);
  return server;
}

/**
 * Same surface WITHOUT any cache hint: `tools/list` never carries `ttlMs`, so
 * even on the modern era the client's `defaultCacheTtlMs` (0) makes every
 * result "immediately stale" — a guard against an upstream default change.
 */
export function buildNoTtlFixtureServer(): McpServer {
  const server = new McpServer(CACHE_FIXTURE_SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });
  registerSurface(server);
  return server;
}

export function createCacheFixtureHandler(): McpHttpHandler {
  return createMcpHandler(buildCacheFixtureServer);
}

export function createNoTtlFixtureHandler(): McpHttpHandler {
  return createMcpHandler(buildNoTtlFixtureServer);
}

export interface ServedCountingFixture {
  url: string;
  /** JSON-RPC method → number of requests that reached the server. */
  methodCounts: Map<string, number>;
  /** Count for a single method (0 when unseen). */
  count: (method: string) => number;
  close: () => Promise<void>;
}

function recordMethods(bodyText: string, counts: Map<string, number>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    const method = (message as { method?: unknown })?.method;
    if (typeof method === "string") {
      counts.set(method, (counts.get(method) ?? 0) + 1);
    }
  }
}

/**
 * Serve `handler` over a loopback port, counting every JSON-RPC request method
 * that reaches it. The count is taken at the web-standard `fetch` seam (before
 * the handler runs), so a cache serve — which never leaves the client — is
 * exactly the case where the count does NOT advance.
 */
export async function serveCountingFixtureOnPort(
  handler: McpHttpHandler,
): Promise<ServedCountingFixture> {
  const methodCounts = new Map<string, number>();
  const countingHandler = {
    fetch: async (request: Request, options?: unknown) => {
      // Clone before reading so the real handler still sees the body.
      const text = await request
        .clone()
        .text()
        .catch(() => "");
      recordMethods(text, methodCounts);
      return handler.fetch(request, options as never);
    },
  };
  const httpServer = http.createServer(toNodeHandler(countingHandler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    methodCounts,
    count: (method: string) => methodCounts.get(method) ?? 0,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
