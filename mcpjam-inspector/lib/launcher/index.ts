import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

/**
 * Configuration options for launching the MCP Inspector.
 */
export interface LaunchOptions {
  /**
   * Server configuration for auto-connect
   */
  server?: {
    /**
     * Display name for the server in the UI
     */
    name: string;

    /**
     * HTTP URL of the MCP server (required for HTTP transport)
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
   * Initial tab to navigate to.
   * Options: "servers", "tools", "resources", "prompts", "chat", "app-builder"
   */
  defaultTab?: string;

  /**
   * Enable verbose logging output.
   * When false (default), the inspector runs silently.
   */
  verbose?: boolean;
}

/**
 * Handle for a running MCP Inspector instance.
 */
export interface InspectorInstance {
  /**
   * The URL where the inspector is running
   */
  url: string;

  /**
   * Stop the inspector server
   */
  stop: () => Promise<void>;

  /**
   * The underlying child process (for advanced use)
   */
  process: ChildProcess;
}

/**
 * Waits for the inspector server to be ready by polling the health endpoint.
 */
async function waitForServer(port: number, timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Inspector failed to start within ${timeout}ms`);
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
 *   defaultTab: 'app-builder',
 * });
 *
 * console.log(`Inspector running at ${inspector.url}`);
 *
 * // Later: stop the inspector
 * await inspector.stop();
 * ```
 */
const INSPECTOR_PORT = 6274;

export async function launchInspector(
  options: LaunchOptions = {},
): Promise<InspectorInstance> {
  // Find bin/start.js relative to this file
  // From dist/lib/launcher/index.js -> ../../../bin/start.js
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.resolve(__dirname, "../../../bin/start.js");

  // Build environment
  const env: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>),
  };

  if (options.server) {
    const config = {
      mcpServers: {
        [options.server.name]: {
          url: options.server.url,
          ...(options.server.headers && { headers: options.server.headers }),
          ...(options.server.useOAuth && { useOAuth: true }),
        },
      },
    };
    env.MCP_CONFIG_DATA = JSON.stringify(config);
    env.MCP_AUTO_CONNECT_SERVER = options.server.name;
  }

  if (options.defaultTab) {
    // Map public API "chat" to internal "chat-v2" tab
    const tab = options.defaultTab === "chat" ? "chat-v2" : options.defaultTab;
    env.MCP_INITIAL_TAB = tab;
  }

  if (options.verbose) {
    env.VERBOSE_LOGS = "true";
  }

  // Spawn the process
  const child = spawn("node", [binPath], {
    env,
    stdio: "inherit",
    detached: false,
  });

  // Wait for server to be ready, racing against spawn errors
  await new Promise<void>((resolve, reject) => {
    let resolved = false;

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to spawn inspector process: ${err.message}`));
      }
    });

    waitForServer(INSPECTOR_PORT)
      .then(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      })
      .catch((err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
  });

  const tabHash = options.defaultTab
    ? `#${options.defaultTab === "chat" ? "chat-v2" : options.defaultTab}`
    : "";
  const url = `http://localhost:${INSPECTOR_PORT}${tabHash}`;

  return {
    url,
    process: child,
    stop: async () => {
      child.kill("SIGTERM");
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if SIGTERM didn't work
          child.kill("SIGKILL");
          resolve();
        }, 5000);

        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}
