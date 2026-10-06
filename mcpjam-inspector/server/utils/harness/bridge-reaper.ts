/**
 * Stop the harness bridges on a computer that nothing will reattach to, right
 * before a fresh bridge starts.
 *
 * A bridge outlives its turn (E2B no longer kills it after a minute), and each
 * one binds its own OS-assigned port, so bridges never collide — but nothing
 * would ever stop the ones no turn will use again. Before every bridge spawn
 * this stops:
 *
 *  - every older bridge of the session that is spawning (same
 *    `--bridge-state-dir`): the new bridge supersedes it. If that one was
 *    paused on an approval, the user sent a new message instead of deciding,
 *    so the approval is void;
 *  - every other bridge that is between turns — its `bridge-meta.json` says
 *    `waiting` (or `starting`/`init`/`done`), or names a different pid, which
 *    means a newer bridge of that session replaced it. A between-turns session
 *    loses nothing: its next turn resumes from disk on a fresh bridge
 *    (`diskResumeState`).
 *
 * It never stops a bridge whose meta says `running`. The backend reserves a
 * computer for one harness run at a time, so while a bridge is being spawned
 * no other turn is executing — a `running` bridge is a turn PAUSED for a tool
 * approval, and that turn lives only in that process: the decision is applied
 * by reattaching to it. A bridge whose meta cannot be read is kept too; when in
 * doubt, a leaked process until the computer hibernates beats a lost approval.
 *
 * Only harness bridges are considered: processes running a `…/bridge.mjs`
 * whose `--bridge-state-dir` sits in the same sessions root as the spawning
 * bridge's (`<home>/.agent-runs/<session>/bridge` for both the Claude Code and
 * the Codex app-server bridge, which also share `runBridge` and its meta
 * file). They are found through `/proc` with `node` — the one runtime every
 * box that runs a bridge is guaranteed to have.
 *
 * SIGTERM first (the bridge installs no handler, so it exits at once), then
 * SIGKILL for anything still alive after the grace period.
 *
 * The command prints the stopped pids, space-separated, and nothing when there
 * was nothing to stop. It always exits 0: reaping is housekeeping, never a
 * reason to fail a turn.
 */

import { posix } from "node:path";

/** How long a SIGTERM'd bridge gets to exit before SIGKILL. */
export const BRIDGE_REAP_GRACE_MS = 3_000;

// Kept free of single quotes: it travels inside one (`node -e '…'`).
const REAPER_SCRIPT = String.raw`
const fs = require("fs");
const own = process.argv[1];
const sessionsRoot = process.argv[2];
const graceMs = Number(process.argv[3]);
const IDLE = new Set(["starting", "init", "waiting", "done"]);
let pids = [];
try { pids = fs.readdirSync("/proc").filter((p) => /^[0-9]+$/.test(p) && Number(p) !== process.pid); } catch {}
const reap = [];
for (const pid of pids) {
  let argv;
  try { argv = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0"); } catch { continue; }
  if (!argv.some((arg) => arg.endsWith("bridge.mjs"))) continue;
  const at = argv.indexOf("--bridge-state-dir");
  const dir = at >= 0 ? argv[at + 1] : "";
  if (!dir || !dir.startsWith(sessionsRoot)) continue;
  if (dir === own) { reap.push(Number(pid)); continue; }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(dir + "/bridge-meta.json", "utf8")); } catch { continue; }
  const superseded = typeof meta.pid === "number" && meta.pid !== Number(pid);
  if (superseded || IDLE.has(meta.state)) reap.push(Number(pid));
}
const alive = (pid) => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch { return false; }
};
const signal = (pids, name) => {
  for (const pid of pids) { try { process.kill(pid, name); } catch {} }
};
const deadline = Date.now() + graceMs;
const settle = () => {
  const left = reap.filter(alive);
  if (left.length > 0 && Date.now() < deadline) return void setTimeout(settle, 50);
  signal(left, "SIGKILL");
  console.log(reap.join(" "));
};
if (reap.length > 0) {
  signal(reap, "SIGTERM");
  settle();
}
`;

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command that reaps a computer's bridges before the bridge whose
 * state dir is `ownStateDir` starts. Its sessions root — two levels up — bounds
 * which bridges are considered at all.
 */
export function reapHarnessBridgesCommand(
  ownStateDir: string,
  graceMs: number = BRIDGE_REAP_GRACE_MS,
): string {
  if (!posix.isAbsolute(ownStateDir)) {
    throw new Error(`not an absolute bridge state dir: ${ownStateDir}`);
  }
  if (!Number.isInteger(graceMs) || graceMs < 0) {
    throw new Error(`not a grace period: ${graceMs}`);
  }
  const root = posix.dirname(posix.dirname(ownStateDir));
  const sessionsRoot = root.endsWith("/") ? root : `${root}/`;
  return [
    `node -e '${REAPER_SCRIPT}'`,
    shellSingleQuote(ownStateDir),
    shellSingleQuote(sessionsRoot),
    String(graceMs),
  ].join(" ");
}

/**
 * Whether a spawn starts a harness bridge. Both bridges this inspector
 * launches — Claude Code's and Codex app-server's — are told their port in
 * `BRIDGE_WS_PORT`.
 */
export function isBridgeSpawn(
  env: Record<string, string> | undefined,
): boolean {
  return env?.BRIDGE_WS_PORT !== undefined;
}

/**
 * The `--bridge-state-dir` a bridge spawn command names, as the adapters'
 * `shellQuote` wrote it (always single-quoted), or `undefined` if the command
 * does not carry one in that form.
 */
export function bridgeStateDirOf(command: string): string | undefined {
  const match = /--bridge-state-dir\s+'((?:[^']|'\\'')*)'/.exec(command);
  return match ? match[1]!.replace(/'\\''/g, "'") : undefined;
}
