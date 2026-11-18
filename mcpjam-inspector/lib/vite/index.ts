import type { Plugin } from "vite";
import {
  launchInspector,
  type LaunchHttpServer,
  type LaunchStdioServer,
} from "../launcher/index.js";

/**
 * Configuration options for the MCP Inspector Vite plugin.
 */
export interface MCPInspectorPluginOptions {
  /**
   * The server to add to MCPJam: an HTTP server (`url`) or a stdio command
   * (`command`). If not provided, MCPJam opens without adding a server.
   */
  server?: LaunchHttpServer | LaunchStdioServer;

  /**
   * Initial tab to navigate to. Defaults to "playground".
   */
  defaultTab?: string;

  /**
   * If true, automatically launches the inspector when the Vite dev server starts.
   * Defaults to true.
   */
  autoLaunch?: boolean;

  /**
   * Add HTTP request logs to the inspector's output.
   */
  verbose?: boolean;

  /**
   * Keep the inspector's output out of your terminal, including the
   * "MCP Inspector running at" line. Launch failures are still reported.
   */
  silent?: boolean;

  /**
   * Content Security Policy mode for the Playground sandbox.
   * - "permissive": disables CSP enforcement for easier development (default)
   * - "widget-declared": enforces CSP directives declared by the widget
   */
  cspMode?: "permissive" | "widget-declared";

  /** Preferred port, 6274 by default; the next free one is used if taken. */
  port?: number;

  /** Fail instead of moving to another port. */
  strictPort?: boolean;

  /** Open MCPJam in the browser when the plugin starts it. Defaults to true. */
  open?: boolean;

  /**
   * Reuse an MCPJam that is already running instead of starting another.
   * Defaults to true: two projects' dev servers share one MCPJam, and it
   * stays up until the last of them quits.
   */
  reuse?: boolean;
}

/** How long a closed dev server waits for Vite to restart it before letting go. */
const RESTART_GRACE_MS = 2_000;

interface Launch {
  inspector: Promise<{ url: string; stop: () => Promise<void> }>;
  stopTimer?: ReturnType<typeof setTimeout>;
}

// Vite builds a new plugin instance when it restarts after a config edit, in
// the same process. Launches live process-wide so the restarted instance
// picks up the running one instead of attaching again.
const LAUNCHES_KEY = Symbol.for("mcpjam.vitePluginLaunches");
const store = globalThis as typeof globalThis & {
  [LAUNCHES_KEY]?: Map<string, Launch>;
};
const launches = (store[LAUNCHES_KEY] ??= new Map<string, Launch>());

function launchKey(options: MCPInspectorPluginOptions): string {
  return JSON.stringify([options.port ?? 6274, options.server ?? null]);
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
 *       defaultTab: 'playground',
 *     }),
 *   ],
 * });
 * ```
 */
export function mcpInspector(options: MCPInspectorPluginOptions = {}): Plugin {
  const autoLaunch = options.autoLaunch ?? true;
  const key = launchKey(options);

  const stopNow = async () => {
    const launch = launches.get(key);
    if (!launch) return;
    launches.delete(key);
    clearTimeout(launch.stopTimer);
    let inspector: Awaited<Launch["inspector"]>;
    try {
      inspector = await launch.inspector;
    } catch {
      // The launch failed and already reported why; nothing to stop.
      return;
    }
    await inspector.stop();
  };

  return {
    name: "mcp-inspector",

    configureServer(server) {
      if (!autoLaunch) return;

      server.httpServer?.once("listening", async () => {
        const running = launches.get(key);
        if (running) {
          // A restart: keep the MCPJam and the server it already added.
          clearTimeout(running.stopTimer);
          delete running.stopTimer;
          return;
        }
        const launch: Launch = {
          inspector: launchInspector({
            server: options.server,
            defaultTab: options.defaultTab ?? "playground",
            verbose: options.verbose,
            silent: options.silent,
            cspMode: options.cspMode,
            port: options.port,
            strictPort: options.strictPort,
            open: options.open,
            reuse: options.reuse ?? true,
          }),
        };
        launches.set(key, launch);
        try {
          const inspector = await launch.inspector;
          if (!options.silent) {
            console.log(`\n  MCP Inspector running at ${inspector.url}\n`);
          }
        } catch (error) {
          launches.delete(key);
          console.error("Failed to launch MCP Inspector:", error);
        }
      });

      server.httpServer?.on("close", () => {
        const launch = launches.get(key);
        if (!launch) return;
        // Vite closes the old server before a restart's new one listens.
        clearTimeout(launch.stopTimer);
        launch.stopTimer = setTimeout(() => void stopNow(), RESTART_GRACE_MS);
        launch.stopTimer.unref?.();
      });
    },

    async closeBundle() {
      // Also stop on build completion (if running)
      await stopNow();
    },
  };
}
