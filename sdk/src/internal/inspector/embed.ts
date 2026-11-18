import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  inspectorAttachId,
  releaseInspectorAttach,
  requestInspectorAttach,
  waitForInspectorReleases,
  type InspectorAttachServer,
  type InspectorAttachState,
} from "./attach-client.js";
import { isInspectorError, operationalError } from "./errors.js";
import { holdInspector, inspectorHoldersDir, otherInspectorHolders } from "./holders.js";
import { delay, openUrl } from "./launch.js";
import { DEFAULT_INSPECTOR_PORT, choosePort, isPortFree } from "./ports.js";
import {
  clearInspectorSessionTokenCache,
  fetchInspectorSessionToken,
} from "./session-token.js";

const READY_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_CHARS = 4_000;
const OUTPUT_DRAIN_MS = 1_000;
const STOP_TIMEOUT_MS = 5_000;
/** A tab applies a release on its next poll (every 2 s), then removes the server. */
const RELEASE_WAIT_MS = 6_000;
/** How long a launch waits for a dev command that is starting MCPJam right now. */
const START_RACE_WAIT_MS = 4_000;
const LOG_MAX_BYTES = 1024 * 1024;

export interface EmbedInspectorOptions {
  /** The command that starts MCPJam (`node <inspector>/bin/start.js`). */
  start: { command: string; args: string[] };
  /** Preferred port; the next free one is used when it is taken. */
  port?: number;
  /** Fail instead of moving to another port. */
  strictPort?: boolean;
  /**
   * Reuse this user's MCPJam already running on the preferred port, and
   * share the one this launch starts: it stays up while any dev command
   * holds it and stops when the last one quits.
   */
  reuse?: boolean;
  /** Keep MCPJam's output out of the caller's terminal. */
  silent?: boolean;
  /** Extra environment for a started MCPJam. */
  env?: Record<string, string>;
  /** Tab to open, already validated by the caller. */
  tab?: string;
  /**
   * Open the access link in the browser when this launch starts MCPJam.
   * A reused MCPJam is never reopened. Defaults to false.
   */
  open?: boolean;
  /** Told when something degrades but the launch still works. */
  onWarning?: (message: string) => void;
  readyTimeoutMs?: number;
  /** How long `stop()` waits for a tab to undo this launch's servers. */
  releaseWaitMs?: number;
  /** How long a launch waits for a dev command that is starting MCPJam right now. */
  startRaceWaitMs?: number;
}

export interface EmbeddedInspector {
  /** Access link, with the session token and tab in its hash. */
  url: string;
  baseUrl: string;
  port: number;
  /** False when an MCPJam that was already running was reused. */
  started: boolean;
  /** The started MCPJam's process; absent when one was reused. */
  process?: ChildProcess;
  /**
   * Hands a server to an open tab, which saves it to a project, connects it
   * and selects it. Resolves once MCPJam has the request.
   */
  connect(server: InspectorAttachServer): Promise<InspectorAttachState>;
  /** Undoes this launch's attaches and lets go of MCPJam. */
  stop(): Promise<void>;
}

/**
 * Starts MCPJam for a dev command, or reuses the one already running, the
 * engine behind `launchInspector()` and the Vite plugin.
 */
export async function embedInspector(
  options: EmbedInspectorOptions,
): Promise<EmbeddedInspector> {
  const preferred = options.port ?? DEFAULT_INSPECTOR_PORT;
  const raceWaitMs = options.startRaceWaitMs ?? START_RACE_WAIT_MS;
  let warned = false;
  const hold = (port: number) => {
    const release = holdInspector(port);
    if (!release && !warned) {
      warned = true;
      options.onWarning?.(
        `Could not share MCPJam with other dev commands: ${inspectorHoldersDir(port)} is not writable. MCPJam stops when this command quits.`,
      );
    }
    return release;
  };

  // Held before the reuse check, so the MCPJam found never sees zero holders.
  const reuseRunning = async (port: number, waitMs: number) => {
    const release = hold(port);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const token = await reusableToken(port);
      if (token) {
        return handle({ port, token, started: false, release, options });
      }
      if (Date.now() >= deadline) break;
      await delay(250);
    }
    release?.();
    return undefined;
  };

  if (options.reuse) {
    const running = await reuseRunning(preferred, 0);
    if (running) return running;
    if (!(await isPortFree(preferred)) && otherInspectorHolders(preferred) > 0) {
      // Two dev commands started together (for example `turbo dev`) both look
      // for MCPJam before either has bound the port. A live holder file means
      // another dev command is bringing it up, so give it a moment before
      // treating the busy port as another program's. With no holder there is
      // nothing to wait for.
      const joined = await reuseRunning(preferred, raceWaitMs);
      if (joined) return joined;
    }
  }

  const port = await choosePort({ preferred, strictPort: options.strictPort });
  const env = { ...stringEnv(process.env), ...options.env };
  // A hosted-mode build has no session token; it is ready when /health is.
  const token =
    env.VITE_MCPJAM_HOSTED_MODE === "true"
      ? undefined
      : (env.MCPJAM_SESSION_TOKEN ?? randomBytes(24).toString("base64url"));
  // Written before the spawn, so the new MCPJam's watchdog finds its starter.
  const release = options.reuse ? hold(port) : undefined;
  const held = release !== undefined;
  let child: ChildProcess;
  try {
    child = await startAndWait({ options, env, port, token, held });
  } catch (error) {
    release?.();
    if (options.reuse && exitedEarly(error)) {
      // Lost the race to start on this port; the winner is the MCPJam to join.
      const joined = await reuseRunning(port, raceWaitMs * 2);
      if (joined) return joined;
    }
    throw error;
  }
  const inspector = handle({ port, token, started: true, release, options, child, held });
  if (held && options.open) openUrl(inspector.url);
  return inspector;
}

function exitedEarly(error: unknown): boolean {
  if (!isInspectorError(error)) return false;
  const { details } = error;
  return typeof details === "object" && details !== null && "earlyExit" in details;
}

async function reusableToken(port: number): Promise<string | undefined> {
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    // A cached token can outlive the MCPJam it was read from (up to 5 minutes).
    clearInspectorSessionTokenCache(baseUrl);
    return await fetchInspectorSessionToken(baseUrl);
  } catch {
    // No MCPJam of this user's on the port: anything there is another program.
    return undefined;
  }
}

function accessLink(baseUrl: string, token: string | undefined, tab: string | undefined) {
  if (!token) return `${baseUrl}/${tab ? `#${tab}` : ""}`;
  return `${baseUrl}/#${new URLSearchParams({ token, ...(tab ? { tab } : {}) })}`;
}

function handle(args: {
  port: number;
  token: string | undefined;
  started: boolean;
  release: (() => boolean) | undefined;
  options: EmbedInspectorOptions;
  child?: ChildProcess;
  held?: boolean;
}): EmbeddedInspector {
  const { port, token, started, release, options, child } = args;
  const baseUrl = `http://localhost:${port}`;
  const apiBase = `http://127.0.0.1:${port}`;
  const attached = new Set<string>();
  let stopped = false;

  return {
    url: accessLink(baseUrl, token, options.tab),
    baseUrl,
    port,
    started,
    ...(child ? { process: child } : {}),
    async connect(server) {
      const attachId = inspectorAttachId(process.pid, port, server);
      const state = await requestInspectorAttach(apiBase, token, {
        attachId,
        server,
        pid: process.pid,
      });
      attached.add(attachId);
      return state;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const attachIds = [...attached];
      await Promise.all(
        attachIds.map((attachId) => releaseInspectorAttach(apiBase, token, attachId)),
      );
      // True while another launch in this process still holds the same MCPJam.
      const heldHere = release?.() ?? false;
      if (!child || heldHere) return;
      // A shared MCPJam stays up for the other dev commands still holding it.
      if (args.held && otherInspectorHolders(port) > 0) return;
      // Releasing only queues the undo; a tab applies it on its next poll. If
      // MCPJam stopped first, the server this launch added would stay saved.
      await waitForInspectorReleases(
        apiBase,
        token,
        attachIds,
        options.releaseWaitMs ?? RELEASE_WAIT_MS,
      );
      await stopChild(child);
    },
  };
}

async function startAndWait(args: {
  options: EmbedInspectorOptions;
  env: Record<string, string>;
  port: number;
  token: string | undefined;
  held: boolean;
}): Promise<ChildProcess> {
  const { options, port, token, held } = args;
  const env: Record<string, string> = {
    ...args.env,
    ...(token ? { MCPJAM_SESSION_TOKEN: token } : {}),
    ...(options.tab ? { MCP_INITIAL_TAB: options.tab } : {}),
  };
  let logFile: string | undefined;
  let logFd: number | undefined;
  if (held) {
    // A shared MCPJam outlives its starter, so it cannot write to the
    // starter's terminal or pipes; its output goes to a log file instead.
    env.MCPJAM_INSPECTOR_HOLDERS_DIR = inspectorHoldersDir(port);
    env.MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK = "1";
    // start.js prints the access link, session token included, unless auto
    // open is suppressed; the log stays on disk after MCPJam exits, so the
    // link must never reach it. The engine opens the browser itself.
    env.MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN = "1";
    logFile = path.join(os.homedir(), ".mcpjam", "inspector", `${port}.log`);
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    logFd = openStartupLog(logFile);
  }
  const child = spawn(
    options.start.command,
    [
      ...options.start.args,
      "--port",
      String(port),
      // A shared MCPJam is opened by the engine; otherwise start.js opens it.
      ...(!held && !options.open ? ["--no-open"] : []),
    ],
    {
      env,
      detached: held,
      stdio:
        logFd !== undefined
          ? ["ignore", logFd, logFd]
          : options.silent
            ? ["ignore", "pipe", "pipe"]
            : "inherit",
    },
  );
  if (logFd !== undefined) closeSync(logFd);
  if (held) child.unref();

  // Both pipes stay drained for MCPJam's whole life so a full pipe never blocks it.
  let tail = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
    });
  }
  const withOutput = (message: string) => {
    let output = logFile ? readTail(logFile) : tail;
    output = stripVTControlCharacters(output);
    if (token) output = output.split(token).join("<session token>");
    output = output.trim();
    return output ? `${message}\nInspector output:\n${output}` : message;
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const readiness = new AbortController();
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      readiness.abort();
      fn();
    };
    child.once("error", (error) =>
      settle(() => reject(operationalError(`Could not start MCPJam: ${error.message}`))),
    );
    child.once("exit", (code, signal) =>
      settle(() => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        void waitForClose(child, OUTPUT_DRAIN_MS).then(() =>
          reject(
            operationalError(withOutput(`MCPJam exited before it was ready (${reason}).`), {
              earlyExit: true,
            }),
          ),
        );
      }),
    );
    waitForReady(port, token, readiness.signal, options.readyTimeoutMs ?? READY_TIMEOUT_MS).then(
      (ready) => {
        if (ready) {
          settle(resolve);
          return;
        }
        settle(() => {
          child.kill("SIGTERM");
          reject(
            operationalError(
              withOutput(
                `MCPJam did not start within ${options.readyTimeoutMs ?? READY_TIMEOUT_MS}ms.`,
              ),
            ),
          );
        });
      },
    );
  });
  return child;
}

/**
 * Ready when the server on the port confirms this launch's token, so an
 * MCPJam already listening there answers 401 and is never mistaken for it.
 */
async function waitForReady(
  port: number,
  token: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  const url = token
    ? `http://127.0.0.1:${port}/api/session-token`
    : `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: token ? { "X-MCP-Session-Auth": `Bearer ${token}` } : undefined,
        signal,
      });
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(100, signal);
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function waitForClose(child: ChildProcess, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Appends, so a launch that loses a race to start MCPJam cannot truncate the
 * winner's log, and rotates past 1 MiB. The mode is set explicitly because
 * `openSync` keeps the mode of a file that already exists.
 */
function openStartupLog(file: string): number {
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or it could not be rotated: appending still works.
  }
  const fd = openSync(file, "a", 0o600);
  chmodSync(file, 0o600);
  return fd;
}

function readTail(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(-OUTPUT_TAIL_CHARS);
  } catch {
    // The log is only context for the error that is being reported.
    return "";
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
