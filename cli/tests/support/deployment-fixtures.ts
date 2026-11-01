/**
 * Process-test fixtures for "which MCPJam server": loopback servers that
 * record every request, and a runner that starts the BUILT CLI (or an SDK
 * child script) under the network guard with nothing inherited from this
 * machine: its own home, no proxy, and no opt-out variables unless a test sets
 * them.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_ENTRY = path.resolve(here, "../../dist/index.js");
const GUARD = pathToFileURL(path.resolve(here, "network-guard.mjs")).href;

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type Route = (
  request: RecordedRequest,
  response: ServerResponse,
) => void | Promise<void>;

export type Recorder = {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** A loopback server that records each request and answers from `routes`. */
export async function startRecorder(
  routes: Record<string, Route> = {},
  host = "127.0.0.1",
): Promise<Recorder> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: await readBody(request),
    };
    requests.push(recorded);
    const pathname = new URL(recorded.path, "http://fixture").pathname;
    const route =
      routes[`${recorded.method} ${pathname}`] ??
      Object.entries(routes).find(
        ([key]) => key.endsWith("*") && `${recorded.method} ${pathname}`.startsWith(key.slice(0, -1)),
      )?.[1];
    if (!route) {
      json(response, 404, { code: "NOT_FOUND", message: `No fixture for ${pathname}` });
      return;
    }
    await route(recorded, response);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server has no address");
  }
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type Sandbox = {
  home: string;
  authFile: string;
  netLog: string;
  remove(): Promise<void>;
};

export async function createSandbox(): Promise<Sandbox> {
  const home = await mkdtemp(path.join(os.tmpdir(), "mcpjam-deployment-"));
  return {
    home,
    authFile: path.join(home, ".config", "mcpjam", "auth.json"),
    netLog: path.join(home, "net.log"),
    remove: () => rm(home, { recursive: true, force: true }),
  };
}

/** A saved login, as `mcpjam cloud login` writes it, for `apiUrl`. */
export async function writeSavedLogin(
  sandbox: Sandbox,
  apiUrl: string | undefined,
  accessToken = "saved-login-token",
): Promise<void> {
  await mkdir(path.dirname(sandbox.authFile), { recursive: true });
  await writeFile(
    sandbox.authFile,
    JSON.stringify({
      version: 1,
      issuer: "https://login.fixture.test",
      clientId: "client_fixture",
      tokenEndpoint: "https://login.fixture.test/oauth/token",
      accessToken,
      refreshToken: "saved-refresh",
      expiresAt: Date.now() + 3_600_000,
      ...(apiUrl ? { apiUrl } : {}),
    }),
    { mode: 0o600 },
  );
}

export type Attempt = {
  pid: number;
  kind: string;
  host?: string;
  port?: number;
  command?: string;
};

export async function readAttempts(sandbox: Sandbox): Promise<Attempt[]> {
  let text: string;
  try {
    text = await readFile(sandbox.netLog, "utf8");
  } catch (error) {
    // No log file means the guard never had anything to record.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Attempt);
}

/** Blocked network attempts only: spawns are logged but are not traffic. */
export async function blockedAttempts(sandbox: Sandbox): Promise<Attempt[]> {
  return (await readAttempts(sandbox)).filter(
    (attempt) => attempt.kind === "connect" || attempt.kind === "dns",
  );
}

/** Polls the guard log until `found` holds, for the detached update check. */
export async function waitForAttempts(
  sandbox: Sandbox,
  found: (attempts: Attempt[]) => boolean,
  timeoutMs = 10_000,
): Promise<Attempt[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempts = await readAttempts(sandbox);
    if (found(attempts) || Date.now() > deadline) return attempts;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type GuardedRun = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type GuardedOptions = {
  sandbox: Sandbox;
  /** Loopback ports the process may reach. */
  allow: number[];
  env?: Record<string, string>;
  /** Reads stderr as it arrives, e.g. to finish a login. */
  onStderr?: (text: string) => void;
  /** Defaults to the sandbox home. */
  cwd?: string;
  /** The Node binary to run, for checks on other Node versions. */
  node?: string;
  timeoutMs?: number;
};

/**
 * Starts `node <entry> ...args` with the guard loaded and an environment built
 * from nothing, so this machine's proxy, CI and opt-out variables cannot
 * change what the product does.
 */
export function runGuarded(
  entry: string,
  args: string[],
  options: GuardedOptions,
): Promise<GuardedRun> {
  const { sandbox } = options;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    XDG_CONFIG_HOME: path.join(sandbox.home, ".config"),
    XDG_CACHE_HOME: path.join(sandbox.home, ".cache"),
    APPDATA: path.join(sandbox.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(sandbox.home, "AppData", "Local"),
    NODE_OPTIONS: `--import=${GUARD}`,
    MCPJAM_TEST_NET_LOG: sandbox.netLog,
    MCPJAM_TEST_NET_ALLOW: options.allow.join(","),
    ...options.env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(options.node ?? process.execPath, [entry, ...args], {
      env,
      cwd: options.cwd ?? sandbox.home,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(stderr);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out: ${args.join(" ")}\n${stderr}`));
    }, options.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/** The structured error the CLI writes to stderr on failure. */
export function errorCode(run: GuardedRun): string | undefined {
  const line = run.stderr
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return undefined;
  try {
    return (JSON.parse(line) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}
