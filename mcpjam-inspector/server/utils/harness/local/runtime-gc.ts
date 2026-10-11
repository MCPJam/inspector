/**
 * Reclaiming runtime packs nobody can select any more — without ever taking
 * one away from an Inspector that might.
 *
 * ── Liveness ─────────────────────────────────────────────────────────────
 * Every running Inspector writes a LIVENESS RECORD under the runtime root
 * naming the pack digests it may select (its desired and permitted pack per
 * harness, for its target) and the Inspector layers it runs. Two Inspector
 * versions on one root therefore each protect their own packs: GC keeps
 * anything any live record names. A record whose owner is provably gone
 * (ESRCH, or a recycled pid) protects nothing and is removed.
 *
 * ── What GC removes ──────────────────────────────────────────────────────
 * For THIS process's pack target only (an x64 Inspector under Rosetta on the
 * same machine cleans up its own when it runs):
 *
 *   - version directories named by no live record AND holding no use
 *     reservation — decided and claimed (a rename) inside the install root's
 *     lifecycle lock, the same lock a reservation is taken under, so a session
 *     can never reserve a directory GC is removing;
 *   - an orphaned `<version>.mcpjam-previous` (activation completed; or, if
 *     the version is missing, it is put back instead);
 *   - staging directories whose owner is provably gone, and retirements a
 *     previous GC claimed but did not finish deleting;
 *   - Inspector layers no live record names.
 *
 * A version directory without an install marker is left alone: whatever it
 * is, nothing proves it is unwanted.
 *
 * Runs at boot (after the janitor has reclaimed orphaned sessions) and after
 * every activation.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import { inspectorLayerBase, inspectorLayerDigest, removeReadOnlyTree } from "./inspector-layer.js";
import { PACK_RECORDS, PERMITTED_PACK_RECORDS } from "./pack-digests.generated.js";
import {
  forgetOperationRecord,
  harnessTargetInstallRoot,
  installRootKey,
  ownerProvablyGone,
  PREVIOUS_SUFFIX,
  processStartedAt,
  recoverInterruptedActivation,
  retireVersionDirectory,
  sweepAbandonedStaging,
  sweepRetired,
} from "./runtime-lifecycle.js";
import { runtimeInstallRoot } from "./runtime-root.js";
import {
  localPackTarget,
  SUPPORTED_LOCAL_HARNESS_IDS,
  type LocalPackTarget,
  type SupportedLocalHarnessId,
} from "./targets.js";

const LIVENESS_DIR = ".mcpjam-liveness";
const INSTALL_MARKER = ".mcpjam-pack-installed.json";

export interface LivenessRecord {
  pid: number;
  startedAt: number;
  updatedAt: number;
  target: LocalPackTarget | null;
  /** Pack tree digests this Inspector may select, per harness. */
  packs: Partial<Record<SupportedLocalHarnessId, string[]>>;
  /** Inspector layer digests (hex) this Inspector runs. */
  layers: string[];
}

/** What THIS build may select and run, for its own target. */
export function selectableSet(
  target: LocalPackTarget | null = localPackTarget(),
  extra: Partial<Record<SupportedLocalHarnessId, string[]>> = {},
): Pick<LivenessRecord, "packs" | "layers"> {
  const packs: Partial<Record<SupportedLocalHarnessId, string[]>> = {};
  const layers: string[] = [];
  for (const harnessId of SUPPORTED_LOCAL_HARNESS_IDS) {
    const digests = new Set<string>(extra[harnessId] ?? []);
    if (target !== null) {
      const desired = PACK_RECORDS[harnessId]?.[target];
      const permitted = PERMITTED_PACK_RECORDS[harnessId]?.[target];
      if (desired) digests.add(desired.treeDigest);
      if (permitted) digests.add(permitted.treeDigest);
    }
    packs[harnessId] = [...digests];
    const layer = inspectorLayerDigest(harnessId);
    if (layer) layers.push(layer.replace(/^sha256:/, ""));
  }
  return { packs, layers };
}

const livenessDir = (root: string) => join(root, LIVENESS_DIR);
const ownLivenessFile = (root: string) => join(livenessDir(root), `${process.pid}-${processStartedAt()}.json`);

/** Write (or refresh) this process's liveness record. */
export async function writeLivenessRecord(
  root: string = runtimeInstallRoot(),
  extra: Partial<Record<SupportedLocalHarnessId, string[]>> = {},
): Promise<void> {
  const target = localPackTarget();
  const record: LivenessRecord = {
    pid: process.pid,
    startedAt: processStartedAt(),
    updatedAt: Date.now(),
    target,
    ...selectableSet(target, extra),
  };
  await mkdir(livenessDir(root), { recursive: true, mode: 0o700 });
  const file = ownLivenessFile(root);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** Every liveness record whose owner is not provably gone; dead ones are removed. */
export async function readLiveRecords(root: string = runtimeInstallRoot()): Promise<LivenessRecord[]> {
  let names: string[];
  try {
    names = await readdir(livenessDir(root));
  } catch {
    return [];
  }
  const live: LivenessRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(livenessDir(root), name);
    let record: LivenessRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as LivenessRecord;
    } catch {
      continue; // half-written by a live writer, or garbage: protects nothing, deletes nothing
    }
    if (!Number.isInteger(record.pid) || !Number.isFinite(record.startedAt)) continue;
    if (ownerProvablyGone({ ownerPid: record.pid, ownerStartedAt: record.startedAt })) {
      await rm(file, { force: true }).catch(() => {});
      continue;
    }
    live.push(record);
  }
  return live;
}

/** The union of what every live Inspector (and this one) may select. */
function protectedSets(records: LivenessRecord[], own: Pick<LivenessRecord, "packs" | "layers">) {
  const packs = new Map<SupportedLocalHarnessId, Set<string>>();
  const layers = new Set<string>(own.layers);
  for (const record of [...records, { ...own, pid: process.pid, startedAt: 0, updatedAt: 0, target: null }]) {
    for (const [harnessId, digests] of Object.entries(record.packs ?? {})) {
      const set = packs.get(harnessId as SupportedLocalHarnessId) ?? new Set<string>();
      for (const digest of digests ?? []) set.add(digest);
      packs.set(harnessId as SupportedLocalHarnessId, set);
    }
    for (const layer of record.layers ?? []) layers.add(layer);
  }
  return { packs, layers };
}

export interface GcReport {
  removedVersions: string[];
  keptVersions: string[];
  removedLayers: string[];
  stagingRemoved: number;
}

async function markerDigest(versionRoot: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await readFile(join(versionRoot, INSTALL_MARKER), "utf8")) as { treeDigest?: unknown };
    return typeof marker.treeDigest === "string" ? marker.treeDigest : null;
  } catch {
    return null;
  }
}

/** Collect garbage under a runtime root, for this process's target. Never throws. */
export async function collectRuntimeGarbage(options: {
  root?: string;
  target?: LocalPackTarget | null;
  /** Digests this process must keep beyond its compatibility record (dev override). */
  extra?: Partial<Record<SupportedLocalHarnessId, string[]>>;
} = {}): Promise<GcReport> {
  const root = options.root ?? runtimeInstallRoot();
  const target = options.target === undefined ? localPackTarget() : options.target;
  const report: GcReport = { removedVersions: [], keptVersions: [], removedLayers: [], stagingRemoved: 0 };
  if (target === null) return report;
  const own = selectableSet(target, options.extra);
  try {
    const initial = protectedSets(await readLiveRecords(root), own);
    for (const harnessId of SUPPORTED_LOCAL_HARNESS_IDS) {
      const installRoot = harnessTargetInstallRoot(root, harnessId, target);
      const key = installRootKey(root, harnessId, target);
      let entries: string[];
      try {
        entries = await readdir(installRoot);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(PREVIOUS_SUFFIX)) continue;
        const versionRoot = join(installRoot, entry.slice(0, -PREVIOUS_SUFFIX.length));
        await recoverInterruptedActivation({ key, versionRoot }).catch(() => false);
      }
      for (const entry of await readdir(installRoot).catch(() => [] as string[])) {
        if (entry.startsWith(".") || entry.endsWith(PREVIOUS_SUFFIX)) continue;
        // Claude Code's install root is the runtime root's target directory,
        // which also holds nothing else; Codex's is `<root>/codex/<target>`.
        const versionRoot = join(installRoot, entry);
        const digest = await markerDigest(versionRoot);
        if (digest === null) continue;
        const label = `${harnessId}/${target}/${entry}`;
        if (initial.packs.get(harnessId)?.has(digest)) {
          report.keptVersions.push(label);
          continue;
        }
        const removed = await retireVersionDirectory({
          key,
          versionRoot,
          // Re-asked inside the lock: an Inspector that started since the
          // first read may name it now.
          stillUnwanted: async () => !protectedSets(await readLiveRecords(root), own).packs.get(harnessId)?.has(digest),
        });
        if (removed) {
          report.removedVersions.push(label);
          await forgetOperationRecord({ ...key, packVersion: entry, treeDigest: digest }).catch(() => {});
        } else {
          report.keptVersions.push(label);
        }
      }
      report.stagingRemoved += (await sweepAbandonedStaging(key)).removed;
      report.stagingRemoved += await sweepRetired(key);
    }

    const layerBase = inspectorLayerBase(root);
    for (const entry of await readdir(layerBase).catch(() => [] as string[])) {
      const leftover = entry.startsWith(".mcpjam-retired-");
      if (!leftover && (!/^[0-9a-f]{64}$/.test(entry) || initial.layers.has(entry))) continue;
      if (!leftover && protectedSets(await readLiveRecords(root), own).layers.has(entry)) continue;
      await removeReadOnlyTree(join(layerBase, entry));
      report.removedLayers.push(entry.slice(0, 12));
    }
  } catch (error) {
    logger.warn("[local-harness] runtime GC stopped early", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (report.removedVersions.length > 0 || report.removedLayers.length > 0) {
    logger.info("[local-harness] runtime GC", {
      removedVersions: report.removedVersions,
      removedLayers: report.removedLayers.length,
    });
  }
  return report;
}
