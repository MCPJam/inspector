/**
 * beta.4 dual-era test fixture.
 *
 * `createMcpHandler(factory)` from `@modelcontextprotocol/server` serves the
 * 2026-07-28 modern protocol per request and, by default (`legacy:
 * 'stateless'`), also serves 2025-era traffic through the stateless idiom —
 * one factory, one endpoint, both eras. There is no in-memory serving entry
 * for the modern era (`InMemoryTransport` is 2025-only), so tests drive the
 * handler in-process through its `fetch` (see `dual-era-fixture.test.ts`),
 * pairing it with the raw-capture helpers to assert wire behavior without
 * sockets.
 *
 * Phase 0A of the MCP 2026-07-28 migration. This is the verification target
 * for the official-client cutover (1B), the preview-client removal (1C), and
 * the modern conformance suite (7).
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const FIXTURE_SERVER_INFO = {
  name: "mcpjam-dual-era-fixture",
  version: "1.0.0",
} as const;

export const FIXTURE_GREETING_URI = "test://greeting";

/**
 * Build a fresh fixture server. `createMcpHandler` calls this per request, so
 * it must register the same surface every time; keep it side-effect-free.
 */
export function buildFixtureServer(): McpServer {
  const server = new McpServer(FIXTURE_SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });

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
    FIXTURE_GREETING_URI,
    { description: "A static greeting resource.", mimeType: "text/plain" },
    async () => ({
      contents: [
        {
          uri: FIXTURE_GREETING_URI,
          mimeType: "text/plain",
          text: "hello from the fixture",
        },
      ],
    }),
  );

  server.registerPrompt(
    "welcome",
    { description: "A trivial welcome prompt." },
    async () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: "welcome" } },
      ],
    }),
  );

  return server;
}

/**
 * A `createMcpHandler` bound to the fixture. Serves the modern era and, by
 * default, the legacy-stateless era. Drive it with `handler.fetch(request)`.
 */
export function createFixtureHandler() {
  return createMcpHandler(buildFixtureServer);
}
