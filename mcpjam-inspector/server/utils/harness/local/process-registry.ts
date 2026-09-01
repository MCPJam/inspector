/**
 * The durable record of every process tree this Inspector owns on this
 * machine, and the janitor that cleans up after a crash or restart.
 *
 * Written to owner-only local state with atomic replace, so a supervisor that
 * dies mid-turn — or the whole Inspector — leaves behind enough to find and
 * kill what it started. Reporting a session `stopped` while a vendor CLI is
 * still running is exactly the failure this file exists to prevent.
 *
 * ── The nonce ────────────────────────────────────────────────────────────
 * Each supervisor instance mints a nonce at construction. A record carries the
 * nonce of the supervisor that created it, so a second Inspector process (a
 * second window, a stale instance) can tell "mine, still running" from
 * "abandoned by a dead instance" without a lock file. Combined with the birth
 * identity from `process-identity.ts`, a record is only ever acted on when
 * BOTH the pid still exists and it is still the same process instance.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { logger } from "../../logger.js";
import { localHarnessStateRoot } from "./grants.js";
import { createLocalStateMutationLock } from "./local-state-lock.js";
import {
  probeProcess,
  probeProcessGroup,
  signalProcessGroup,
  supportsOwnershipProof,
  terminateOwnedProcessGroup,
  type ProcessBirthIdentity,
} from "./process-identity.js";

export type LocalHarnessLifecycleState =
  | "starting"
  | "running"
  | "suspended"
  | "stopping"
  | "stopped"
  | "failed";

export interface LocalHarnessProcessRecord {
  sessionId: string;
  supervisorNonce: string;
  /** Pid of the Inspector process that owns this record. */
  supervisorPid?: number;
  /** Birth identity of that Inspector process. A nonce names the owner; only
   *  this proves whether the owner is still alive, which is what separates
   *  "abandoned by a dead instance" from "in use by a second window". */
  supervisorBirthIdentity?: ProcessBirthIdentity;
  runtimeId: string;
  rootPid: number;
  processBirthIdentity: ProcessBirthIdentity;
  /** POSIX process-group id — equal to `rootPid` for a detached child, kept
   *  explicit so a future platform with a different grouping primitive has a
   *  place to put it. */
  processGroupIdentity?: string;
  startedAt: string;
  workspaceGrantId: string;
  targetKind: "local-native" | "local-isolated";
  lifecycleState: LocalHarnessLifecycleState;
  /** Session state directory to remove once the tree is gone. Always inside
   *  the local harness state root — the janitor re-checks that before any
   *  deletion. */
  sessionStateDir: string;
}

interface PersistedRegistry {
  version: 1;
  records: LocalHarnessProcessRecord[];
}

function registryPath(): string {
  return join(localHarnessStateRoot(), "processes.json");
}

/**
 * Serialize a registry mutation, in this process and across processes.
 *
 * Reads stay lock-free: they are a single atomic `readFile` of a file that is
 * only ever replaced by `rename`, and the enforcement paths must not queue
 * behind a mutation.
 */
const withRegistryLock = createLocalStateMutationLock({
  rootDir: localHarnessStateRoot,
  lockFileName: "processes.lock",
  resourceLabel: "process registry",
});

/** A registry that exists but cannot be understood. Never treated as empty:
 *  overwriting it would erase the only durable record of running trees. */
export class RegistryUnreadableError extends Error {}

async function readRegistry(): Promise<PersistedRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath(), "utf8");
  } catch (error) {
    // A MISSING registry is genuinely empty — nothing has been recorded yet.
    // Anything else (EACCES, EIO, a directory in its place) is not, and
    // treating it as empty would make the very next `recordProcess` write an
    // empty file over the records a crash recovery depends on.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, records: [] };
    }
    throw new RegistryUnreadableError(
      `the local harness process registry could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RegistryUnreadableError(
      "the local harness process registry is corrupt; refusing to overwrite " +
        "it, because it may name process trees that are still running",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new RegistryUnreadableError(
      "the local harness process registry is not an object",
    );
  }
  const record = parsed as Partial<PersistedRegistry>;
  if (record.version !== 1 || !Array.isArray(record.records)) {
    throw new RegistryUnreadableError(
      "the local harness process registry has an unrecognized shape",
    );
  }
  return { version: 1, records: record.records };
}

async function writeRegistry(registry: PersistedRegistry): Promise<void> {
  const dir = localHarnessStateRoot();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const file = registryPath();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(registry), { mode: 0o600 });
  await rename(tmp, file);
}

export function mintSupervisorNonce(): string {
  return `sup_${randomUUID()}`;
}

/** Record a freshly spawned tree. Called BEFORE the child is allowed to do
 *  anything, so a crash in the next millisecond still leaves a cleanable
 *  trace. */
export function recordProcess(
  record: LocalHarnessProcessRecord,
): Promise<void> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    registry.records = registry.records.filter(
      (r) => r.sessionId !== record.sessionId,
    );
    registry.records.push(record);
    await writeRegistry(registry);
  });
}

export function updateLifecycleState(
  sessionId: string,
  lifecycleState: LocalHarnessLifecycleState,
): Promise<void> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    const record = registry.records.find((r) => r.sessionId === sessionId);
    if (!record) return;
    record.lifecycleState = lifecycleState;
    await writeRegistry(registry);
  });
}

export function forgetProcess(sessionId: string): Promise<void> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    const before = registry.records.length;
    registry.records = registry.records.filter(
      (r) => r.sessionId !== sessionId,
    );
    if (registry.records.length !== before) await writeRegistry(registry);
  });
}

export async function listProcessRecords(): Promise<
  readonly LocalHarnessProcessRecord[]
> {
  return (await readRegistry()).records;
}

/**
 * Has the Inspector process that created this record provably exited?
 *
 * Only `true` authorizes reclaiming its trees. A probe that could not look —
 * an unreadable `/proc`, a `ps` timeout, a platform with no primitive — is not
 * evidence of death, and a record written before these fields existed is not
 * either; both answer `false`, so the record is left alone.
 */
async function owningSupervisorProvablyExited(
  record: LocalHarnessProcessRecord,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (
    record.supervisorPid === undefined ||
    record.supervisorBirthIdentity === undefined
  ) {
    return false;
  }
  const probe = await probeProcess(record.supervisorPid, platform);
  if (probe.state === "gone") return true;
  if (probe.state === "unknown") return false;
  // Alive, but is it still the SAME Inspector? A reused pid means the original
  // owner is gone.
  return probe.identity !== record.supervisorBirthIdentity;
}

export type JanitorOutcome =
  | "terminated"
  | "already-gone"
  | "not-owned"
  | "escaped"
  | "skipped-live-supervisor"
  | "skipped-unprovable";

export interface JanitorResult {
  sessionId: string;
  outcome: JanitorOutcome;
}

/**
 * Delete a session's disposable state directory.
 *
 * Re-checks containment under the local harness state root before removing
 * anything: a corrupted or hand-edited registry must not be able to turn the
 * janitor into an arbitrary-delete primitive.
 */
async function removeSessionState(dir: string): Promise<void> {
  // Both sides are RESOLVED before comparison. A prefix check on the raw
  // string accepts `<root>/../../etc`, which resolves outside the root — and
  // this function ends in a recursive delete, so a corrupt or hand-edited
  // registry must not be able to aim it.
  const root = resolve(localHarnessStateRoot());
  const target = resolve(dir);
  if (target === root || !target.startsWith(root + sep)) {
    logger.warn("[local-harness] refusing to clean state outside the root", {
      dir,
    });
    return;
  }
  await rm(target, { recursive: true, force: true }).catch(() => {});
}

/**
 * Reclaim abandoned process trees.
 *
 * `liveNonce` is the current supervisor's nonce; its own records are left
 * alone (they belong to a running session in this process). Everything else is
 * a candidate, and each candidate must PROVE it is still the process we
 * recorded before a signal is sent.
 *
 * A record whose ownership cannot be proven is neither killed nor forgotten:
 * killing would risk a stranger's process, and forgetting would lose the only
 * evidence an operator has. It is reported and left for a human.
 */
export function reclaimAbandonedProcesses(args: {
  liveNonce: string;
  graceMs?: number;
  platform?: NodeJS.Platform;
}): Promise<JanitorResult[]> {
  return withRegistryLock(async () => {
    const platform = args.platform ?? process.platform;
    const registry = await readRegistry();
    const results: JanitorResult[] = [];
    const survivors: LocalHarnessProcessRecord[] = [];

    for (const record of registry.records) {
      if (record.supervisorNonce === args.liveNonce) {
        survivors.push(record);
        results.push({
          sessionId: record.sessionId,
          outcome: "skipped-live-supervisor",
        });
        continue;
      }

      // Platform first, so a runner with no liveness primitive reports the
      // reason it actually has rather than being described as somebody else's
      // live session.
      if (!supportsOwnershipProof(platform)) {
        survivors.push(record);
        results.push({
          sessionId: record.sessionId,
          outcome: "skipped-unprovable",
        });
        continue;
      }

      // A foreign nonce means "another supervisor created this" — NOT "that
      // supervisor is gone". A second Inspector window opened alongside the
      // first would otherwise reclaim the first's live sessions. Only an owner
      // we can PROVE has exited leaves its trees for us to clean up; a probe
      // that could not look answers "no" here.
      if (!(await owningSupervisorProvablyExited(record, platform))) {
        survivors.push(record);
        results.push({
          sessionId: record.sessionId,
          outcome: "skipped-live-supervisor",
        });
        continue;
      }

      const rootProbe = await probeProcess(record.rootPid, platform);
      if (rootProbe.state === "unknown") {
        survivors.push(record);
        results.push({
          sessionId: record.sessionId,
          outcome: "skipped-unprovable",
        });
        continue;
      }
      if (rootProbe.state === "gone") {
        // The ROOT is gone, but a descendant it spawned can still be running:
        // the process group outlives its leader. Signal the recorded group
        // before dropping the record, otherwise this is the moment the only
        // durable handle on those survivors is thrown away.
        //
        // Safe despite the root's pid being free: a pid still in use as a
        // process-group id is not handed out as a new process's pid while the
        // group has members, so this can only reach the group we recorded. If
        // the group is already empty the signal is a harmless ESRCH.
        // Only signal a group the record itself vouches for: a malformed
        // `processGroupIdentity` is not a licence to signal an arbitrary pid.
        const vouched = record.processGroupIdentity === String(record.rootPid);
        if (vouched) {
          signalProcessGroup(record.rootPid, "SIGKILL", platform);
          // Give the survivors a moment before confirming.
          await new Promise((r) => setTimeout(r, 200));
        }
        // Confirmed in BOTH cases. Being unable to vouch for the group is a
        // reason not to SIGNAL it; it is an even stronger reason not to throw
        // away the only durable handle on a tree nobody has looked at. (This
        // path is unreachable on win32, where the group probe always answers
        // `unknown` — ownership proof gates it above.)
        const group = await probeProcessGroup(record.rootPid, platform);
        if (group === "live") {
          survivors.push(record);
          results.push({ sessionId: record.sessionId, outcome: "escaped" });
          logger.warn(
            "[local-harness] descendants outlived their root; record kept",
            { sessionId: record.sessionId, vouched },
          );
          continue;
        }
        if (group === "unknown") {
          // The enumeration itself failed. That is not an empty group, and
          // dropping the record on it would discard the only durable handle on
          // whatever is still down there.
          survivors.push(record);
          results.push({
            sessionId: record.sessionId,
            outcome: "skipped-unprovable",
          });
          continue;
        }
        await removeSessionState(record.sessionStateDir);
        results.push({ sessionId: record.sessionId, outcome: "already-gone" });
        continue;
      }
      if (rootProbe.identity !== record.processBirthIdentity) {
        // Pid reuse. Emphatically do not signal it; keep the record so the
        // mismatch stays visible.
        survivors.push(record);
        results.push({ sessionId: record.sessionId, outcome: "not-owned" });
        logger.warn("[local-harness] refusing to reclaim a reused pid", {
          sessionId: record.sessionId,
        });
        continue;
      }

      const outcome = await terminateOwnedProcessGroup({
        pid: record.rootPid,
        birthIdentity: record.processBirthIdentity,
        graceMs: args.graceMs ?? 5_000,
        platform,
      });
      if (outcome.outcome === "graceful" || outcome.outcome === "forced") {
        await removeSessionState(record.sessionStateDir);
        results.push({ sessionId: record.sessionId, outcome: "terminated" });
        continue;
      }
      if (outcome.outcome === "already-gone") {
        await removeSessionState(record.sessionStateDir);
        results.push({ sessionId: record.sessionId, outcome: "already-gone" });
        continue;
      }
      survivors.push(record);
      results.push({
        sessionId: record.sessionId,
        outcome: outcome.outcome === "escaped" ? "escaped" : "not-owned",
      });
    }

    if (survivors.length !== registry.records.length) {
      await writeRegistry({ version: 1, records: survivors });
    }
    return results;
  });
}
