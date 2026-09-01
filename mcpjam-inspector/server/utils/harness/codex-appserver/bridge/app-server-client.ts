/**
 * A JSON-RPC client for a `codex app-server` child process, over its stdio.
 *
 * The protocol is newline-delimited JSON in both directions, and all three
 * JSON-RPC shapes share the pipe. They are told apart by which fields are
 * present, which is worth stating because getting it wrong is silent:
 *
 *   id + method  -> a SERVER REQUEST. Codex is asking us something (an
 *                   approval) and will not proceed until we answer.
 *   method only  -> a notification. Fire and forget.
 *   id only      -> a response to one of ours.
 *
 * The failure this module is built around is a child that dies with requests in
 * flight. Codex blocks on an unanswered approval, and a bridge that leaves a
 * promise pending forever turns a crashed child into a hung turn with no error
 * anywhere. Every pending request is therefore rejected on exit, and the client
 * latches dead so later calls fail fast instead of queueing behind a corpse.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcFrame,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
} from "./app-server-protocol.js";

export class AppServerExitedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  constructor(
    code: number | null,
    signal: NodeJS.Signals | null,
    tail: string,
  ) {
    super(
      `codex app-server exited (code=${code ?? "null"} signal=${
        signal ?? "null"
      })` + (tail ? `: ${tail}` : ""),
    );
    this.name = "AppServerExitedError";
    this.code = code;
    this.signal = signal;
  }
}

export type AppServerClient = {
  request<TResult = unknown>(
    method: string,
    params?: unknown,
  ): Promise<TResult>;
  notify(method: string, params?: unknown): void;
  /** Replace the notification handler. */
  onNotification(handler: (notification: JsonRpcNotification) => void): void;
  /**
   * Replace the server-request handler. The resolved value becomes the JSON-RPC
   * `result`; a rejection becomes a JSON-RPC error, which Codex treats as a
   * failure of that request rather than of the connection.
   */
  onServerRequest(handler: (request: JsonRpcRequest) => Promise<unknown>): void;
  /** Resolves when the child has exited. */
  readonly exited: Promise<AppServerExitedError | undefined>;
  kill(): Promise<void>;
};

export function spawnAppServerClient(options: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderrLine?(line: string): void;
  onFrameError?(line: string, error: unknown): void;
}): AppServerClient {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.command,
    options.args ?? ["app-server"],
    { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;

  const pending = new Map<
    JsonRpcId,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  let nextId = 1;
  let dead: AppServerExitedError | undefined;
  let notificationHandler: (n: JsonRpcNotification) => void = () => {};
  let serverRequestHandler: (
    r: JsonRpcRequest,
  ) => Promise<unknown> = async () => {
    throw new Error("no server-request handler installed");
  };
  // Bounded: enough to make an exit diagnosable, not enough to hold a log.
  const stderrTail: string[] = [];

  const write = (frame: JsonRpcFrame) => {
    if (dead) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  };

  const handleFrame = (frame: JsonRpcFrame) => {
    const asRequest = frame as JsonRpcRequest;
    if (asRequest.id !== undefined && asRequest.method !== undefined) {
      void Promise.resolve()
        .then(() => serverRequestHandler(asRequest))
        .then(
          (result) => write({ id: asRequest.id, result }),
          (error: unknown) =>
            write({
              id: asRequest.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      return;
    }
    if ((frame as JsonRpcNotification).method !== undefined) {
      notificationHandler(frame as JsonRpcNotification);
      return;
    }
    const response = frame as {
      id: JsonRpcId;
      result?: unknown;
      error?: { message: string };
    };
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  };

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line) continue;
      try {
        handleFrame(JSON.parse(line) as JsonRpcFrame);
      } catch (error) {
        options.onFrameError?.(line, error);
      }
    }
  });

  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    let index: number;
    while ((index = stderrBuffer.indexOf("\n")) !== -1) {
      const line = stderrBuffer.slice(0, index);
      stderrBuffer = stderrBuffer.slice(index + 1);
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
      options.onStderrLine?.(line);
    }
  });

  let settleExit: (error: AppServerExitedError | undefined) => void = () => {};
  const exited = new Promise<AppServerExitedError | undefined>((resolve) => {
    settleExit = resolve;
  });

  const onGone = (code: number | null, signal: NodeJS.Signals | null) => {
    if (dead) return;
    dead = new AppServerExitedError(code, signal, stderrTail.join("\n"));
    for (const entry of pending.values()) entry.reject(dead);
    pending.clear();
    settleExit(dead);
  };
  child.on("exit", onGone);
  child.on("error", (error) => {
    if (dead) return;
    dead = new AppServerExitedError(null, null, String(error));
    for (const entry of pending.values()) entry.reject(dead);
    pending.clear();
    settleExit(dead);
  });

  return {
    request<TResult>(method: string, params?: unknown): Promise<TResult> {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise<TResult>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    onServerRequest(handler) {
      serverRequestHandler = handler;
    },
    exited,
    async kill() {
      if (dead) return;
      child.stdin.end();
      child.kill("SIGTERM");
      // SIGTERM is a request. A child that ignores it would hold the sandbox
      // open for the life of the box, so escalate rather than wait forever.
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
