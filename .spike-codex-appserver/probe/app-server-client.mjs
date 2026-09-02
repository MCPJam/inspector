// Minimal JSONL JSON-RPC client for `codex app-server`, with no dependencies.
//
// This is the WS0 probe AND the fixture recorder: every frame in both
// directions is appended to an NDJSON log, which the adapter's translator tests
// replay. Deliberately not shared with the shipped bridge — the bridge is
// typed, bundled and lives in server/utils/harness/codex-appserver; this stays
// a scratch instrument so a probe change can never move production behaviour.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Spawn `codex app-server` and speak JSON-RPC over its stdio. */
export function spawnAppServer({
  codexBin,
  /** argv to place before `app-server`, for an `npx <pkg>` style invocation. */
  prefixArgs = [],
  codexHome,
  cwd = process.cwd(),
  env = {},
  logPath,
  onNotification = () => {},
  onServerRequest = async () => ({ error: "unhandled" }),
  onStderr = () => {},
}) {
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    // TRUNCATE. These logs are evidence, and appending across runs let a stale
    // run's frames into the next run's counts — the one thing a rig that exists
    // to be re-run must not do.
    writeFileSync(logPath, "");
  }
  const log = (direction, frame) => {
    if (!logPath) return;
    appendFileSync(
      logPath,
      `${JSON.stringify({ t: Date.now(), direction, frame })}\n`
    );
  };

  const child = spawn(codexBin, [...prefixArgs, "app-server"], {
    cwd,
    env: { ...process.env, ...env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let nextId = 1;
  let dead = null;
  let stdout = "";

  const send = (frame) => {
    log("out", frame);
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  const handle = (frame) => {
    log("in", frame);
    // A frame with both id and method is a SERVER REQUEST; method alone is a
    // notification; id alone is a response to one of ours.
    if (frame.id !== undefined && frame.method !== undefined) {
      Promise.resolve(onServerRequest(frame)).then(
        (result) => send({ jsonrpc: "2.0", id: frame.id, result }),
        (error) =>
          send({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32603, message: String(error?.message ?? error) },
          })
      );
      return;
    }
    if (frame.method !== undefined) {
      onNotification(frame);
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)));
    else entry.resolve(frame.result);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let index;
    while ((index = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        onStderr(`[unparsed stdout] ${line}`);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => onStderr(chunk));
  const die = (error) => {
    if (dead) return;
    dead = error;
    for (const entry of pending.values()) entry.reject(dead);
    pending.clear();
  };
  child.on("exit", (code, signal) => {
    die(new Error(`codex app-server exited (code=${code} signal=${signal})`));
  });
  // A binary that cannot be spawned emits `error`, never `exit`. Without this
  // the gate hung forever on its first request instead of reporting ENOENT.
  child.on("error", (error) => {
    die(new Error(`codex app-server failed to start: ${String(error)}`));
  });
  child.stdin.on("error", () => {
    // A closed pipe must not become an uncaught exception; `exit`/`error`
    // above are what report the failure.
  });

  return {
    child,
    request(method, params) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      child.kill("SIGTERM");
      // BOUNDED, with escalation: a child that ignores SIGTERM would otherwise
      // hang the gate runner or the fixture recorder indefinitely.
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      force.unref?.();
      try {
        await new Promise((resolve) => {
          if (child.exitCode !== null) resolve();
          else child.once("exit", resolve);
        });
      } finally {
        clearTimeout(force);
      }
    },
  };
}

/** initialize + initialized, the handshake every other method requires. */
export async function initialize(client, clientInfo = {}) {
  const result = await client.request("initialize", {
    clientInfo: {
      name: "mcpjam-appserver-probe",
      title: "MCPJam app-server probe",
      version: "0.0.0",
      ...clientInfo,
    },
  });
  client.notify("initialized", {});
  return result;
}

/** Wait for `turn/completed` (or a fatal `error`) on a thread. */
export function turnCompletion(events, threadId) {
  return new Promise((resolve, reject) => {
    events.on("notification", function listener(frame) {
      if (frame.params?.threadId !== threadId) return;
      if (frame.method === "turn/completed") {
        events.off("notification", listener);
        resolve(frame.params.turn);
      }
      if (frame.method === "error" && frame.params?.willRetry === false) {
        events.off("notification", listener);
        reject(new Error(frame.params?.error?.message ?? "turn failed"));
      }
    });
  });
}
