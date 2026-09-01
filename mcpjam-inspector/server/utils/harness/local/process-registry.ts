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
import { mkdir, readFile, rename, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import { localHarnessStateRoot } from "./grants.js";
import {
  readProcessBirthIdentity,
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

let mutationChain: Promise<unknown> = Promise.resolve();
function withRegistryLock<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(op, op);
  mutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readRegistry(): Promise<PersistedRegistry> {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, records: [] };
    const record = parsed as Partial<PersistedRegistry>;
    if (record.version !== 1 || !Array.isArray(record.records)) {
      return { version: 1, records: [] };
    }
    return { version: 1, records: record.records };
  } catch {
    return { version: 1, records: [] };
  }
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
  record: LocalHarnessProcessRecord
): Promise<void> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    registry.records = registry.records.filter(
      (r) => r.sessionId !== record.sessionId
    );
    registry.records.push(record);
    await writeRegistry(registry);
  });
}

export function updateLifecycleState(
  sessionId: string,
  lifecycleState: LocalHarnessLifecycleState
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
    registry.records = registry.records.filter((r) => r.sessionId !== sessionId);
    if (registry.records.length !== before) await writeRegistry(registry);
  });
}

export async function listProcessRecords(): Promise<
  readonly LocalHarnessProcessRecord[]
> {
  return (await readRegistry()).records;
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
  const root = localHarnessStateRoot();
  if (dir !== root && !dir.startsWith(root + "/") && !dir.startsWith(root + "\\")) {
    logger.warn("[local-harness] refusing to clean state outside the root", {
      dir,
    });
    return;
  }
  if (dir === root) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
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

      if (!supportsOwnershipProof(platform)) {
        survivors.push(record);
        results.push({
          sessionId: record.sessionId,
          outcome: "skipped-unprovable",
        });
        continue;
      }

      const live = await readProcessBirthIdentity(record.rootPid, platform);
      if (live === null) {
        // The process is gone. Its state directory is disposable and its
        // record has no further use.
        await removeSessionState(record.sessionStateDir);
        results.push({ sessionId: record.sessionId, outcome: "already-gone" });
        continue;
      }
      if (live !== record.processBirthIdentity) {
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
