import { spawn, ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);

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
   * Options: "servers", "tools", "resources", "prompts", "chat", "playground"
   */
  defaultTab?: string;

  /**
   * Add HTTP request logs to the inspector's output.
   */
  verbose?: boolean;

  /**
   * Keep the inspector's output out of your terminal. If the inspector fails
   * to start, the rejected error includes the end of its stderr.
   */
  silent?: boolean;

  /**
   * Content Security Policy mode for the App Builder sandbox.
   * - "permissive": disables CSP enforcement for easier development (default)
   * - "widget-declared": enforces CSP directives declared by the widget
   */
  cspMode?: "permissive" | "widget-declared";
}

/**
 * Handle for a running MCP Inspector instance.
 */
export interface InspectorInstance {
  /**
   * The URL where the inspector is running, including its session token
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
async function waitForServer(
  port: number,
  signal: AbortSignal,
  timeout = 30000,
): Promise<void> {
  const start = Date.now();
  while (!signal.aborted && Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, { signal });
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise<void>((r) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        r();
      };
      const timer = setTimeout(done, 100);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  if (signal.aborted) return;
  throw new Error(`Inspector failed to start within ${timeout}ms`);
}

const STDERR_TAIL_CHARS = 4000;

function createSessionToken(env: Record<string, string>): string | undefined {
  if (env.VITE_MCPJAM_HOSTED_MODE === "true") return undefined;
  return env.MCPJAM_SESSION_TOKEN ?? randomBytes(24).toString("base64url");
}

function accessLinkHash(token: string | undefined, tab: string | undefined) {
  if (token) {
    return `#${new URLSearchParams({ token, ...(tab ? { tab } : {}) })}`;
  }
  return tab ? `#${tab}` : "";
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
const INSPECTOR_PORT = 6274;

export async function launchInspector(
  options: LaunchOptions = {},
): Promise<InspectorInstance> {
  const packageJsonPath = require.resolve("@mcpjam/inspector/package.json");
  const binPath = path.resolve(path.dirname(packageJsonPath), "bin/start.js");

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

  // Map public API "chat" to internal "chat-v2" tab
  const tab = options.defaultTab === "chat" ? "chat-v2" : options.defaultTab;
  if (tab) {
    env.MCP_INITIAL_TAB = tab;
  }

  const token = createSessionToken(env);
  if (token) {
    env.MCPJAM_SESSION_TOKEN = token;
  }

  if (options.verbose) {
    env.VERBOSE_LOGS = "true";
  }

  if (options.cspMode) {
    env.MCP_CSP_MODE = options.cspMode;
  }

  // Spawn the process
  const child = spawn("node", [binPath], {
    env,
    stdio: options.silent ? ["ignore", "ignore", "pipe"] : "inherit",
    detached: false,
  });

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  const withStderr = (message: string) =>
    stderrTail.trim()
      ? `${message}\nInspector stderr:\n${stderrTail.trimEnd()}`
      : message;

  // Wait for server to be ready, racing against spawn errors
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    const readiness = new AbortController();

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        readiness.abort();
        reject(new Error(`Failed to spawn inspector process: ${err.message}`));
      }
    });

    child.once("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        readiness.abort();
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        reject(
          new Error(
            withStderr(`Inspector exited before it was ready (${reason})`),
          ),
        );
      }
    });

    waitForServer(INSPECTOR_PORT, readiness.signal)
      .then(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      })
      .catch((err: Error) => {
        if (!resolved) {
          resolved = true;
          child.kill("SIGTERM");
          reject(new Error(withStderr(err.message)));
        }
      });
  });

  const url = `http://localhost:${INSPECTOR_PORT}/${accessLinkHash(token, tab)}`;

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
