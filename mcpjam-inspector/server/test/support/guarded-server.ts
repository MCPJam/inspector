/**
 * Boot the real standalone server (`server/index.ts`) in a child process under
 * the deny-mode network guard (`deny-network.mjs`), for tests that prove what
 * the server does or does not dial at start, in use, and at shutdown.
 *
 * The child runs from a scratch directory that is also its HOME, with an
 * environment built from scratch: nothing from the test runner's shell (a CI
 * `DO_NOT_TRACK`, a developer's `.env`) can change what is being proven. It
 * serves a minimal `dist/client/index.html` so document responses, and the
 * runtime config injected into them, are real.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));
const INSPECTOR_DIR = resolve(SUPPORT_DIR, "..", "..", "..");
const GUARD = join(SUPPORT_DIR, "deny-network.mjs");
/** By URL: the child runs from a scratch directory that cannot resolve it. */
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;

export interface NetworkAttempt {
  via: string;
  target: string;
}

export interface GuardedServer {
  baseUrl: string;
  /** Files the test placed in the scratch directory, by name. */
  path(name: string): string;
  /** Every refused non-loopback attempt so far. */
  attempts(): NetworkAttempt[];
  /** SIGTERM, then the exit code once the graceful shutdown has run. */
  stop(): Promise<number | null>;
  /** What the child wrote, for failure messages. */
  output(): string;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  output: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode}) before it was ready:\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`server was not ready within ${timeoutMs}ms:\n${output()}`);
}

export async function startGuardedServer(options: {
  /** Added to the hosted-mode baseline below; `undefined` unsets a baseline key. */
  env?: Record<string, string | undefined>;
  /** Files to write into the scratch directory before boot, by name. */
  files?: Record<string, string>;
  readyTimeoutMs?: number;
}): Promise<GuardedServer> {
  const scratch = mkdtempSync(join(tmpdir(), "mcpjam-guarded-server-"));
  mkdirSync(join(scratch, "dist", "client"), { recursive: true });
  writeFileSync(
    join(scratch, "dist", "client", "index.html"),
    "<!doctype html><html><head><title>MCPJam Inspector</title></head><body></body></html>",
  );
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    writeFileSync(join(scratch, name), contents);
  }
  const log = join(scratch, "network-attempts.jsonl");
  const port = await freePort();

  const env: Record<string, string> = {};
  const baseline: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: scratch,
    TMPDIR: tmpdir(),
    NODE_ENV: "production",
    ENVIRONMENT: "prod",
    VITE_MCPJAM_HOSTED_MODE: "true",
    // The environment below IS the configuration: no `.env` file is read.
    MCPJAM_RESOLVED_RUNTIME: "1",
    // Required to boot; a closed loopback port, so the backend is unreachable
    // without the guard having anything to refuse.
    CONVEX_HTTP_URL: "http://127.0.0.1:9",
    SERVER_PORT: String(port),
    TSX_TSCONFIG_PATH: join(INSPECTOR_DIR, "server", "tsconfig.json"),
    MCPJAM_NET_GUARD_LOG: log,
    ...options.env,
  };
  for (const [key, value] of Object.entries(baseline)) {
    if (value !== undefined) env[key] = value;
  }

  let output = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      GUARD,
      "--import",
      TSX_LOADER,
      join(INSPECTOR_DIR, "server", "index.ts"),
    ],
    { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code)),
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child, () => output, options.readyTimeoutMs ?? 90_000);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    path: (name) => join(scratch, name),
    attempts: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as NetworkAttempt)
        : [],
    output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      const code = await exited;
      return code;
    },
  };
}

/** Remove a scratch directory once its attempts have been read. */
export function removeScratch(server: GuardedServer): void {
  rmSync(dirname(server.path("network-attempts.jsonl")), {
    recursive: true,
    force: true,
  });
}
