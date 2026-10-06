/**
 * Whether an installed pack has proven it can START — recorded beside it.
 *
 * A pack that verifies is bytes we published. Whether this build's Inspector
 * layer can actually start a session on it is a different question, asked
 * twice:
 *
 *   1. before it is ever selectable: the candidate's STARTUP PROBE
 *      (`runtime-probe.ts`) runs during install, and only a pack that passes
 *      is activated, with `probe` recorded here;
 *   2. afterwards, by real sessions: each bridge start is recorded as a
 *      success or a runtime-attributable failure. Repeated failures with no
 *      success between them mark the pack UNHEALTHY, and selection falls back
 *      to the permitted previous pack (`runtime-selection.ts`). The turn that
 *      failed is not replayed (invariant 5): it may already have changed files.
 *
 * The record is a SIBLING of the digested `<harnessId>/` tree, like the
 * install marker, so writing it never changes what the pack verifies as. An
 * unhealthy pack is healthy again only by reinstalling or repairing it — a
 * fresh probe writes a fresh record.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRuntimeLifecycleLock, type RuntimeOperationKey } from "./runtime-lifecycle.js";

export const HEALTH_FILE = ".mcpjam-pack-health.json";

/** Failures with no success between them, inside the window, that mark a pack unhealthy. */
export const LAUNCH_FAILURE_THRESHOLD = 3;
export const LAUNCH_FAILURE_WINDOW_MS = 30 * 60 * 1000;

export interface RuntimeHealthRecord {
  schema: 1;
  packVersion: string;
  treeDigest: string;
  /** The startup probe this pack passed before activation. */
  probe?: { at: number; node?: string; vendorVersion?: string };
  /** When the install that produced this directory started, for time-to-usable. */
  installStartedAt?: number;
  activatedAt?: number;
  /** Activated while another version of this harness was already installed. */
  activatedAsUpdate?: boolean;
  /** The first session that started on it, once. */
  firstUsableAt?: number;
  /** Runtime-attributable launch failures since the last success. */
  launchFailures: number[];
  unhealthy?: { at: number; reason: string };
}

export function newHealthRecord(fields: Omit<RuntimeHealthRecord, "schema" | "launchFailures">): RuntimeHealthRecord {
  return { schema: 1, launchFailures: [], ...fields };
}

export async function readRuntimeHealth(versionRoot: string): Promise<RuntimeHealthRecord | null> {
  try {
    const record = JSON.parse(await readFile(join(versionRoot, HEALTH_FILE), "utf8")) as RuntimeHealthRecord;
    if (record?.schema !== 1 || !Array.isArray(record.launchFailures)) return null;
    return record;
  } catch {
    return null;
  }
}

/** Is this pack marked unhealthy for THIS digest? A record for other bytes says nothing. */
export function isUnhealthy(record: RuntimeHealthRecord | null, treeDigest: string): boolean {
  return record !== null && record.treeDigest === treeDigest && record.unhealthy !== undefined;
}

export async function writeRuntimeHealth(dir: string, record: RuntimeHealthRecord): Promise<void> {
  const file = join(dir, HEALTH_FILE);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * One launch outcome folded into a record. Pure, so the rollback rule is a
 * tested function: a success clears the failures; a failure is appended, and
 * the THRESHOLD-th inside the window marks the pack unhealthy.
 */
export function foldLaunch(
  record: RuntimeHealthRecord,
  outcome: { ok: true } | { ok: false; reason: string },
  now: number,
): { record: RuntimeHealthRecord; becameUnhealthy: boolean; firstUsable: boolean } {
  if (outcome.ok) {
    const firstUsable = record.firstUsableAt === undefined;
    return {
      record: { ...record, launchFailures: [], ...(firstUsable ? { firstUsableAt: now } : {}) },
      becameUnhealthy: false,
      firstUsable,
    };
  }
  const failures = [...record.launchFailures, now].filter((at) => now - at <= LAUNCH_FAILURE_WINDOW_MS);
  const becameUnhealthy = record.unhealthy === undefined && failures.length >= LAUNCH_FAILURE_THRESHOLD;
  return {
    record: {
      ...record,
      launchFailures: failures,
      ...(becameUnhealthy ? { unhealthy: { at: now, reason: outcome.reason } } : {}),
    },
    becameUnhealthy,
    firstUsable: false,
  };
}

/**
 * Record one session's bridge start against the pack it ran on. Serialized
 * with the install root's lifecycle lock, so two Inspectors recording at once
 * do not lose a failure. A pack with no record (installed before probes
 * existed) gets one.
 */
export async function recordRuntimeLaunch(args: {
  key: RuntimeOperationKey;
  versionRoot: string;
  outcome: { ok: true } | { ok: false; reason: string };
  now?: number;
}): Promise<{ record: RuntimeHealthRecord; becameUnhealthy: boolean; firstUsable: boolean }> {
  return withRuntimeLifecycleLock(args.key, async () => {
    const existing = await readRuntimeHealth(args.versionRoot);
    const base =
      existing !== null && existing.treeDigest === args.key.treeDigest
        ? existing
        : newHealthRecord({ packVersion: args.key.packVersion, treeDigest: args.key.treeDigest });
    const folded = foldLaunch(base, args.outcome, args.now ?? Date.now());
    await writeRuntimeHealth(args.versionRoot, folded.record);
    return folded;
  });
}
