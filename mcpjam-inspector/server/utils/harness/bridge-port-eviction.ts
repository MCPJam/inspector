/**
 * Free the harness bridge port before a fresh bridge binds it.
 *
 * Every harness bridge on a computer binds the same port (the session's
 * `ports[0]`, 39271 by default), and a bridge outlives its turn: it is left
 * running so an approval continuation can reattach to the turn paused inside
 * it. A bridge some other session left behind — a different chat on the same
 * computer, a forked session, a turn whose server went away mid-flight — still
 * holds the port when the next fresh bridge starts, and that one then dies on
 * EADDRINUSE before it is ever ready.
 *
 * Evicting it is safe because the backend reserves a computer for ONE harness
 * run at a time: when a fresh bridge is about to start, any bridge already
 * listening is idle. Its session loses nothing it cannot rebuild — the
 * conversation lives on disk (Claude Code's session file, Codex's rollout) and
 * its next turn respawns a bridge of its own.
 *
 * Only a process that is BOTH listening on the port AND running a `bridge.mjs`
 * is signalled. Anything else on the port is left alone, and the fresh bridge
 * fails visibly exactly as it did before. The listener is found through `/proc`
 * with `node` — the one runtime every box that runs a bridge is guaranteed to
 * have — rather than `fuser`, `ss` or `lsof`, which a custom environment image
 * need not ship. SIGTERM first (the bridge installs no handler, so it exits at
 * once), then SIGKILL for anything still holding the port after the grace.
 *
 * The command prints the evicted pids, space-separated, and nothing when the
 * port was already free. It always exits 0: eviction is best-effort, and a
 * bridge that still cannot bind reports that itself.
 */

/** How long a SIGTERM'd bridge gets to release the port before SIGKILL. */
export const BRIDGE_EVICTION_GRACE_MS = 3_000;

// Kept free of single quotes: it travels inside one (`node -e '…'`).
const EVICTION_SCRIPT = String.raw`
const fs = require("fs");
const port = Number(process.argv[1]);
const suffix = ":" + port.toString(16).toUpperCase().padStart(4, "0");
const listening = () => {
  const sockets = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let rows = [];
    try { rows = fs.readFileSync(table, "utf8").split("\n").slice(1); } catch {}
    for (const row of rows) {
      const cols = row.trim().split(/ +/);
      if (cols.length > 9 && cols[3] === "0A" && cols[1].endsWith(suffix)) sockets.add("socket:[" + cols[9] + "]");
    }
  }
  return sockets;
};
const held = listening();
const pids = [];
if (held.size > 0) {
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(pid) || Number(pid) === process.pid) continue;
    let fds;
    try {
      if (!fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").includes("bridge.mjs")) continue;
      fds = fs.readdirSync("/proc/" + pid + "/fd");
    } catch { continue; }
    const holds = fds.some((fd) => {
      try { return held.has(fs.readlinkSync("/proc/" + pid + "/fd/" + fd)); } catch { return false; }
    });
    if (holds) pids.push(Number(pid));
  }
}
const signal = (name) => {
  for (const pid of pids) { try { process.kill(pid, name); } catch {} }
};
const deadline = Date.now() + Number(process.argv[2]);
const settle = () => {
  const stillHeld = [...listening()].some((socket) => held.has(socket));
  if (stillHeld && Date.now() < deadline) return void setTimeout(settle, 50);
  if (stillHeld) signal("SIGKILL");
  console.log(pids.join(" "));
};
if (pids.length > 0) {
  signal("SIGTERM");
  settle();
}
`;

/** The shell command that evicts whatever harness bridge listens on `port`. */
export function evictBridgePortCommand(
  port: number,
  graceMs: number = BRIDGE_EVICTION_GRACE_MS,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`not a TCP port: ${port}`);
  }
  if (!Number.isInteger(graceMs) || graceMs < 0) {
    throw new Error(`not a grace period: ${graceMs}`);
  }
  return `node -e '${EVICTION_SCRIPT}' ${port} ${graceMs}`;
}

/**
 * The port a spawn is about to bind a bridge to, or `undefined` for any other
 * command. Both bridges this inspector launches — Claude Code's and Codex
 * app-server's — receive it as `BRIDGE_WS_PORT`.
 */
export function bridgePortOf(
  env: Record<string, string> | undefined,
): number | undefined {
  const raw = env?.BRIDGE_WS_PORT;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : undefined;
}
