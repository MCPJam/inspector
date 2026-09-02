/**
 * L8 — clearing a stale Chromium profile lock before relaunch.
 *
 * A persistent `--user-data-dir` is a SINGLETON: exactly one Chromium may own it
 * at a time, guarded by `SingletonLock` (a symlink) plus `SingletonSocket` /
 * `SingletonCookie`. On a clean exit Chromium removes them; on an UNGRACEFUL
 * kill they remain, and the next launch either fails or silently forwards the
 * URL to a process that is already dead.
 *
 * browserd's recovery posture makes this the common case, not the edge case:
 * the M0 finding is to kill/relaunch on a failed `/healthz` after wake, so every
 * wake that fails health leaves an ungraceful exit behind. The supervisor must
 * therefore clear the lock before each relaunch. Best-effort by design: a
 * missing file is success (nothing to clear), and a lock we cannot remove is
 * surfaced, not thrown — the caller decides whether to proceed.
 */
import { readlink, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** The singleton artifacts Chromium leaves in a user-data dir. */
const SINGLETON_FILES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;

export interface ClearedLock {
  /** Names actually removed (were present). */
  removed: string[];
  /** Names that were present but could not be removed, with the error text. */
  failed: Array<{ name: string; error: string }>;
}

/**
 * Remove any stale Chromium singleton files from `userDataDir`. Safe to call
 * when the directory is clean (removes nothing) and when Chromium is NOT running
 * (there is no live owner to disturb — the caller guarantees that by only
 * clearing before a relaunch). ENOENT is treated as already-clear.
 */
export async function clearStaleSingletonLock(
  userDataDir: string,
): Promise<ClearedLock> {
  const result: ClearedLock = { removed: [], failed: [] };
  for (const name of SINGLETON_FILES) {
    try {
      await unlink(join(userDataDir, name));
      result.removed.push(name);
    } catch (err) {
      if (isNotFound(err)) continue; // already clear — the common, healthy case
      result.failed.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Is a LIVE process holding this profile, or is the lock just debris?
 *
 * The hosted engine never has to ask: it `pkill`s the daemon before every
 * relaunch, so any lock it finds is by construction stale. On a laptop the
 * owner may be a second inspector server, or the user's own Chrome pointed at
 * the same directory — and unlinking the lock out from under either of those
 * corrupts a profile someone is using.
 *
 * Chromium writes `SingletonLock` as a symlink whose TARGET is `host-pid`. A
 * target naming this host with a pid that still exists is a live owner; a
 * missing link, a foreign host (a shared home directory over NFS), or a dead
 * pid is not. Unreadable or unparseable is reported as NOT live — the lock is
 * then cleared, which is the behaviour that existed before this probe and is
 * still the right default for a directory this process is about to own.
 */
export async function probeSingletonOwner(
  userDataDir: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<{ live: boolean; pid?: number }> {
  let target: string;
  try {
    target = await readlink(join(userDataDir, "SingletonLock"));
  } catch {
    return { live: false };
  }
  // `host-pid`, where the host may itself contain dashes.
  const separator = target.lastIndexOf("-");
  if (separator <= 0) return { live: false };
  const host = target.slice(0, separator);
  const pid = Number(target.slice(separator + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { live: false };
  if (host !== hostname()) return { live: false };
  return isAlive(pid) ? { live: true, pid } : { live: false, pid };
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence and permission without delivering
    // anything. EPERM means the process exists but belongs to another user —
    // still a live owner, and emphatically not ours to clear.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
