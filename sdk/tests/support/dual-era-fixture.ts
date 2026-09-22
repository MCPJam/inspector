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

/** MCP Apps fixture surface (Phase 3 §11.4 dual-era regression gate). */
export const FIXTURE_APP_WIDGET_URI = "ui://fixture/widget";
export const FIXTURE_APP_WIDGET_OVERRIDE_URI = "ui://fixture/widget-override";
export const FIXTURE_APP_MIME_TYPE = "text/html;profile=mcp-app";
const FIXTURE_APP_WIDGET_HTML =
  "<html><body><p>fixture widget</p></body></html>";

export interface BuildFixtureServerOptions {
  /**
   * When true, additionally registers the MCP Apps surface: a `ui://`
   * resource plus a nested-`_meta` tool (`show-widget`) and a
   * deprecated-flat-`_meta` tool (`show-widget-flat`). Defaults to false so
   * the default fixture surface stays byte-identical for tests that snapshot
   * it (see `dual-era-fixture.test.ts`).
   */
  apps?: boolean;
}

/**
 * Build a fresh fixture server. `createMcpHandler` calls this per request, so
 * it must register the same surface every time; keep it side-effect-free.
 */
export function buildFixtureServer(
  options: BuildFixtureServerOptions = {},
): McpServer {
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

  if (options.apps) {
    server.registerResource(
      "fixture-widget",
      FIXTURE_APP_WIDGET_URI,
      {
        description: "A static MCP Apps UI resource.",
        mimeType: FIXTURE_APP_MIME_TYPE,
      },
      async () => ({
        contents: [
          {
            uri: FIXTURE_APP_WIDGET_URI,
            mimeType: FIXTURE_APP_MIME_TYPE,
            text: FIXTURE_APP_WIDGET_HTML,
          },
        ],
      }),
    );

    // Nested `_meta.ui.resourceUri` (preferred form, SEP-1865). The handler
    // result's content-item `_meta.ui.resourceUri` intentionally differs from
    // the tool-level declaration so precedence between the two is assertable.
    server.registerTool(
      "show-widget",
      {
        description: "Shows the fixture widget (nested _meta form).",
        inputSchema: {},
        _meta: { ui: { resourceUri: FIXTURE_APP_WIDGET_URI } },
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: "widget shown",
            _meta: { ui: { resourceUri: FIXTURE_APP_WIDGET_OVERRIDE_URI } },
          },
        ],
      }),
    );

    // Deprecated flat `_meta["ui/resourceUri"]` form — legacy servers still
    // emit this; `isMcpAppTool` must still detect it.
    server.registerTool(
      "show-widget-flat",
      {
        description: "Shows the fixture widget (deprecated flat _meta form).",
        inputSchema: {},
        _meta: { "ui/resourceUri": FIXTURE_APP_WIDGET_URI },
      },
      async () => ({
        content: [{ type: "text" as const, text: "widget shown" }],
      }),
    );
  }

  return server;
}

/**
 * A `createMcpHandler` bound to the fixture. Serves the modern era and, by
 * default, the legacy-stateless era. Drive it with `handler.fetch(request)`.
 */
export function createFixtureHandler(options: BuildFixtureServerOptions = {}) {
  return createMcpHandler(() => buildFixtureServer(options));
}
