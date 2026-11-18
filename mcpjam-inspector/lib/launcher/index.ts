import type { ChildProcess } from "child_process";
import { createRequire } from "module";
import path from "path";
import {
  embedInspector,
  type EmbeddedInspector,
} from "@mcpjam/sdk/internal/inspector";
import { LAUNCHER_TABS, resolveLauncherTab } from "../../shared/launcher-tabs";

const require = createRequire(import.meta.url);

/** An MCP server reached over HTTP. */
export interface LaunchHttpServer {
  /** Display name for the server in the UI */
  name: string;
  /** HTTP URL of the MCP server */
  url: string;
  /** Custom headers to send with requests */
  headers?: Record<string, string>;
  /** If true, triggers OAuth flow on connect */
  useOAuth?: boolean;
}

/**
 * An MCP server MCPJam starts as a stdio command. The first time this device
 * sees the command, MCPJam asks the developer to approve it.
 */
export interface LaunchStdioServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Configuration options for launching the MCP Inspector.
 */
export interface LaunchOptions {
  /**
   * The server to add to MCPJam. An open, signed-in MCPJam tab saves it to
   * the project it shows (or asks which one), connects it and selects it.
   */
  server?: LaunchHttpServer | LaunchStdioServer;

  /**
   * Initial tab to navigate to, such as "playground", "servers", "tools",
   * "resources" or "prompts". The older names "chat" and "app-builder" open
   * Playground. A name that is not an Inspector tab makes the launch reject.
   */
  defaultTab?: string;

  /**
   * Add HTTP request logs to the inspector's output.
   */
  verbose?: boolean;

  /**
   * Keep the inspector's output out of your terminal. If the inspector fails
   * to start, the rejected error includes the end of its output.
   */
  silent?: boolean;

  /**
   * Content Security Policy mode for the App Builder sandbox.
   * - "permissive": disables CSP enforcement for easier development (default)
   * - "widget-declared": enforces CSP directives declared by the widget
   */
  cspMode?: "permissive" | "widget-declared";

  /**
   * Preferred port. Defaults to 6274. When it is taken, the next free port
   * (within 20) is used and `url` points there.
   */
  port?: number;

  /** Reject instead of moving to another port when `port` is taken. */
  strictPort?: boolean;

  /**
   * Open MCPJam in the browser when this launch starts it. Defaults to true;
   * the browser never opens in CI or without an interactive terminal.
   */
  open?: boolean;

  /**
   * Reuse your MCPJam already running on `port` instead of starting another,
   * and share the one this launch starts: it stays up while any dev command
   * still uses it, and stops when the last one quits. The result then has
   * no `process` when MCPJam was already running.
   */
  reuse?: boolean;
}

/**
 * Handle for a running MCP Inspector instance.
 */
export interface InspectorInstance {
  /**
   * The URL where the inspector is running, including its session token
   */
  url: string;

  /** The port MCPJam listens on. */
  port: number;

  /**
   * Stop the inspector server, after removing the server this launch added
   */
  stop: () => Promise<void>;

  /**
   * The underlying child process (for advanced use)
   */
  process: ChildProcess;
}

/** Handle for a launch with `reuse: true`. */
export interface ReusedInspectorInstance extends Omit<InspectorInstance, "process"> {
  /** False when an MCPJam that was already running was reused. */
  started: boolean;
  /** The started MCPJam's process; absent when one was reused. */
  process?: ChildProcess;
  /**
   * Lets go of MCPJam after removing the server this launch added. MCPJam
   * stops when no other dev command uses it, and never when you started it.
   */
  stop: () => Promise<void>;
}

/**
 * Launches the MCP Inspector with the specified configuration.
 *
 * @example
 * ```typescript
 * import { launchInspector } from '@mcpjam/inspector';
 *
 * const inspector = await launchInspector({
 *   server: {
 *     name: 'My MCP Server',
 *     url: 'http://localhost:3000/mcp',
 *   },
 *   defaultTab: 'playground',
 * });
 *
 * console.log(`Inspector running at ${inspector.url}`);
 *
 * // Later: stop the inspector
 * await inspector.stop();
 * ```
 */
export function launchInspector(
  options: LaunchOptions & { reuse: true },
): Promise<ReusedInspectorInstance>;
export function launchInspector(
  options?: LaunchOptions & { reuse?: false },
): Promise<InspectorInstance>;
// A `reuse` known only at run time may be either, so the result may lack `process`.
export function launchInspector(
  options: LaunchOptions,
): Promise<InspectorInstance | ReusedInspectorInstance>;
export async function launchInspector(
  options: LaunchOptions = {},
): Promise<InspectorInstance | ReusedInspectorInstance> {
  // Resolved before anything starts, so an unknown name fails here instead
  // of opening Servers. The env and the URL both carry the resolved tab.
  const tab = options.defaultTab
    ? resolveLauncherTab(options.defaultTab)
    : undefined;
  if (options.defaultTab && !tab) {
    throw new Error(
      `Could not launch the Inspector because defaultTab "${options.defaultTab}" is not a tab. Set defaultTab to one of ${LAUNCHER_TABS.join(", ")}.`,
    );
  }

  const packageJsonPath = require.resolve("@mcpjam/inspector/package.json");
  const binPath = path.resolve(path.dirname(packageJsonPath), "bin/start.js");
  const shouldOpen =
    options.open !== false && !process.env.CI && Boolean(process.stdout.isTTY);

  const inspector = await embedInspector({
    start: { command: "node", args: [binPath] },
    open: shouldOpen,
    // Not for a silent launch: its output is kept out of the terminal.
    onWarning: options.silent ? undefined : (message) => console.warn(message),
    port: options.port,
    strictPort: options.strictPort,
    reuse: options.reuse,
    silent: options.silent,
    tab,
    env: {
      ...(options.verbose ? { VERBOSE_LOGS: "true" } : {}),
      ...(options.cspMode ? { MCP_CSP_MODE: options.cspMode } : {}),
    },
  });

  if (options.server) {
    try {
      await inspector.connect(launcherServer(options.server));
    } catch (error) {
      await inspector.stop();
      throw error;
    }
  }
  return toInstance(inspector, options.reuse === true);
}

function launcherServer(server: LaunchHttpServer | LaunchStdioServer) {
  if ("command" in server) {
    return {
      name: server.name,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return {
    name: server.name,
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
    ...(server.useOAuth ? { useOAuth: true } : {}),
  };
}

function toInstance(
  inspector: EmbeddedInspector,
  reuse: boolean,
): InspectorInstance | ReusedInspectorInstance {
  const base = { url: inspector.url, port: inspector.port, stop: inspector.stop };
  if (reuse) {
    return {
      ...base,
      started: inspector.started,
      ...(inspector.process ? { process: inspector.process } : {}),
    };
  }
  // Without reuse this launch always starts its own MCPJam.
  if (!inspector.process) {
    throw new Error("The Inspector started without a process handle.");
  }
  return { ...base, process: inspector.process };
}
