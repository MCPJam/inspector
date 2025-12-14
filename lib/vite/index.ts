import type { Plugin } from "vite";
import { launchInspector, InspectorInstance } from "../launcher/index.js";

/**
 * Configuration options for the MCP Inspector Vite plugin.
 */
export interface MCPInspectorPluginOptions {
  /**
   * Server configuration for auto-connect.
   * If not provided, the inspector launches without a pre-configured server.
   */
  server?: {
    /**
     * Display name for the server in the UI
     */
    name: string;

    /**
     * HTTP URL of the MCP server
     */
    url: string;

    /**
     * Custom headers to send with requests
     */
    headers?: Record<string, string>;

    /**
     * If true, triggers OAuth flow on connect
     */
    useOAuth?: boolean;
  };

  /**
   * Initial tab to navigate to. Defaults to "app-builder".
   */
  defaultTab?: string;

  /**
   * If true, automatically launches the inspector when the Vite dev server starts.
   * Defaults to true.
   */
  autoLaunch?: boolean;

  /**
   * Enable verbose logging output.
   * When false (default), the inspector runs silently.
   */
  verbose?: boolean;
}

/**
 * Vite plugin that integrates the MCP Inspector into your development workflow.
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { mcpInspector } from '@mcpjam/inspector/vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     mcpInspector({
 *       server: {
 *         name: 'My MCP Server',
 *         url: 'http://localhost:3000/mcp',
 *       },
 *       defaultTab: 'app-builder',
 *     }),
 *   ],
 * });
 * ```
 */
export function mcpInspector(options: MCPInspectorPluginOptions = {}): Plugin {
  let inspector: InspectorInstance | null = null;
  const autoLaunch = options.autoLaunch ?? true;

  return {
    name: "mcp-inspector",

    configureServer(server) {
      if (!autoLaunch) return;

      // Launch inspector when Vite dev server starts
      server.httpServer?.once("listening", async () => {
        try {
          inspector = await launchInspector({
            server: options.server,
            defaultTab: options.defaultTab ?? "app-builder",
            verbose: options.verbose,
          });
          console.log(`\n  MCP Inspector running at ${inspector.url}\n`);
        } catch (error) {
          console.error("Failed to launch MCP Inspector:", error);
        }
      });

      // Stop inspector when Vite dev server closes
      server.httpServer?.on("close", async () => {
        if (inspector) {
          await inspector.stop();
          inspector = null;
        }
      });
    },

    async closeBundle() {
      // Also stop on build completion (if running)
      if (inspector) {
        await inspector.stop();
        inspector = null;
      }
    },
  };
}
