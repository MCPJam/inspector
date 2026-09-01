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
import { readdir, readFile } from "node:fs/promises";

/** Opaque, comparable string identifying "this exact process instance". */
export type ProcessBirthIdentity = string;

/**
 * What a liveness probe actually learned.
 *
 * The three states are kept apart because collapsing them is a safety bug in
 * both directions. "Gone" authorizes dropping a durable record and reporting a
 * session stopped; "unknown" — a `ps` timeout, an unreadable `/proc`, a
 * platform with no primitive — authorizes neither, and must never be mistaken
 * for it. An earlier draft returned `null` for both, which meant a probe
 * failure could report a live tree as stopped and let the janitor reclaim a
 * healthy supervisor's sessions.
 */
export type ProcessProbe =
  | { state: "alive"; identity: ProcessBirthIdentity }
  | { state: "gone" }
  | { state: "unknown"; reason: string };

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
  raw: string,
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

async function probeLinux(pid: number): Promise<ProcessProbe> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    // ENOENT is the kernel saying there is no such process. Anything else —
    // EACCES, EIO, a procfs that is not mounted — is a failure to LOOK, and
    // reporting that as "gone" would authorize a cleanup we have not earned.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return { state: "gone" };
    return {
      state: "unknown",
      reason: `/proc read failed (${code ?? "unknown"})`,
    };
  }
  const parsed = parseLinuxProcStat(raw);
  if (parsed === null) {
    return { state: "unknown", reason: "unparseable /proc stat line" };
  }
  if (isDeadState(parsed.state)) return { state: "gone" };
  return { state: "alive", identity: `linux:${parsed.starttime}` };
}

/**
 * Parse `ps -o state=,lstart=,command=` output.
 *
 * `lstart` has ONE-SECOND precision, which on its own is a weak discriminator:
 * a pid recycled inside the same second would present an identical identity.
 * `command` — the full argv, not just the executable name `comm` reports — is
 * appended, so a recycled pid must additionally have been launched with the
 * same arguments. For a supervised bridge that argv carries the session's own
 * workdir and bridge-state paths, which makes a collision require a second
 * process started in the same second with byte-identical arguments.
 *
 * That still is not an unforgeable identity, and the supervisor does not rely
 * on it alone: for its own children it also holds the `ChildProcess` handle,
 * and macOS exposes no higher-resolution start time through `ps`. Reaching for
 * one would mean a native binding for `proc_pidinfo`, which is not a dependency
 * this earns today — recorded here so the limit is a known one.
 *
 * `lstart` renders as exactly five whitespace-separated tokens
 * (`Www Mmm dd hh:mm:ss yyyy`), so the split point is positional and does not
 * depend on `comm` being a single token — which it is not for an app bundle.
 * Tokens are rejoined with single spaces, because `ps` space-pads a
 * single-digit day and an identity that changed with the padding would be a
 * worse discriminator rather than a better one.
 *
 * Pure and exported because a Linux test host cannot exercise it otherwise,
 * and both the zombie branch and this parsing are worth locking down.
 */
export function parseDarwinPsLine(
  raw: string,
): { state: string; lstart: string; command: string } | null {
  const line = raw.trim();
  if (line.length === 0) return null;
  // Anchored positionally: state, then exactly five lstart tokens, then the
  // command and its arguments as a RAW substring. Splitting and rejoining the
  // command would collapse runs of whitespace, so two executable paths that
  // differ only in spacing would present the same identity — and this value
  // exists precisely to tell two processes apart.
  const match =
    /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(line);
  if (match === null) return null;
  const state = match[1]!;
  const lstart = [match[2], match[3], match[4], match[5], match[6]].join(" ");
  const command = match[7]!;
  return { state, lstart, command };
}

async function probeDarwin(pid: number): Promise<ProcessProbe> {
  const result = await new Promise<
    | { ok: true; stdout: string }
    | { ok: false; exitCode: number | null; reason: string }
  >((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "state=,lstart=,command=", "-p", String(pid)],
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
        env: {},
      },
      (error, out) => {
        if (!error) {
          resolve({ ok: true, stdout: typeof out === "string" ? out : "" });
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
        };
        resolve({
          ok: false,
          // `ps` exits 1 when no process matches — that IS an answer. A kill
          // (timeout) or a spawn failure is not.
          exitCode: typeof err.code === "number" ? err.code : null,
          reason: err.killed
            ? "ps timed out"
            : `ps failed (${String(err.code ?? "unknown")})`,
        });
      },
    );
  });

  if (!result.ok) {
    if (result.exitCode === 1) return { state: "gone" };
    return { state: "unknown", reason: result.reason };
  }
  const parsed = parseDarwinPsLine(result.stdout);
  if (parsed === null) {
    // A successful `ps` with no row is the same answer as exit 1.
    return result.stdout.trim().length === 0
      ? { state: "gone" }
      : { state: "unknown", reason: "unparseable ps output" };
  }
  if (isDeadState(parsed.state.charAt(0))) return { state: "gone" };
  return {
    state: "alive",
    identity: `darwin:${parsed.lstart}|${parsed.command}`,
  };
}

/** Probe a pid, distinguishing gone from unprovable. */
export async function probeProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessProbe> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: "unknown", reason: "implausible pid" };
  }
  if (platform === "linux") return probeLinux(pid);
  if (platform === "darwin") return probeDarwin(pid);
  return { state: "unknown", reason: `no liveness primitive on ${platform}` };
}

/**
 * The birth identity of a LIVE pid, or null.
 *
 * A convenience over `probeProcess` for the one caller that only needs the
 * identity of a process it just started. Anything making a cleanup decision
 * must use `probeProcess` instead, so it can tell "gone" from "cannot tell".
 */
export async function readProcessBirthIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessBirthIdentity | null> {
  const probe = await probeProcess(pid, platform);
  return probe.state === "alive" ? probe.identity : null;
}

/** Does this platform support the ownership proof the supervisor requires? */
export function supportsOwnershipProof(
  platform: NodeJS.Platform = process.platform,
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
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const probe = await probeProcess(pid, platform);
  return probe.state === "alive" && probe.identity === expected;
}

export type TreeSignal = "SIGTERM" | "SIGKILL";

/**
 * What a process-GROUP probe actually learned.
 *
 * Three answers, for the same reason `ProcessProbe` has three: an enumeration
 * that could not run is not an empty group. An earlier version of this
 * function returned a boolean and mapped every failure to `false`, on the
 * stated grounds that the value "only gates escalation, never a kill". That
 * was simply wrong about its own callers — `false` is what makes
 * `terminateOwnedProcessGroup` report the tree gone and what makes the janitor
 * DROP a durable record. So a `ps` timeout or an unreadable `/proc` announced a
 * stopped session over live vendor descendants and threw away the only handle
 * on them: the exact bug this file already fixes twice elsewhere, reintroduced
 * in the fix for it.
 */
export type GroupProbe = "live" | "empty" | "unknown";

/**
 * Does a process GROUP still have LIVE members?
 *
 * `kill(-pgid, 0)` is not the answer, and the difference is the same one that
 * bit the single-process probe: a ZOMBIE still belongs to its group, so a
 * signal-0 to the group succeeds when everything in it has already exited and
 * is merely awaiting reaping. Built on that, "did the tree survive?" answered
 * yes for a tree that was entirely dead, which turns a completed stop into a
 * reported escape and stops the janitor ever reclaiming the record.
 *
 * So the members are enumerated and their states read: `empty` when every one
 * is gone or a zombie, `live` when something is genuinely still there, and
 * `unknown` when the enumeration itself could not be performed — including on
 * a platform with no way to do it at all.
 */
export async function probeProcessGroup(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<GroupProbe> {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (platform === "linux") return probeLinuxGroup(pid);
  if (platform === "darwin") return probeDarwinGroup(pid);
  return "unknown";
}

/** `state ppid pgrp` are the three fields after `comm` in `/proc/<pid>/stat`. */
export function parseProcStatGroup(
  raw: string,
): { state: string; pgrp: number } | null {
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  if (state === undefined || !Number.isInteger(pgrp)) return null;
  return { state, pgrp };
}

async function probeLinuxGroup(pgid: number): Promise<GroupProbe> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    // The enumeration itself failed. Nothing was learned about the group.
    return "unknown";
  }
  // Set when some process could not be examined for a reason OTHER than
  // having exited. Finding a live member is still a sound `live` — but
  // concluding `empty` means "no member of this group is alive", and that
  // claim is not available if one of the candidates could not be read: the
  // one we skipped could have been it.
  let blind = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = await readFile(`/proc/${entry}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT/ESRCH is the ONLY answer that means "not a live member": the
      // process exited between `readdir` and this read.
      //
      // EACCES is not. An earlier version exempted it, reasoning that these
      // files are world-readable (they are — as uid 65534 all 79 entries on
      // this machine read fine), so a refusal must mean another user's
      // process, which cannot be in a group we forked. The hole is a
      // supervised descendant that changes uid: under a `hidepid` mount it
      // becomes exactly such an entry, and exempting the error reports the
      // tree gone while it is running. That is a fail-OPEN safety hole, traded
      // against a fail-CLOSED functional one (on a hidepid mount the probe
      // answers `unknown` a lot, so stops report unproven and the janitor
      // retains records) — and this file exists because that trade keeps being
      // made the wrong way round. The kill still happens either way; only the
      // reporting and record retention change.
      if (code !== "ENOENT" && code !== "ESRCH") blind = true;
      continue;
    }
    const parsed = parseProcStatGroup(raw);
    if (parsed === null) {
      // A stat line we cannot parse is a process whose group we do not know.
      blind = true;
      continue;
    }
    if (parsed.pgrp !== pgid) continue;
    if (!isDeadState(parsed.state.charAt(0))) return "live";
  }
  return blind ? "unknown" : "empty";
}

async function probeDarwinGroup(pgid: number): Promise<GroupProbe> {
  const result = await new Promise<
    { ok: true; stdout: string } | { ok: false; empty: boolean }
  >((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "state=", "-g", String(pgid)],
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: {},
      },
      (error, out) => {
        if (!error) {
          resolve({ ok: true, stdout: typeof out === "string" ? out : "" });
          return;
        }
        const err = error as Error & {
          code?: number | string;
          killed?: boolean;
        };
        // Exit 1 means `ps` ran and matched nothing — a real answer. A kill
        // (timeout) or a spawn failure is not.
        resolve({ ok: false, empty: err.killed !== true && err.code === 1 });
      },
    );
  });
  if (!result.ok) return result.empty ? "empty" : "unknown";
  const states = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (states.some((state) => !isDeadState(state.charAt(0)))) return "live";
  return "empty";
}

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
  platform: NodeJS.Platform = process.platform,
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
  | { outcome: "unknown"; reason: string }
> {
  const platform = args.platform ?? process.platform;
  const pollMs = args.pollMs ?? 50;

  /**
   * The root is gone. The GROUP may not be.
   *
   * A descendant that ignores SIGTERM keeps running while the leader exits, so
   * "the root's pid is gone" is not "the tree is gone" — and reporting
   * `graceful` on the root alone is how a session gets announced as stopped
   * over a live vendor process. Signalling the group here is justified by the
   * same rule the janitor relies on: a pid still in use as a process-GROUP id
   * is not handed out as a new process's pid while that group has members, so
   * this can only reach the group we already proved we own.
   */
  const settleGroup = async (
    goneOutcome: "already-gone" | "graceful" | "forced",
  ): Promise<
    | { outcome: "already-gone" }
    | { outcome: "graceful" }
    | { outcome: "forced" }
    | { outcome: "escaped" }
    | { outcome: "unknown"; reason: string }
  > => {
    const before = await probeProcessGroup(args.pid, platform);
    if (before === "empty") return { outcome: goneOutcome };
    if (before === "unknown") {
      return {
        outcome: "unknown",
        reason:
          "the process group could not be enumerated, so survivors " +
          "could be neither ruled out nor cleaned up",
      };
    }
    signalProcessGroup(args.pid, "SIGKILL", platform);
    await new Promise((r) => setTimeout(r, Math.min(args.graceMs, 500)));
    const after = await probeProcessGroup(args.pid, platform);
    if (after === "empty") return { outcome: "forced" };
    if (after === "unknown") {
      return {
        outcome: "unknown",
        reason: "the process group could not be enumerated after SIGKILL",
      };
    }
    return { outcome: "escaped" };
  };

  const initial = await probeProcess(args.pid, platform);
  if (initial.state === "gone") return settleGroup("already-gone");
  if (initial.state === "unknown") {
    // We could not look. Reporting "already-gone" here would let a caller
    // announce a stopped session over a tree that may still be running.
    return { outcome: "unknown", reason: initial.reason };
  }
  if (initial.identity !== args.birthIdentity) {
    // Pid reuse: this is somebody else's process now. Emphatically do not
    // signal it.
    return { outcome: "not-owned" };
  }

  signalProcessGroup(args.pid, "SIGTERM", platform);

  const deadline = Date.now() + args.graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if ((await probeProcess(args.pid, platform)).state === "gone") {
      return settleGroup("graceful");
    }
  }

  // Re-prove before escalating: during the grace window the pid could have
  // exited and been reused. Probed on the TRI-STATE, not through
  // `isSameProcess`, which folds "gone", "not ours" and "could not look" into
  // one `false` — and a probe failure reported here as `graceful` is a caller
  // announcing a stopped session over a tree that may still be running.
  const afterGrace = await probeProcess(args.pid, platform);
  if (afterGrace.state === "gone") return settleGroup("graceful");
  if (afterGrace.state === "unknown") {
    return { outcome: "unknown", reason: afterGrace.reason };
  }
  if (afterGrace.identity !== args.birthIdentity) {
    // Our root exited during the grace window and the number was reused. The
    // tree is gone; the stranger now holding the pid is not ours to signal.
    return { outcome: "graceful" };
  }
  signalProcessGroup(args.pid, "SIGKILL", platform);

  const killDeadline = Date.now() + Math.max(args.graceMs, 1_000);
  while (Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if ((await probeProcess(args.pid, platform)).state === "gone") {
      return settleGroup("forced");
    }
  }
  // The polls above only ever conclude "gone". Ask once more so the difference
  // between "SIGKILL was delivered and the root is STILL there" and "the last
  // few probes could not look" survives into the answer.
  const settled = await probeProcess(args.pid, platform);
  if (settled.state === "gone") return settleGroup("forced");
  if (settled.state === "unknown") {
    return { outcome: "unknown", reason: settled.reason };
  }
  // Uninterruptible sleep, or something we do not understand. Say so rather
  // than reporting stopped.
  return { outcome: "escaped" };
}
