/**
 * Platform primitives for owning a process TREE: proving a pid is still the
 * process we started, and terminating everything it spawned.
 *
 * ── Why a pid is not an identity ──────────────────────────────────────────
 * Pids are reused. A supervisor record that says "pid 4711 is our harness"
 * becomes a loaded gun the moment 4711 exits and the OS hands the number to
 * something else — after an Inspector restart, the janitor would cheerfully
 * SIGKILL a stranger's process tree. So every record carries a BIRTH IDENTITY
 * (the kernel's own start-time for that pid) alongside a supervisor nonce, and
 * cleanup only proceeds when the live process still presents the same birth
 * identity it did when we spawned it (invariant 12).
 *
 * ── Platform honesty ─────────────────────────────────────────────────────
 * Linux reads `/proc/<pid>/stat` — exact, cheap, no subprocess. macOS shells
 * out to `/bin/ps` for the start time, which is second-granular; combined with
 * the process's own argv-derived name that is good enough to refuse a wrong
 * kill, which is the property that matters. Windows has neither, and the Job
 * Object work that would give it a real answer is not implemented here, so
 * `readProcessBirthIdentity` returns null and every ownership question answers
 * "cannot prove" — which fails closed: nothing is adopted, nothing is killed
 * by the janitor, and Windows is not offered as a native platform in the
 * compatibility manifest.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Opaque, comparable string identifying "this exact process instance". */
export type ProcessBirthIdentity = string;

const PS_TIMEOUT_MS = 3_000;

/**
 * Parse a `/proc/<pid>/stat` line into the two fields that matter.
 *
 * Pure and exported because the field layout is fiddly — field 2 (`comm`) is
 * parenthesized and may itself contain spaces and parens, so the only reliable
 * split point is the LAST ')' — and because the ZOMBIE case is the one that
 * bites. `null` means "not a stat line we understand".
 */
export function parseLinuxProcStat(
  raw: string
): { state: string; starttime: string } | null {
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  const fields = raw.slice(close + 2).split(" ");
  // After `comm`, the remaining fields are 3..N: index 0 is `state` (field 3),
  // and `starttime` is field 22, i.e. index 19.
  const state = fields[0];
  const starttime = fields[19];
  if (!state || !/^[A-Za-z]$/.test(state)) return null;
  if (!starttime || !/^\d+$/.test(starttime)) return null;
  return { state, starttime };
}

/**
 * A ZOMBIE is a dead process. It has exited; only its exit status is still
 * held open because nothing has reaped it.
 *
 * This distinction is not academic, and getting it wrong is not merely a
 * cosmetic bug. `/proc/<pid>/stat` still exists for a zombie, so a liveness
 * check built on "can I read the stat file" reports a process that is already
 * dead as alive — and then `terminateOwnedProcessGroup` reports `escaped` for a
 * tree it successfully killed, `stopSession` refuses to report the session
 * stopped, and the janitor never reclaims the record.
 *
 * Whether this is ever observed depends entirely on the environment. When PID 1
 * reaps orphans, a killed descendant vanishes almost immediately and nothing
 * looks wrong. Inside a container whose PID 1 is an application rather than a
 * real init — which is where CI runs — orphaned zombies persist indefinitely.
 * So this is checked, not assumed.
 */
function isDeadState(state: string): boolean {
  // `Z` is a zombie; `X`/`x` are the (rarely observed) dead states.
  return state === "Z" || state === "X" || state === "x";
}

async function readLinuxBirthIdentity(
  pid: number
): Promise<ProcessBirthIdentity | null> {
  try {
    const parsed = parseLinuxProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (parsed === null) return null;
    if (isDeadState(parsed.state)) return null;
    return `linux:${parsed.starttime}`;
  } catch {
    return null;
  }
}

/**
 * Parse `ps -o state=,lstart=` output.
 *
 * macOS decorates the state with modifiers (`Ss`, `S+`, `R<`), so only the
 * first character names the state. Pure and exported for the same reason as
 * the Linux parser: it cannot be exercised from a Linux test host, and the
 * zombie branch is exactly the one worth locking down.
 */
export function parseDarwinPsLine(
  raw: string
): { state: string; lstart: string } | null {
  const line = raw.trim();
  if (line.length === 0) return null;
  const match = /^(\S+)\s+(.+)$/.exec(line);
  if (!match) return null;
  const state = match[1]!;
  const lstart = match[2]!.trim();
  if (lstart.length === 0) return null;
  return { state, lstart };
}

async function readDarwinBirthIdentity(
  pid: number
): Promise<ProcessBirthIdentity | null> {
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "state=,lstart=", "-p", String(pid)],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024, encoding: "utf8", env: {} },
      (error, out) => resolve(error ? null : typeof out === "string" ? out : null)
    );
  });
  if (stdout === null) return null;
  const parsed = parseDarwinPsLine(stdout);
  if (parsed === null) return null;
  if (isDeadState(parsed.state.charAt(0))) return null;
  return `darwin:${parsed.lstart}`;
}

/**
 * Read the kernel's birth identity for a live pid, or null when the process is
 * gone or the platform cannot answer.
 */
export async function readProcessBirthIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<ProcessBirthIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") return readLinuxBirthIdentity(pid);
  if (platform === "darwin") return readDarwinBirthIdentity(pid);
  return null;
}

/** Does this platform support the ownership proof the supervisor requires? */
export function supportsOwnershipProof(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "linux" || platform === "darwin";
}

/**
 * Is `pid` still the process whose birth identity we recorded?
 *
 * Answers false — never "probably" — when the platform cannot prove it. Every
 * caller treats false as "do not touch this pid".
 */
export async function isSameProcess(
  pid: number,
  expected: ProcessBirthIdentity,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const live = await readProcessBirthIdentity(pid, platform);
  return live !== null && live === expected;
}

export type TreeSignal = "SIGTERM" | "SIGKILL";

/**
 * Signal a whole process GROUP.
 *
 * The supervisor spawns POSIX children detached, which makes the child a
 * process-group leader whose pgid equals its pid; `kill(-pid)` then reaches
 * every descendant that has not deliberately left the group. Descendants that
 * DO leave (a `setsid` daemon) are the case the compatibility manifest handles
 * by refusing to certify such a harness for native mode, rather than the case
 * this function pretends to cover.
 */
export function signalProcessGroup(
  pid: number,
  signal: TreeSignal,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (platform === "win32") {
      // No process groups. The supervisor does not offer Windows native mode;
      // this arm exists so a caller on Windows gets `false` rather than a
      // silently-succeeded no-op it might mistake for a kill.
      return false;
    }
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    // ESRCH: the group is already gone, which is success for our purposes.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
}

/**
 * Terminate a process group we have PROVEN we own, gracefully then forcibly.
 *
 * Returns what actually happened, so the caller can report "stopped" only when
 * the tree is genuinely gone (the lifecycle contract's requirement) instead of
 * when a signal was merely sent.
 */
export async function terminateOwnedProcessGroup(args: {
  pid: number;
  birthIdentity: ProcessBirthIdentity;
  graceMs: number;
  platform?: NodeJS.Platform;
  /** Test seam: how long to wait between liveness polls. */
  pollMs?: number;
}): Promise<
  | { outcome: "already-gone" }
  | { outcome: "not-owned" }
  | { outcome: "graceful" }
  | { outcome: "forced" }
  | { outcome: "escaped" }
> {
  const platform = args.platform ?? process.platform;
  const pollMs = args.pollMs ?? 50;

  if (!(await isSameProcess(args.pid, args.birthIdentity, platform))) {
    // Either the process exited (its pid may now belong to someone else) or we
    // cannot prove ownership. Both mean: do not signal.
    const live = await readProcessBirthIdentity(args.pid, platform);
    return { outcome: live === null ? "already-gone" : "not-owned" };
  }

  signalProcessGroup(args.pid, "SIGTERM", platform);

  const deadline = Date.now() + args.graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if ((await readProcessBirthIdentity(args.pid, platform)) === null) {
      return { outcome: "graceful" };
    }
  }

  // Re-prove before escalating: during the grace window the pid could have
  // exited and been reused.
  if (!(await isSameProcess(args.pid, args.birthIdentity, platform))) {
    return { outcome: "graceful" };
  }
  signalProcessGroup(args.pid, "SIGKILL", platform);

  const killDeadline = Date.now() + Math.max(args.graceMs, 1_000);
  while (Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if ((await readProcessBirthIdentity(args.pid, platform)) === null) {
      return { outcome: "forced" };
    }
  }
  // SIGKILL was delivered and the root is still there: uninterruptible sleep,
  // or something we do not understand. Say so rather than reporting stopped.
  return { outcome: "escaped" };
}
