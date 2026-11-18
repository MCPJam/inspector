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

/** How long after its last dev server closes a launch waits for Vite to restart one. */
const RESTART_GRACE_MS = 5_000;

interface Launch {
  inspector: Promise<{ url: string; stop: () => Promise<void> }>;
  /** Plugin instances whose dev server is up: the one a restart replaces counts too. */
  users: number;
  stopTimer?: ReturnType<typeof setTimeout>;
}

// Vite builds a new plugin instance when it restarts after a config change,
// in the same process. Launches live process-wide so the restarted instance
// picks up the running one instead of attaching again.
const LAUNCHES_KEY = Symbol.for("mcpjam.vitePluginLaunches");
const store = globalThis as typeof globalThis & {
  [LAUNCHES_KEY]?: Map<string, Launch>;
};
const launches = (store[LAUNCHES_KEY] ??= new Map<string, Launch>());

function launchKey(options: MCPInspectorPluginOptions): string {
  return JSON.stringify([options.port ?? 6274, options.server ?? null]);
}

/** Stops a launch nobody uses any more. A newer launch under the same key is left alone. */
async function stopUnused(key: string, launch: Launch): Promise<void> {
  if (launches.get(key) !== launch || launch.users > 0) return;
  launches.delete(key);
  let inspector: Awaited<Launch["inspector"]>;
  try {
    inspector = await launch.inspector;
  } catch {
    // The launch failed and already reported why; nothing to stop.
    return;
  }
  await inspector.stop();
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
  /** Whether this instance's dev server currently counts as a user of the launch. */
  let counted = false;

  // Vite closes the old server and calls `closeBundle` on every restart, in
  // either order relative to the new server listening, and not only when it
  // really exits. So neither stops the launch; the last user to leave starts a
  // grace timer, which a new one cancels. A real exit is covered by the holder
  // watchdog and by MCPJam noticing the dev command's process is gone.
  const leave = () => {
    if (!counted) return;
    counted = false;
    const launch = launches.get(key);
    if (!launch) return;
    launch.users -= 1;
    if (launch.users > 0) return;
    clearTimeout(launch.stopTimer);
    launch.stopTimer = setTimeout(() => void stopUnused(key, launch), RESTART_GRACE_MS);
    launch.stopTimer.unref?.();
  };

  return {
    name: "mcp-inspector",

    configureServer(server) {
      if (!autoLaunch) return;

      server.httpServer?.once("listening", async () => {
        counted = true;
        const running = launches.get(key);
        if (running) {
          // A restart: keep the MCPJam and the server it already added.
          running.users += 1;
          clearTimeout(running.stopTimer);
          delete running.stopTimer;
          return;
        }
        const launch: Launch = {
          users: 1,
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
          // Only this launch: a restart may already have replaced it.
          if (launches.get(key) === launch) launches.delete(key);
          counted = false;
          console.error("Failed to launch MCP Inspector:", error);
        }
      });

      server.httpServer?.on("close", leave);
    },

    closeBundle: leave,
  };
}
