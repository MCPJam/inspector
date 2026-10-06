/**
 * Installing runtime packs — the one place third-party trees get onto the
 * user's machine, the one place they are proven to be ours, and the place a
 * build decides which installed pack it runs.
 *
 * ── When a pack is downloaded ────────────────────────────────────────────
 * Updates are routine, and happen in the background (the update policy,
 * `runtime-update-policy.ts`, is `auto` unless an administrator set `manual`):
 *
 *   - at server boot, when this machine already holds a durable
 *     authorization for the harness (somebody chose to run it here);
 *   - from the Playground's readiness check, when the desired pack is not the
 *     one installed;
 *   - on the explicit "Install & allow" gesture, and `harness install`.
 *
 * Under `manual` only `harness install` (and `--from` pre-provisioning)
 * install. A turn never waits on a download it does not need: while a
 * candidate desired pack downloads and probes, new sessions run on the
 * permitted previous pack. Only a first-time install waits, with progress.
 *
 * ── Which installed pack runs (invariant 4) ──────────────────────────────
 * `readRuntimeInstallStatus` SELECTS, per build, with no shared pointer
 * (`runtime-selection.ts`): the desired pack if installed, healthy and not
 * revoked; else the one permitted previous pack under the same conditions.
 * A revoked digest (`runtime-revocation.ts`) is never selected.
 *
 * ── The candidate flow ───────────────────────────────────────────────────
 * Each stage is named, so a failure says where it stopped
 * (`install_failed{stage}`):
 *
 *   disk-space  the signed manifest first, then free space against its size;
 *   download    the archive, streamed and hashed;
 *   verify      signature → archive sha → extracted tree digest, each
 *               covering the next (extraction is where a traversal, a link or
 *               a truncated write would land, so the tree is digested too);
 *   probe       this build's Inspector layer started on the staged pack, and
 *               the vendor binary's version handshake (`runtime-probe.ts`);
 *   activate    one rename into place, with the probe recorded as the pack's
 *               health (`runtime-health.ts`). Only now is it selectable.
 *
 * A candidate that fails any stage is never activated, so never selected.
 *
 * ── Atomicity, and who else is holding the door ──────────────────────────
 * Extraction goes into a sibling `.mcpjam-tmp-*` directory and is renamed into
 * place only after every stage passes. Another Inspector window, the install
 * CLI and running sessions all reach the same root; `runtime-lifecycle.ts`
 * coordinates them, and every irreversible step asks it immediately before
 * taking the step.
 *
 * ── Cleanup ──────────────────────────────────────────────────────────────
 * Old versions are reclaimed by `runtime-gc.ts`, after every activation and at
 * boot: only versions no live Inspector may select and no session holds.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { x as extractTar } from "tar";
import { logger } from "../../logger.js";
import { runtimeInstallRoot } from "./runtime-root.js";
import {
  PACK_RECORDS,
  PERMITTED_PACK_RECORDS,
} from "./pack-digests.generated.js";
import { chooseRuntime, type CandidateFacts, type RuntimeRole } from "./runtime-selection.js";
import {
  isUnhealthy,
  newHealthRecord,
  readRuntimeHealth,
  writeRuntimeHealth,
} from "./runtime-health.js";
import { isPackRevoked, readCachedRevocations, refreshRevocations, revocationFor } from "./runtime-revocation.js";
import { probeRuntimeCandidate } from "./runtime-probe.js";
import { emitLocalRuntimeEvent } from "./runtime-metrics.js";
import {
  isBackgroundTrigger,
  readLocalRuntimeUpdatePolicy,
  triggerAllowed,
  type RuntimeInstallTrigger,
} from "./runtime-update-policy.js";
import { collectRuntimeGarbage, writeLivenessRecord } from "./runtime-gc.js";
import { predictManagedRuntimeId } from "./runtime-identity.js";
import { installerFetch } from "./runtime-fetch.js";
import { packAssetStem, packReleaseBaseUrl } from "./pack-naming.js";
import { PACK_SIGNING_KEYS, verifyPackManifestSignature, type PackSigningKey } from "./pack-signing-key.js";
import {
  clearRuntimeVerificationCache,
  computeTreeDigest,
  resolveManagedBundle,
} from "./runtime-identity.js";
import {
  LOCAL_HARNESS_MANIFEST,
  type LocalHarnessCompatibility,
} from "./compatibility.js";
import {
  attemptStillOwns,
  beginInstallAttempt,
  claimStagingDirectory,
  harnessTargetInstallRoot,
  operationKeyString,
  PREVIOUS_SUFFIX,
  readRuntimeOperation,
  recoverInterruptedActivation,
  resetRuntimeLifecycleForTests,
  runtimeUseState,
  STAGING_PREFIX,
  sweepAbandonedStaging,
  updateInstallAttempt,
  withRuntimeLifecycleLock,
  type RuntimeInstallStage,
  type RuntimeOperationKey,
  type RuntimeOperationRecord,
} from "./runtime-lifecycle.js";
import {
  currentLocalPlatform,
  localPackTarget,
  SUPPORTED_LOCAL_HARNESS_IDS,
  type LocalPackTarget,
  type LocalPlatform,
  type SupportedLocalHarnessId,
} from "./targets.js";

/** Ceiling on a downloaded archive. A pack compresses to roughly 150-200 MB;
 *  anything past this is not an artifact we published. */
const MAX_ARCHIVE_BYTES = 1_500 * 1024 * 1024;
/** Ceiling on the extracted tree, matching the digest walk's own limit. */
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Where packs live (see `runtime-root.ts`). */
export { runtimeInstallRoot };

/**
 * The directory a pack activates into, and the `runtimeRoot` the availability
 * gate is then given.
 *
 * Keyed by TARGET as well as version. On an Apple Silicon Mac an arm64
 * Inspector and a Rosetta x64 one share a home directory and would otherwise
 * activate two different artifacts — same version, different machine code — at
 * the same path: installing either would delete the other's runtime out from
 * under any session using it. A target segment makes them neighbours instead,
 * and gives the version sweep a scope that cannot reach across architectures.
 */
export function packVersionRoot(
  harnessId: SupportedLocalHarnessId,
  packVersion: string,
  target: LocalPackTarget | null = localPackTarget(),
): string {
  return join(targetInstallRoot(harnessId, target), packVersion);
}

/**
 * Where every version of one harness's pack for one target lives — harness
 * scoped, because each harness's pack is versioned independently (see
 * `harnessTargetInstallRoot`).
 */
function targetInstallRoot(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget | null,
): string {
  return harnessTargetInstallRoot(
    runtimeInstallRoot(),
    harnessId,
    target ?? packPlatformKey(),
  );
}

/**
 * Why an install attempt ended, where the cause is actually known.
 *
 * Classified rather than guessed: the UI says something different for each,
 * and "something went wrong" for all four is the copy this replaced. `unknown`
 * is used honestly — an error whose cause cannot be established says so
 * instead of being filed under whichever bucket looks plausible.
 */
export type RuntimeInstallFailureReason =
  | "network"
  | "verification"
  | "disk"
  /** The candidate verified but this build's layer could not start on it. */
  | "probe"
  | "unknown";

export type { RuntimeInstallStage, RuntimeInstallTrigger, RuntimeRole };

/**
 * The state of the RUNTIME, as one value the UI renders from.
 *
 * Two different questions are folded into this union, deliberately, because a
 * caller asking "can a turn run?" needs one answer:
 *
 *   - OPERATION states — `downloading`, `verifying`, `failed`, `interrupted` —
 *     describe an install attempt. They come from the cross-process operation
 *     record, so a second Inspector sees the first one's progress.
 *   - RUNTIME-HEALTH states — `absent`, `ready`, `corrupt` — describe what is
 *     on disk. `corrupt` means a pack IS installed and does not verify, which
 *     is a repair, not a failed download.
 *
 * `failed` and `interrupted` are RETAINED until the next explicit attempt. A
 * failed download that decayed back to `absent` on the next poll is how the
 * old shape lost the only thing the user needed to see.
 */
export type RuntimeInstallStatus =
  | { state: "unsupported-platform"; message: string }
  | { state: "absent"; packVersion: string }
  | {
      state: "downloading";
      packVersion: string;
      percent: number;
      attemptId?: string;
    }
  | { state: "verifying"; packVersion: string; attemptId?: string }
  | {
      state: "ready";
      packVersion: string;
      runtimeRoot: string;
      digest: string;
      /** Which of this build's packs was selected (absent: the desired one). */
      role?: RuntimeRole;
      /** Selected although marked unhealthy, because nothing healthier is installed. */
      health?: "unhealthy";
      /** The desired pack's own state, when the selected one is the permitted previous. */
      update?: RuntimeInstallStatus;
    }
  /** A pack is installed and does not verify. Repairable, not re-downloadable. */
  | { state: "corrupt"; packVersion: string; message: string }
  /** The desired pack was withdrawn, and no permitted previous pack is usable. */
  | { state: "revoked"; packVersion: string; message: string }
  | {
      state: "failed";
      packVersion: string;
      reason: RuntimeInstallFailureReason;
      /** How far the candidate got. */
      stage?: RuntimeInstallStage;
      message: string;
      attemptId?: string;
    }
  /** An attempt whose owner went away partway through. Retry resumes from zero. */
  | { state: "interrupted"; packVersion: string; message: string; attemptId?: string };

/** Is this a state nothing further will happen from without a new gesture? */
export function isTerminalInstallStatus(status: RuntimeInstallStatus): boolean {
  return (
    status.state !== "downloading" &&
    status.state !== "verifying"
  );
}

export interface PackManifest {
  schema: string;
  harnessId: string;
  packVersion: string;
  adapterVersion: string;
  platform: string;
  nodeVersion: string;
  treeDigest: string;
  files: number;
  bytes: number;
  archive?: { name: string; sha256: string };
}

/**
 * Which pack this Inspector build expects, for a platform.
 *
 * `null` means no pack was built for this platform, which is a refusal the UI
 * shows rather than an error — it is the honest state for, say, Windows before
 * the Job Object work lands.
 */
export function expectedPackFor(
  harnessId: SupportedLocalHarnessId,
  /**
   * The OS **and** architecture, because that is what a pack is built for. A
   * lookup by OS alone would hand a darwin-x64 machine the darwin-arm64 digest.
   */
  target: LocalPackTarget,
): { packVersion: string; treeDigest: string } | null {
  const override = developmentPackExpectation();
  if (override !== null) return override;
  const record = PACK_RECORDS[harnessId]?.[target];
  if (record === undefined) return null;
  return { packVersion: record.packVersion, treeDigest: record.treeDigest };
}

/**
 * The one previous pack this build was tested against and may fall back to,
 * for a target — or null. None under the development override: a locally
 * built pack has no previous one.
 */
export function permittedPackFor(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget,
): { packVersion: string; treeDigest: string } | null {
  if (developmentPackExpectation() !== null) return null;
  const record = PERMITTED_PACK_RECORDS[harnessId]?.[target];
  if (record === undefined) return null;
  return { packVersion: record.packVersion, treeDigest: record.treeDigest };
}

/**
 * May this build select this pack at all? Its desired or permitted pack, and
 * not revoked. The availability gate asks this of the digest a turn names.
 */
export async function isSelectablePack(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget,
  treeDigest: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const candidates = [expectedPackFor(harnessId, target), permittedPackFor(harnessId, target)];
  if (!candidates.some((pack) => pack?.treeDigest === treeDigest)) {
    return {
      ok: false,
      message: "that runtime pack is neither the desired nor the permitted pack of this Inspector build",
    };
  }
  const revoked = await isPackRevoked(harnessId, treeDigest);
  if (revoked !== null) {
    return { ok: false, message: `that runtime pack was withdrawn by MCPJam (${revoked.reason})` };
  }
  return { ok: true };
}

/**
 * A build- and development-time expectation, from
 * `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK=<version>:sha256:<hex>`.
 *
 * The pack build has to be able to prove the INSTALLER accepts what it just
 * produced, and at that moment the generated digest table cannot possibly name
 * the digest — the build is what produces it. Without this the verification
 * step could only ever run against a pack from a previous release, which is not
 * the artifact about to be published.
 *
 * Honoured ONLY when `MCPJAM_LOCAL_HARNESS_PACK_SOURCE` is also set. That is
 * what keeps it from being a way to widen what a shipped Inspector will
 * install: on its own it names a digest but no source, so the installer still
 * only fetches the release asset and still only accepts the digest this build
 * carries. Both together mean somebody is deliberately installing a local pack
 * they built, which is the case this exists for.
 */
function developmentPackExpectation(): {
  packVersion: string;
  treeDigest: string;
} | null {
  const source = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  const expected = process.env.MCPJAM_LOCAL_HARNESS_EXPECTED_PACK;
  if (!source || !expected) return null;
  const separator = expected.indexOf(":");
  if (separator <= 0) return null;
  const packVersion = expected.slice(0, separator).trim();
  const treeDigest = expected.slice(separator + 1).trim();
  if (packVersion.length === 0) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(treeDigest)) return null;
  return { packVersion, treeDigest };
}

/**
 * The release asset a pack is downloaded from.
 *
 * Packs are attached to the GitHub Release the existing `release.yml` already
 * creates, so there is no new hosting, no new credentials, and the artifact is
 * served from the same place as everything else in a release. The override
 * exists for development against a locally built pack, and takes a file path
 * or a URL.
 */
export function packSourceFor(
  harnessId: SupportedLocalHarnessId,
  packVersion: string,
  platformKey: string,
): { kind: "file" | "url"; location: string } {
  const override = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  if (override && override.trim().length > 0) {
    const value = override.trim();
    return /^https?:\/\//.test(value)
      ? { kind: "url", location: value }
      : { kind: "file", location: value.replace(/^file:\/\//, "") };
  }
  // Pack releases have their own version, independent of Inspector releases
  // and of every other harness's pack.
  return {
    kind: "url",
    location:
      packReleaseBaseUrl(harnessId, packVersion) +
      `${packAssetStem(harnessId, platformKey, packVersion)}.tar.gz`,
  };
}

/**
 * Platform key as the pack build names it: `<os>-<arch>`.
 *
 * Deliberately a plain string and not `LocalPackTarget`: this is what goes in
 * a user-facing message about a machine we have NO pack for, so it has to be
 * able to say `linux-riscv64`. `localPackTarget` is the one that answers
 * whether a pack exists.
 */
export function packPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/**
 * Report what is on disk and what an install attempt is doing, cheaply.
 *
 * Two sources, one answer:
 *
 *   - the cross-process OPERATION record, so a poll in this window sees the
 *     install another window (or the CLI) is running, and so a `failed` or
 *     `interrupted` attempt stays visible until somebody explicitly retries;
 *   - the activation MARKER on disk, for `ready` / `absent`.
 *
 * Deliberately does not digest: this runs on every availability poll, and a
 * status call that hashed 515 MB would be a worse version of the problem the
 * verification cache exists to solve. `readVerifiedRuntimeStatus` below is the
 * one that actually proves a tree, for the callers that need proof.
 */
export async function readRuntimeInstallStatus(args: {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
  /**
   * The runtime a live grant names. If it is still selectable and healthy it
   * is selected, so an update activating in the background never refuses the
   * next turn of a session bound to the pack it replaced.
   */
  preferRuntimeId?: string | null;
}): Promise<RuntimeInstallStatus> {
  const resolved = resolveInstallTarget(args);
  if (!resolved.ok) return resolved.status;
  const desiredStatus = await readDesiredRuntimeStatus(args);
  const { expected, target, platform } = resolved;
  const revocations = await readCachedRevocations();
  const manifest = LOCAL_HARNESS_MANIFEST[args.harnessId];

  const facts = async (
    pack: { packVersion: string; treeDigest: string },
    installed: RuntimeInstallStatus,
  ): Promise<CandidateFacts & { status: RuntimeInstallStatus }> => {
    const versionRoot = packVersionRoot(args.harnessId, pack.packVersion, target);
    return {
      ...pack,
      installed: installed.state === "ready",
      revoked: revocationFor(revocations, args.harnessId, pack.treeDigest) !== null,
      unhealthy: isUnhealthy(await readRuntimeHealth(versionRoot), pack.treeDigest),
      status: installed,
    };
  };
  const desired = await facts(expected, desiredStatus);
  const permittedPack = permittedPackFor(args.harnessId, target);
  const permitted =
    permittedPack === null
      ? null
      : await facts(
          permittedPack,
          await readMarkerStatus({
            harnessId: args.harnessId,
            versionRoot: packVersionRoot(args.harnessId, permittedPack.packVersion, target),
            expected: permittedPack,
          }),
        );

  const preferTreeDigest =
    args.preferRuntimeId == null
      ? null
      : ([desired, permitted].find(
          (candidate) =>
            candidate !== null &&
            predictManagedRuntimeId(manifest, platform, candidate.treeDigest) === args.preferRuntimeId,
        )?.treeDigest ?? null);
  const choice = chooseRuntime({ desired, permitted, preferTreeDigest });

  // The desired pack's own state, annotated, for display beside a fallback.
  const desiredView = (): RuntimeInstallStatus =>
    desired.revoked
      ? {
          state: "revoked",
          packVersion: desired.packVersion,
          message: revokedMessage(args.harnessId, desired.packVersion, desired.treeDigest, revocations),
        }
      : desiredStatus.state === "ready" && desired.unhealthy
        ? { ...desiredStatus, health: "unhealthy" }
        : desiredStatus;

  if (choice.kind === "none") return choice.why === "revoked" ? desiredView() : desiredStatus;
  const chosen = choice.role === "desired" ? desired : permitted!;
  const ready = chosen.status as Extract<RuntimeInstallStatus, { state: "ready" }>;
  return {
    ...ready,
    role: choice.role,
    ...(choice.degraded ? { health: "unhealthy" as const } : {}),
    ...(choice.role === "permitted" ? { update: desiredView() } : {}),
  };
}

function revokedMessage(
  harnessId: SupportedLocalHarnessId,
  packVersion: string,
  treeDigest: string,
  list: Awaited<ReturnType<typeof readCachedRevocations>>,
): string {
  const entry = revocationFor(list, harnessId, treeDigest);
  return (
    `MCPJam withdrew the ${harnessId} runtime ${packVersion}${entry ? ` (${entry.reason})` : ""}, and no ` +
    `earlier runtime this Inspector supports is installed. Update the Inspector to get a replacement.`
  );
}

/**
 * The DESIRED pack's status alone: the install operation and the marker, with
 * no selection. What an install acts on; `readRuntimeInstallStatus` is what a
 * turn runs on.
 */
export async function readDesiredRuntimeStatus(args: {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<RuntimeInstallStatus> {
  const resolved = resolveInstallTarget(args);
  if (!resolved.ok) return resolved.status;
  const { key, expected, versionRoot } = resolved;

  // Before reading anything: put back a runtime whose activation was
  // interrupted between its two renames. That machine has a perfectly good
  // pack and would otherwise report `absent` and be asked to download it
  // again.
  await recoverInterruptedActivation({ key, versionRoot });

  const inProcess = active.get(operationKeyString(key));
  if (inProcess !== undefined) return inProcess.status;

  const record = await readRuntimeOperation(key);
  if (record !== null && !isRecordTerminal(record)) {
    return operationRecordStatus(record);
  }

  const onDisk = await readMarkerStatus({
    harnessId: args.harnessId,
    versionRoot,
    expected,
  });
  // A ready runtime outranks a stale failure: another process may have
  // installed it since, and telling a user their install failed while a usable
  // pack sits on disk is worse than forgetting the failure.
  if (onDisk.state === "ready") return onDisk;
  if (record !== null && isRecordTerminal(record) && record.state !== "ready") {
    return operationRecordStatus(record);
  }
  return onDisk;
}

/**
 * The compatibility manifest with the digest this build actually expects.
 *
 * `resolveManagedBundle` verifies a tree against `manifest.runtime.bundleDigest`,
 * which is read from the generated `PACK_TREE_DIGESTS` table. `expectedPackFor`
 * reads the same table but ALSO honours the development override
 * (`MCPJAM_LOCAL_HARNESS_PACK_SOURCE` + `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK`) —
 * so the two disagreed exactly where it mattered most: a developer could
 * install a locally built pack, and then no turn could ever run from it,
 * because the session path looked for a digest the static table does not carry
 * and reported `bundle-absent`.
 *
 * One source of truth, then. `expectedPackFor` is a superset of the table (the
 * generated records and digests are written together and always agree), so
 * letting it decide costs nothing in a shipped build and makes the documented
 * development path work end to end.
 */
export function manifestWithExpectedBundleDigest<
  T extends LocalHarnessCompatibility,
>(
  manifest: T,
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget | null,
  /**
   * The SELECTED pack's digest, when a caller has a selection — the desired
   * pack's or the permitted previous one's. Callers pass what
   * `readRuntimeInstallStatus` selected; the availability gate separately
   * refuses a digest this build may not select (`isSelectablePack`).
   */
  selectedDigest?: string,
): T {
  if (target === null) return manifest;
  if (manifest.runtime.source !== "managed-bundle") return manifest;
  const expected =
    selectedDigest !== undefined ? { treeDigest: selectedDigest } : expectedPackFor(harnessId, target);
  if (expected === null) return manifest;
  if (manifest.runtime.bundleDigest[target] === expected.treeDigest) {
    return manifest;
  }
  return {
    ...manifest,
    runtime: {
      ...manifest.runtime,
      bundleDigest: {
        ...manifest.runtime.bundleDigest,
        [target]: expected.treeDigest,
      },
    },
  };
}

/**
 * The verified-ready fast path: is there a runtime a turn could actually run,
 * right now?
 *
 * The marker alone cannot answer this. It records what the install verified at
 * the time, so a pack whose bytes were replaced or truncated afterwards keeps
 * reporting `ready` from its own marker forever — and the caller that needs
 * this answer is deciding whether to SKIP a download and mint consent against
 * the runtime's identity. So this re-resolves the bundle, which re-digests the
 * tree at most once per process per (root, digest) pair through
 * `verifyRuntime`'s cache.
 *
 * A tree that fails verification comes back `corrupt`, which is a repair path
 * — reinstall this same version — and not the `failed` of a download that
 * never landed.
 */
export async function readVerifiedRuntimeStatus(args: {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Verify the desired pack rather than the selected one (an install's question). */
  desiredOnly?: boolean;
}): Promise<RuntimeInstallStatus> {
  const status = args.desiredOnly ? await readDesiredRuntimeStatus(args) : await readRuntimeInstallStatus(args);
  if (status.state !== "ready") return status;
  const platform = currentLocalPlatform(args.platform ?? process.platform);
  if (platform === null) return status;

  const resolvedBundle = await resolveManagedBundle({
    manifest: manifestWithExpectedBundleDigest(
      LOCAL_HARNESS_MANIFEST[args.harnessId],
      args.harnessId,
      localPackTarget(args.platform, args.arch),
      status.digest,
    ),
    runtimeRoot: status.runtimeRoot,
    platform,
    ...(args.arch ? { arch: args.arch } : {}),
  });
  if (resolvedBundle.ok) return status;
  return {
    state: "corrupt",
    packVersion: status.packVersion,
    message: resolvedBundle.message,
  };
}

/** The marker-only view: `ready`, `corrupt` (wrong digest recorded), `absent`. */
async function readMarkerStatus(args: {
  harnessId: SupportedLocalHarnessId;
  versionRoot: string;
  expected: { packVersion: string; treeDigest: string };
}): Promise<RuntimeInstallStatus> {
  try {
    const marker = JSON.parse(
      await readFile(join(args.versionRoot, INSTALL_MARKER), "utf8"),
    ) as { treeDigest?: string };
    if (marker.treeDigest !== args.expected.treeDigest) {
      return {
        state: "corrupt",
        packVersion: args.expected.packVersion,
        message:
          "the installed runtime pack does not match the digest this " +
          "Inspector expects; reinstall it",
      };
    }
    await stat(join(args.versionRoot, args.harnessId));
    return {
      state: "ready",
      packVersion: args.expected.packVersion,
      runtimeRoot: args.versionRoot,
      digest: args.expected.treeDigest,
    };
  } catch {
    return { state: "absent", packVersion: args.expected.packVersion };
  }
}

function isRecordTerminal(record: RuntimeOperationRecord): boolean {
  return (
    record.state === "ready" ||
    record.state === "failed" ||
    record.state === "interrupted"
  );
}

/** One operation record, as the status the UI renders. */
function operationRecordStatus(
  record: RuntimeOperationRecord,
): RuntimeInstallStatus {
  switch (record.state) {
    case "reserved":
    case "downloading":
      return {
        state: "downloading",
        packVersion: record.packVersion,
        percent: record.percent ?? 0,
        attemptId: record.attemptId,
      };
    case "verifying":
    case "activating":
      return {
        state: "verifying",
        packVersion: record.packVersion,
        attemptId: record.attemptId,
      };
    case "failed":
      return {
        state: "failed",
        packVersion: record.packVersion,
        reason: record.reason ?? "unknown",
        ...(record.stage ? { stage: record.stage } : {}),
        message: record.message ?? "the install did not complete",
        attemptId: record.attemptId,
      };
    case "interrupted":
      return {
        state: "interrupted",
        packVersion: record.packVersion,
        message:
          record.message ??
          "setup was interrupted before it finished",
        attemptId: record.attemptId,
      };
    case "ready":
      return {
        state: "ready",
        packVersion: record.packVersion,
        runtimeRoot: packVersionRoot(
          record.harnessId,
          record.packVersion,
          record.target,
        ),
        digest: record.treeDigest,
      };
  }
}

type ResolvedInstallTarget =
  | {
      ok: true;
      key: RuntimeOperationKey;
      expected: { packVersion: string; treeDigest: string };
      target: LocalPackTarget;
      platform: LocalPlatform;
      versionRoot: string;
    }
  | { ok: false; status: RuntimeInstallStatus };

/**
 * The platform, target, expected pack and operation key for a call, or the
 * refusal that stands in for all of them.
 *
 * Shared by every entry point below so that "what pack is this machine talking
 * about?" is answered once. Two callers deriving it separately is how a status
 * poll and an install can end up discussing different artifacts.
 */
function resolveInstallTarget(args: {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
}): ResolvedInstallTarget {
  const platform = currentLocalPlatform(args.platform ?? process.platform);
  if (platform === null) {
    return {
      ok: false,
      status: {
        state: "unsupported-platform",
        message: `${args.platform ?? process.platform} has no local harness runtime`,
      },
    };
  }
  const target = localPackTarget(args.platform, args.arch);
  const expected =
    target === null ? null : expectedPackFor(args.harnessId, target);
  if (expected === null || target === null) {
    return {
      ok: false,
      status: {
        state: "unsupported-platform",
        message:
          `no ${args.harnessId} runtime pack has been built for ` +
          `${packPlatformKey(args.platform, args.arch)}`,
      },
    };
  }
  return {
    ok: true,
    platform,
    target,
    expected,
    versionRoot: packVersionRoot(args.harnessId, expected.packVersion, target),
    key: {
      runtimeRoot: runtimeInstallRoot(),
      harnessId: args.harnessId,
      target,
      packVersion: expected.packVersion,
      treeDigest: expected.treeDigest,
    },
  };
}

/**
 * Marker written INSIDE the version directory but OUTSIDE the digested tree.
 *
 * The digest covers `<version>/<harnessId>`; this sits one level up, so
 * writing it cannot change the digest of the thing it vouches for.
 */
const INSTALL_MARKER = ".mcpjam-pack-installed.json";

interface ActiveInstall {
  status: RuntimeInstallStatus;
  promise: Promise<RuntimeInstallStatus>;
}

/**
 * In-process single flight, keyed by the full operation identity.
 *
 * The cross-process record is what stops a SECOND Inspector from starting a
 * second extraction; this stops two callers in THIS one from racing to write
 * it. Keyed by the whole identity rather than the version, for the same reason
 * the record is: two builds expecting different packs are two operations.
 */
const active = new Map<string, ActiveInstall>();

/** Test seam: in-process single flight is module state by design. */
export function resetRuntimeInstallStateForTests(): void {
  active.clear();
  resetRuntimeLifecycleForTests();
}

export interface InstallRuntimePackOptions {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
  /**
   * The pack the CALLER approved, if it captured one.
   *
   * Compared against what this build expects before a byte is downloaded. A
   * server that updated between the dialog opening and Install & allow being
   * clicked would otherwise download a different runtime than the one whose
   * version and digest the user was shown — and consent binds to a runtime
   * identity, so that is a different thing than the one they approved.
   */
  expectedPack?: { packVersion: string; treeDigest: string };
  /** Progress callback for the UI. Called with monotonically increasing
   *  percentages during download only; verification has no meaningful
   *  fraction to report. */
  onProgress?: (status: RuntimeInstallStatus) => void;
  signal?: AbortSignal;
  /**
   * What asked for this install. The update policy decides which triggers may
   * install (`manual` admits only `cli` and `provision`), and background
   * triggers back off after a recent failure instead of retrying on every boot
   * and every readiness check. Defaults to `gesture`.
   */
  trigger?: RuntimeInstallTrigger;
  /**
   * Pre-provisioning: install from a local archive with NO network. Its signed
   * manifest and signature must sit beside it under their release names
   * (`<stem>.manifest.json`, `<stem>.manifest.json.sig`), and every check a
   * download gets still applies — signature, archive sha, tree digest against
   * the pack this build pins. Unlike the development override, an unsigned
   * archive is refused.
   */
  fromArchive?: string;
}

/** Background retries wait this long after a candidate failed verification or its probe… */
const BACKOFF_AFTER_BAD_CANDIDATE_MS = 6 * 60 * 60 * 1000;
/** …and this long after any other failure (offline, disk). */
const BACKOFF_AFTER_FAILURE_MS = 10 * 60 * 1000;

/** How long a background trigger waits before re-probing a pack marked unhealthy. */
const REPROBE_UNHEALTHY_AFTER_MS = 60 * 60 * 1000;

/**
 * Re-run the startup probe on the INSTALLED desired pack and, if it passes,
 * write it a fresh health record (clearing the unhealthy mark). Shared by
 * `startRuntimeInstall` and `harness repair`.
 */
async function reprobeInstalledPack(args: {
  harnessId: SupportedLocalHarnessId;
  resolved: Extract<ResolvedInstallTarget, { ok: true }>;
  health: Awaited<ReturnType<typeof readRuntimeHealth>>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { versionRoot, expected, target, platform } = args.resolved;
  const probe = await probeRuntimeCandidate({
    harnessId: args.harnessId,
    packRoot: join(versionRoot, args.harnessId),
    platform,
    target,
    layerRuntimeRoot: runtimeInstallRoot(),
  });
  if (!probe.ok) {
    return { ok: false, message: `the installed ${expected.packVersion} still fails its startup probe: ${probe.message}` };
  }
  await writeRuntimeHealth(
    versionRoot,
    newHealthRecord({
      packVersion: expected.packVersion,
      treeDigest: expected.treeDigest,
      probe: { at: Date.now(), node: probe.node, vendorVersion: probe.vendorVersion },
      ...(args.health?.installStartedAt !== undefined ? { installStartedAt: args.health.installStartedAt } : {}),
      ...(args.health?.activatedAt !== undefined ? { activatedAt: args.health.activatedAt } : {}),
      ...(args.health?.activatedAsUpdate !== undefined ? { activatedAsUpdate: args.health.activatedAsUpdate } : {}),
    }),
  );
  return { ok: true };
}

export const MANUAL_UPDATES_MESSAGE =
  "Runtime updates on this machine are managed by your administrator (updates: manual). " +
  "Install with `mcpjam-inspector harness install`, or ask IT.";

export type StartRuntimeInstallResult =
  /** This call started the work. Poll for progress. */
  | { kind: "started"; status: RuntimeInstallStatus; attemptId: string }
  /** Work was already running here or in another process. Poll for progress. */
  | { kind: "joined"; status: RuntimeInstallStatus; attemptId?: string }
  /** A verified runtime is already installed. Nothing was downloaded. */
  | { kind: "ready"; status: RuntimeInstallStatus }
  /** The request cannot start work at all. */
  | {
      kind: "refused";
      status: RuntimeInstallStatus;
      reason: string;
      /** Why, when it is not the request's fault: policy, revocation, backoff. */
      refusal?: "policy" | "revoked" | "backoff";
    };

/**
 * Start — or join — an install, and return as soon as that is decided.
 *
 * The shape `startChromiumInstall` established, for the same reason: the
 * reservation is made before any await that could let a second caller past the
 * same check. Here the in-process map is claimed synchronously, and only the
 * short cross-process reservation and the on-disk lookup are awaited — never
 * the download. The caller gets an acknowledgement in milliseconds and polls.
 *
 * The HTTP adapter turns this into 202 + `Location` + `Retry-After` for
 * `started` and `joined`, and 200 for `ready`.
 */
export async function startRuntimeInstall(
  options: InstallRuntimePackOptions,
): Promise<StartRuntimeInstallResult> {
  const resolved = resolveInstallTarget(options);
  if (!resolved.ok) {
    return {
      kind: "refused",
      status: resolved.status,
      reason:
        resolved.status.state === "unsupported-platform"
          ? resolved.status.message
          : "this machine has no runtime pack to install",
    };
  }
  const { key, expected, versionRoot } = resolved;

  // The approved pack, checked BEFORE anything is fetched.
  if (
    options.expectedPack !== undefined &&
    (options.expectedPack.packVersion !== expected.packVersion ||
      options.expectedPack.treeDigest !== expected.treeDigest)
  ) {
    return {
      kind: "refused",
      reason:
        "this Inspector now expects a different runtime than the one that " +
        "was approved, so it will not download it under that approval",
      status: {
        state: "failed",
        packVersion: expected.packVersion,
        reason: "verification",
        message:
          `the approved runtime was ${options.expectedPack.packVersion} ` +
          `(${options.expectedPack.treeDigest.slice(0, 19)}…) but this ` +
          `Inspector now expects ${expected.packVersion} ` +
          `(${expected.treeDigest.slice(0, 19)}…). Authorize the new one.`,
      },
    };
  }

  // Joining what is already running in THIS process needs no policy check:
  // somebody allowed to start it already did.
  const keyString = operationKeyString(key);
  const running = active.get(keyString);
  if (running !== undefined) {
    return { kind: "joined", status: running.status };
  }

  const trigger = options.trigger ?? "gesture";

  // A withdrawn pack is never downloaded, whoever asks. Refreshed first
  // (rate-limited, soft-failing, bounded by a timeout): selection reads only
  // the cache, and a new machine's first install has none, so without this a
  // pack MCPJam already withdrew would install and run. Provisioning from a
  // local archive is the offline path; it trusts the cache it has.
  if (trigger !== "provision") await refreshRevocations();
  const revoked = await isPackRevoked(options.harnessId, expected.treeDigest);
  if (revoked !== null) {
    const message =
      `MCPJam withdrew the ${options.harnessId} runtime ${expected.packVersion} (${revoked.reason}); ` +
      "update the Inspector to get a replacement.";
    return {
      kind: "refused",
      refusal: "revoked",
      reason: message,
      status: { state: "revoked", packVersion: expected.packVersion, message },
    };
  }

  await recoverInterruptedActivation({ key, versionRoot });

  // Already installed AND verified: no download, and the answer is as fresh as
  // the probe that produced it. The DESIRED pack — a fallback being selected
  // is exactly the case an install exists to end.
  const verified = await readVerifiedRuntimeStatus({ ...options, desiredOnly: true });
  if (verified.state === "ready") {
    // Installed and verified, but marked unhealthy after repeated launch
    // failures: selection has rolled back from it. The bytes are right, so
    // nothing is downloaded; the startup probe is re-run instead, and a pass
    // starts its health afresh. Background triggers do this at most hourly.
    const health = await readRuntimeHealth(versionRoot);
    if (isUnhealthy(health, expected.treeDigest)) {
      if (isBackgroundTrigger(trigger) && Date.now() - health!.unhealthy!.at < REPROBE_UNHEALTHY_AFTER_MS) {
        return {
          kind: "refused",
          refusal: "backoff",
          reason: "the installed runtime was marked unhealthy recently; it is re-checked later, or now on request",
          status: verified,
        };
      }
      const reprobed = await reprobeInstalledPack({ harnessId: options.harnessId, resolved, health });
      if (reprobed.ok) return { kind: "ready", status: await readRuntimeInstallStatus({ harnessId: options.harnessId }) };
      return {
        kind: "refused",
        reason: reprobed.message,
        status: { state: "failed", packVersion: expected.packVersion, reason: "probe", stage: "probe", message: reprobed.message },
      };
    }
    return { kind: "ready", status: verified };
  }

  // Only a NEW install is subject to the update policy: a runtime an
  // administrator already provisioned is answered as ready above, whoever asks.
  const policy = await readLocalRuntimeUpdatePolicy();
  if (!triggerAllowed(trigger, policy.policy)) {
    return {
      kind: "refused",
      refusal: "policy",
      reason: MANUAL_UPDATES_MESSAGE,
      status: { state: "absent", packVersion: expected.packVersion },
    };
  }

  // Nobody is waiting on a background trigger, so it does not hammer a
  // candidate that just failed (or a machine that is offline).
  if (isBackgroundTrigger(trigger)) {
    const last = await readRuntimeOperation(key);
    const age = last === null ? Infinity : Date.now() - last.updatedAt;
    const backoff =
      last?.state === "failed" &&
      (last.stage === "probe" || last.stage === "verify" ? age < BACKOFF_AFTER_BAD_CANDIDATE_MS : age < BACKOFF_AFTER_FAILURE_MS);
    if (backoff) {
      return {
        kind: "refused",
        refusal: "backoff",
        reason: "a recent attempt at this runtime failed; it is retried later, or now on request",
        status: operationRecordStatus(last),
      };
    }
  }

  const attempt = await beginInstallAttempt(key, { trigger });
  if (attempt.kind === "joined") {
    return {
      kind: "joined",
      status: operationRecordStatus(attempt.record),
      attemptId: attempt.record.attemptId,
    };
  }

  const record: ActiveInstall = {
    status: {
      state: "downloading",
      packVersion: expected.packVersion,
      percent: 0,
      attemptId: attempt.record.attemptId,
    },
    promise: Promise.resolve({
      state: "absent" as const,
      packVersion: expected.packVersion,
    }),
  };
  active.set(keyString, record);
  emitLocalRuntimeEvent("local_runtime_install_started", {
    harness_id: options.harnessId,
    pack_version: expected.packVersion,
    trigger,
  });
  record.promise = runInstallAttempt({
    options: { ...options, trigger },
    resolved,
    attemptId: attempt.record.attemptId,
    record,
    keyString,
  });
  // Deliberately NOT awaited: the whole point of this entry point is that the
  // caller is acknowledged now and polls. The rejection path is handled inside
  // `runInstallAttempt`, so this promise never rejects.
  void record.promise;

  return {
    kind: "started",
    status: record.status,
    attemptId: attempt.record.attemptId,
  };
}

/**
 * Install to completion.
 *
 * The CLI's entry point, and the one tests drive. Starts or joins exactly as
 * `startRuntimeInstall` does — so a CLI run and a window's install are one
 * operation — and then waits for the result.
 */
export async function installRuntimePack(
  options: InstallRuntimePackOptions,
): Promise<RuntimeInstallStatus> {
  const started = await startRuntimeInstall(options);
  if (started.kind === "ready" || started.kind === "refused") {
    return started.status;
  }
  const resolved = resolveInstallTarget(options);
  if (!resolved.ok) return resolved.status;
  const running = active.get(operationKeyString(resolved.key));
  if (running !== undefined) return running.promise;

  // Joined an attempt owned by ANOTHER process. There is nothing in this
  // process to await, so poll the shared record to its terminal state rather
  // than returning a progress value the caller would read as final.
  return awaitForeignAttempt(resolved.key, options);
}

/** Poll another process's attempt to a terminal state. */
async function awaitForeignAttempt(
  key: RuntimeOperationKey,
  options: InstallRuntimePackOptions,
): Promise<RuntimeInstallStatus> {
  for (;;) {
    if (options.signal?.aborted === true) {
      return readRuntimeInstallStatus(options);
    }
    const record = await readRuntimeOperation(key);
    if (record === null) return readRuntimeInstallStatus(options);
    if (isRecordTerminal(record)) {
      // `ready` is answered from disk, not from the record: the other process
      // says it activated, and the marker is what proves it.
      return record.state === "ready"
        ? readRuntimeInstallStatus(options)
        : operationRecordStatus(record);
    }
    options.onProgress?.(operationRecordStatus(record));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

/**
 * Run one owned attempt, keeping the shared record and the in-process status
 * in step, and never rejecting.
 */
async function runInstallAttempt(args: {
  options: InstallRuntimePackOptions;
  resolved: Extract<ResolvedInstallTarget, { ok: true }>;
  attemptId: string;
  record: ActiveInstall;
  keyString: string;
}): Promise<RuntimeInstallStatus> {
  const { options, resolved, attemptId, record, keyString } = args;
  const { key, expected } = resolved;

  const setStatus = (status: RuntimeInstallStatus) => {
    record.status = status;
    options.onProgress?.(status);
    // Fire-and-forget: the shared record is how ANOTHER process sees progress,
    // and a percentage that lands a beat late is not worth serializing the
    // download behind a lock. The states that matter for correctness —
    // `activating`, and the terminal ones — are awaited below.
    void updateInstallAttempt(key, attemptId, {
      state:
        status.state === "downloading"
          ? "downloading"
          : status.state === "verifying"
            ? "verifying"
            : "reserved",
      ...(status.state === "downloading" ? { percent: status.percent } : {}),
    }).catch(() => {});
  };

  const startedAt = Date.now();
  const trigger = options.trigger ?? "gesture";
  try {
    const { status: result, activatedAsUpdate } = await performInstall({
      ...options,
      platform: resolved.platform,
      expected,
      key,
      attemptId,
      setStatus,
      installStartedAt: startedAt,
    });
    record.status = result;
    emitLocalRuntimeEvent("local_runtime_install_succeeded", {
      harness_id: options.harnessId,
      pack_version: expected.packVersion,
      trigger,
      duration_ms: Date.now() - startedAt,
    });
    if (activatedAsUpdate) {
      emitLocalRuntimeEvent("local_runtime_update_activated", {
        harness_id: options.harnessId,
        pack_version: expected.packVersion,
        trigger,
      });
    }
    // The version this replaced is now reclaimable unless something still
    // selects or holds it; asked of every live Inspector, not assumed.
    void collectRuntimeGarbage({ extra: ownExpectedDigests() }).catch(() => {});
    // Best-effort, exactly as the failure path below already is. `record.status`
    // above has already recorded the true outcome; this write only publishes it
    // to the shared operation file, and `writeJsonAtomic` can reject on ENOSPC
    // or EROFS — the very conditions a 515 MB extraction just ran into. Left
    // unguarded, a successfully installed runtime was reclassified as `failed`
    // by the `catch` below, and `record.promise` (consumed by `void` in
    // `startRuntimeInstall`) rejected with nobody attached, which under Node's
    // default unhandled-rejection policy takes the server down.
    await updateInstallAttempt(key, attemptId, {
      state: result.state === "ready" ? "ready" : "failed",
      ...(result.state === "failed"
        ? { reason: result.reason, message: result.message }
        : {}),
    }).catch(() => {});
    return result;
  } catch (error) {
    const failure = classifyInstallFailure(error, expected.packVersion);
    logger.warn("[local-harness] runtime pack install failed", {
      reason: failure.reason,
      stage: failure.stage,
      message: failure.message,
    });
    record.status = failure;
    emitLocalRuntimeEvent("local_runtime_install_failed", {
      harness_id: options.harnessId,
      pack_version: expected.packVersion,
      trigger,
      reason: failure.reason,
      ...(failure.stage ? { stage: failure.stage } : {}),
      duration_ms: Date.now() - startedAt,
    });
    if (failure.stage === "probe") {
      emitLocalRuntimeEvent("local_runtime_candidate_probe_failed", {
        harness_id: options.harnessId,
        pack_version: expected.packVersion,
        trigger,
      });
    }
    await updateInstallAttempt(key, attemptId, {
      state: "failed",
      reason: failure.reason,
      ...(failure.stage ? { stage: failure.stage } : {}),
      message: failure.message,
    }).catch(() => {});
    return failure;
  } finally {
    active.delete(keyString);
  }
}

/**
 * Name the cause where it is knowable.
 *
 * Deliberately conservative. Each branch is a message a user can act on
 * differently — retry the network, reinstall, free some disk — so a guess that
 * lands in the wrong branch sends them somewhere useless. Anything this cannot
 * establish is `unknown`, which says so.
 */
export function classifyInstallFailure(
  error: unknown,
  packVersion: string,
): Extract<RuntimeInstallStatus, { state: "failed" }> {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const causeCode = (
    (error as { cause?: NodeJS.ErrnoException } | undefined)?.cause
  )?.code;

  const reason: RuntimeInstallFailureReason =
    code === "ENOSPC" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "EDQUOT"
      ? "disk"
      : code === "ENOTFOUND" ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "ECONNREFUSED" ||
          causeCode === "ENOTFOUND" ||
          causeCode === "ECONNRESET" ||
          causeCode === "ETIMEDOUT" ||
          causeCode === "ECONNREFUSED" ||
          /could not be downloaded|responded \d{3}|fetch failed|network/i.test(
            message,
          )
        ? "network"
        : /does not match|signature|signed manifest|no signed manifest|digest|exceeds its size ceiling|has no .* directory at its root/i.test(
              message,
            )
          ? "verification"
          : "unknown";

  const stage = (error as { installStage?: RuntimeInstallStage } | undefined)?.installStage;
  return {
    state: "failed",
    packVersion,
    reason:
      stage === "probe"
        ? "probe"
        : stage === "disk-space"
          ? "disk"
          : stage === "verify" && reason === "unknown"
            ? "verification"
            : reason,
    ...(stage ? { stage } : {}),
    message,
  };
}

/** Tag an error with the candidate stage it happened in. */
function atStage(stage: RuntimeInstallStage, error: unknown): Error {
  const tagged = error instanceof Error ? error : new Error(String(error));
  if ((tagged as { installStage?: RuntimeInstallStage }).installStage === undefined) {
    (tagged as { installStage?: RuntimeInstallStage }).installStage = stage;
  }
  return tagged;
}

/** The digests this process expects, per harness — what GC must keep for it. */
function ownExpectedDigests(): Partial<Record<SupportedLocalHarnessId, string[]>> {
  const target = localPackTarget();
  if (target === null) return {};
  return Object.fromEntries(
    SUPPORTED_LOCAL_HARNESS_IDS.map((harnessId) => [
      harnessId,
      [expectedPackFor(harnessId, target), permittedPackFor(harnessId, target)]
        .filter((pack): pack is { packVersion: string; treeDigest: string } => pack !== null)
        .map((pack) => pack.treeDigest),
    ]),
  );
}

type FreeSpaceProbe = (path: string) => Promise<number | null>;
const defaultFreeSpace: FreeSpaceProbe = async (path) => {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null; // unknowable here: do not refuse on a guess
  }
};
let freeSpaceProbe: FreeSpaceProbe = defaultFreeSpace;

/** Test seam: pretend the disk has this much room. */
export function setFreeSpaceProbeForTests(probe: FreeSpaceProbe | null): void {
  freeSpaceProbe = probe ?? defaultFreeSpace;
}

let manifestKeys: readonly PackSigningKey[] = PACK_SIGNING_KEYS;

/** Test seam: a test cannot sign with MCPJam's key, so it brings its own. */
export function setPackSigningKeysForTests(keys: readonly PackSigningKey[] | null): void {
  manifestKeys = keys ?? PACK_SIGNING_KEYS;
}

/** Headroom on top of the archive and the extracted tree. */
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

async function performInstall(args: {
  harnessId: SupportedLocalHarnessId;
  platform: LocalPlatform;
  arch?: string;
  expected: { packVersion: string; treeDigest: string };
  key: RuntimeOperationKey;
  attemptId: string;
  setStatus: (status: RuntimeInstallStatus) => void;
  signal?: AbortSignal;
  installStartedAt: number;
  fromArchive?: string;
}): Promise<{ status: RuntimeInstallStatus; activatedAsUpdate: boolean }> {
  const { expected, setStatus, key, attemptId } = args;
  const platformKey = packPlatformKey(args.platform, args.arch);
  const target = localPackTarget(args.platform, args.arch);
  const versionRoot = packVersionRoot(args.harnessId, expected.packVersion, target);
  // Per HARNESS and TARGET, so staging is confined to this pack's directory
  // and cannot touch another architecture's — or another harness's — runtime.
  const installRoot = targetInstallRoot(args.harnessId, target);
  await mkdir(installRoot, { recursive: true, mode: 0o700 });

  // Reclaim what is PROVABLY abandoned before adding to it. Never by prefix or
  // age: an extraction that cannot be proven dead belongs to somebody.
  await sweepAbandonedStaging(key);

  const staging = join(installRoot, `${STAGING_PREFIX}${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await claimStagingDirectory({ staging, attemptId });

  let stage: RuntimeInstallStage = "download";
  try {
    const source: { kind: "file" | "url"; location: string } =
      args.fromArchive !== undefined
        ? { kind: "file", location: args.fromArchive }
        : packSourceFor(args.harnessId, expected.packVersion, platformKey);
    const archivePath = join(staging, "pack.tar.gz");

    setStatus({
      state: "downloading",
      packVersion: expected.packVersion,
      percent: 0,
      attemptId,
    });

    // The signed manifest FIRST. It is a few kilobytes, it says how big the
    // pack is (so disk space can be checked before 200 MB arrive), and a
    // manifest that is not ours stops the install before the archive moves.
    // A local development source is allowed to skip the signature, because it
    // names a file the developer built themselves.
    const manifest = await loadAndVerifyManifest({
      harnessId: args.harnessId,
      source,
      packVersion: expected.packVersion,
      platformKey,
      staging,
      requireSignature: args.fromArchive !== undefined,
    });

    // ── disk-space ──────────────────────────────────────────────────────
    stage = "disk-space";
    const extracted =
      manifest !== null && Number.isFinite(manifest.bytes) && manifest.bytes > 0
        ? manifest.bytes
        : source.kind === "file"
          ? (await stat(source.location)).size * 3
          : 0;
    if (extracted > 0) {
      // The archive and the extracted tree coexist in staging until
      // activation; the archive is smaller than the tree it holds.
      const needed = extracted * 2 + DISK_HEADROOM_BYTES;
      const free = await freeSpaceProbe(installRoot);
      if (free !== null && free < needed) {
        const error = new Error(
          `not enough free disk space for the ${args.harnessId} runtime: it needs about ` +
            `${Math.ceil(needed / 1024 / 1024)} MB under ${installRoot} and ` +
            `${Math.floor(free / 1024 / 1024)} MB is free`,
        ) as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
    }

    // ── download ────────────────────────────────────────────────────────
    stage = "download";
    const archiveSha = await fetchArchive({
      source,
      destination: archivePath,
      onPercent: (percent) =>
        setStatus({
          state: "downloading",
          packVersion: expected.packVersion,
          percent,
          attemptId,
        }),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    // ── verify ──────────────────────────────────────────────────────────
    stage = "verify";
    setStatus({
      state: "verifying",
      packVersion: expected.packVersion,
      attemptId,
    });

    // The archive against the manifest.
    if (manifest !== null && manifest.archive?.sha256 !== undefined) {
      if (manifest.archive.sha256 !== archiveSha) {
        throw new Error(
          `the downloaded runtime pack archive does not match its signed ` +
            `manifest (expected ${manifest.archive.sha256}, got ${archiveSha})`,
        );
      }
    }

    // Extract, then the tree against the manifest and against what this
    // Inspector build expects. Both, because they answer different
    // questions: the manifest says "this is the pack that was built", the
    // build's own expectation says "and it is the pack this code was
    // reviewed against".
    const extractRoot = join(staging, "extracted");
    await mkdir(extractRoot, { recursive: true, mode: 0o700 });
    await extractTar({
      file: archivePath,
      cwd: extractRoot,
      // No links of any kind survive extraction, and nothing may be written
      // outside `cwd`. The digest would refuse a symlink later; refusing it
      // here means it never touches the disk.
      filter: (path, entry) => {
        // Regular files and directories only. A symlink, hardlink, device or
        // fifo in the archive is refused here rather than written and then
        // rejected by the digest — extraction is where a link would do its
        // damage, so it never touches the disk.
        const type = (entry as { type?: string }).type;
        if (type !== "File" && type !== "Directory") return false;
        return !path.split("/").includes("..");
      },
      preservePaths: false,
      strict: true,
    });
    // The archive has served its purpose; do not hold its space through the
    // probe and activation.
    await rm(archivePath, { force: true }).catch(() => {});

    const packRoot = join(extractRoot, args.harnessId);
    const info = await stat(packRoot).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(
        `the runtime pack archive has no ${args.harnessId} directory at its root`,
      );
    }
    await assertExtractedSize(packRoot);

    const digest = await computeTreeDigest(packRoot);
    if (manifest !== null && digest !== manifest.treeDigest) {
      throw new Error(
        `the extracted runtime pack does not match its signed manifest ` +
          `(expected ${manifest.treeDigest}, got ${digest})`,
      );
    }
    if (digest !== expected.treeDigest) {
      throw new Error(
        `the runtime pack does not match the digest this Inspector was ` +
          `built with (expected ${expected.treeDigest}, got ${digest})`,
      );
    }

    // macOS quarantines files written by a downloading process. The vendor's
    // binary and Node are both Developer-ID signed with hardened runtime, so
    // the quarantine flag is the only thing standing between a verified pack
    // and Gatekeeper refusing to exec it. Cleared only on the tree this
    // install just wrote and just verified — and before the probe execs it.
    if (args.platform === "darwin") await clearQuarantine(extractRoot);

    // ── probe ───────────────────────────────────────────────────────────
    // This build's Inspector layer, started on the staged pack, and the
    // vendor binary's version handshake. A candidate that cannot start is
    // never activated, so nothing ever selects it.
    stage = "probe";
    const probe = await probeRuntimeCandidate({
      harnessId: args.harnessId,
      packRoot,
      platform: args.platform,
      target: target ?? (platformKey as LocalPackTarget),
      layerRuntimeRoot: runtimeInstallRoot(),
    });
    if (!probe.ok) {
      throw new Error(`the ${args.harnessId} runtime ${expected.packVersion} failed its startup probe: ${probe.message}`);
    }
    // Ours, not the user's: the probe may not leave anything behind in the
    // tree it vouches for.
    if ((await computeTreeDigest(packRoot)) !== digest) {
      throw new Error("the runtime pack changed while it was being probed");
    }

    // ── activate ────────────────────────────────────────────────────────
    stage = "activate";
    const activatedAsUpdate = await hasOtherInstalledVersion(installRoot, expected.packVersion);

    // The ownership marker and the health record go in BEFORE the rename, so
    // the rename is the one and only commit point. Written afterwards, a crash
    // in the window between them left a fully activated version directory
    // that carried no marker, and nothing would ever reclaim it. Both are
    // SIBLINGS of the digested `<harnessId>/` subtree, not members of it, so
    // writing them cannot disturb the digest that was just verified.
    await writeFile(
      join(extractRoot, INSTALL_MARKER),
      `${JSON.stringify(
        {
          packVersion: expected.packVersion,
          harnessId: args.harnessId,
          platform: platformKey,
          treeDigest: digest,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeRuntimeHealth(
      extractRoot,
      newHealthRecord({
        packVersion: expected.packVersion,
        treeDigest: digest,
        probe: { at: Date.now(), node: probe.node, vendorVersion: probe.vendorVersion },
        installStartedAt: args.installStartedAt,
        activatedAt: Date.now(),
        activatedAsUpdate,
      }),
    );

    setStatus({
      state: "verifying",
      packVersion: expected.packVersion,
      attemptId,
    });
    await updateInstallAttempt(key, attemptId, { state: "activating" });
    await activateVerifiedPack({
      key,
      attemptId,
      versionRoot,
      extractRoot,
    });

    logger.info("[local-harness] runtime pack installed", {
      packVersion: expected.packVersion,
      platform: platformKey,
    });
    return {
      status: {
        state: "ready",
        packVersion: expected.packVersion,
        runtimeRoot: versionRoot,
        digest,
        role: "desired",
      },
      activatedAsUpdate,
    };
  } catch (error) {
    throw atStage(stage, error);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Is another version of this harness's pack already installed beside this one? */
async function hasOtherInstalledVersion(installRoot: string, packVersion: string): Promise<boolean> {
  for (const entry of await readdir(installRoot).catch(() => [] as string[])) {
    if (entry.startsWith(".") || entry === packVersion || entry.endsWith(PREVIOUS_SUFFIX)) continue;
    const marker = await stat(join(installRoot, entry, INSTALL_MARKER)).then(
      () => true,
      () => false,
    );
    if (marker) return true;
  }
  return false;
}

/**
 * Move a verified tree into place, without taking a runtime away from anyone.
 *
 * Three things happen here that did not before, and each one is a bug that was
 * reproducible:
 *
 *   - ownership is re-checked HERE. A download takes minutes; the reservation
 *     taken before it says nothing about now, and this is the irreversible
 *     step;
 *   - a version directory that another process reserved for USE is not
 *     replaced. `rm -rf` on it used to delete the tree a running session had
 *     verified and was executing from;
 *   - the previous directory is moved ASIDE rather than deleted, so a crash
 *     between the two renames leaves something to put back
 *     (`recoverInterruptedActivation`) instead of a machine with no runtime.
 */
async function activateVerifiedPack(args: {
  key: RuntimeOperationKey;
  attemptId: string;
  versionRoot: string;
  extractRoot: string;
}): Promise<void> {
  const { key, versionRoot, extractRoot } = args;

  if (!(await attemptStillOwns(key, args.attemptId))) {
    throw new Error(
      "another install took over this runtime while this one was " +
        "downloading, so it was not activated",
    );
  }

  const inUse = await runtimeUseState({ key, runtimeRoot: versionRoot });
  if (inUse.busy) {
    throw new Error(
      `this runtime is in use by ${inUse.holders.length} running ` +
        `session(s) on this machine, so it was not replaced. Stop them and ` +
        `retry.`,
    );
  }

  await withRuntimeLifecycleLock(key, async () => {
    // Re-asked inside the critical section: a session can start between the
    // check above and the rename, and the rename is what would pull the tree
    // out from under it.
    const stillFree = await runtimeUseState({ key, runtimeRoot: versionRoot });
    if (stillFree.busy) {
      throw new Error(
        "a session started using this runtime while it was being replaced, " +
          "so it was left alone. Stop it and retry.",
      );
    }
    const previous = `${versionRoot}${PREVIOUS_SUFFIX}`;
    await rm(previous, { recursive: true, force: true }).catch(() => {});
    const hasCurrent = await stat(versionRoot).then(
      () => true,
      () => false,
    );
    if (hasCurrent) await rename(versionRoot, previous);
    try {
      await rename(extractRoot, versionRoot);
    } catch (error) {
      // Put it back rather than leave the machine with nothing.
      if (hasCurrent) await rename(previous, versionRoot).catch(() => {});
      throw error;
    }
  });
  // Outside the lock: a recursive delete of a whole pack is not a short
  // critical section, and reservations wait on this lock. A crash before it
  // completes leaves `<version>.mcpjam-previous` beside a complete version,
  // which `recoverInterruptedActivation` (and GC) removes.
  await rm(`${versionRoot}${PREVIOUS_SUFFIX}`, { recursive: true, force: true }).catch(() => {});

  // A previous process may have verified a DIFFERENT tree at this path.
  clearRuntimeVerificationCache();
}

async function assertExtractedSize(root: string): Promise<void> {
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      bytes += (await stat(full)).size;
      if (bytes > MAX_EXTRACTED_BYTES) {
        throw new Error("the extracted runtime pack exceeds its size ceiling");
      }
    }
  };
  await walk(root);
}

async function clearQuarantine(root: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolvePromise) => {
    execFile(
      "/usr/bin/xattr",
      ["-r", "-d", "com.apple.quarantine", root],
      { timeout: 60_000 },
      () => resolvePromise(),
    );
  });
}

/**
 * Load the pack manifest and prove it is ours.
 *
 * Returns `null` ONLY for a local development source, where the "download" is
 * a file the developer built and named explicitly. Every network source must
 * produce a signed manifest or the install fails.
 */
async function loadAndVerifyManifest(args: {
  harnessId: SupportedLocalHarnessId;
  source: { kind: "file" | "url"; location: string };
  packVersion: string;
  platformKey: string;
  staging: string;
  /** Pre-provisioning: a local archive must be signed exactly like a download. */
  requireSignature?: boolean;
}): Promise<PackManifest | null> {
  const lenient = args.source.kind === "file" && args.requireSignature !== true;
  const stem = packAssetStem(args.harnessId, args.platformKey, args.packVersion);
  const manifestName = `${stem}.manifest.json`;
  const signatureName = `${manifestName}.sig`;

  let manifestBytes: Buffer;
  let signature: string;
  try {
    if (args.source.kind === "file") {
      const dir = args.source.location.endsWith(".tar.gz")
        ? args.source.location.slice(0, -basename(args.source.location).length)
        : args.source.location;
      manifestBytes = await readFile(join(dir, manifestName));
      signature = await readFile(join(dir, signatureName), "utf8");
    } else {
      const base = args.source.location.slice(
        0,
        args.source.location.lastIndexOf("/") + 1,
      );
      manifestBytes = Buffer.from(
        await (await fetchOrThrow(base + manifestName)).arrayBuffer(),
      );
      signature = await (await fetchOrThrow(base + signatureName)).text();
    }
  } catch (error) {
    if (lenient) {
      logger.warn(
        "[local-harness] local pack source has no signed manifest; " +
          "installing on the digest alone",
        { message: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
    throw atStage(
      args.source.kind === "file" ? "verify" : "download",
      new Error(
        args.source.kind === "file"
          ? `the archive has no ${manifestName} and ${signatureName} beside it, so it cannot ` +
              `be shown to have come from MCPJam. Keep the release's three files together.`
          : `the runtime pack has no signed manifest alongside it, so it cannot ` +
              `be shown to have come from MCPJam`,
      ),
    );
  }

  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw atStage("verify", new Error("the runtime pack manifest is implausibly large"));
  }
  const verified = verifyPackManifestSignature(manifestBytes, signature, manifestKeys);
  if (!verified.ok) {
    if (lenient) {
      logger.warn(
        "[local-harness] local pack manifest signature not verified; " +
          "installing on the digest alone",
        { reason: verified.reason },
      );
      return null;
    }
    throw atStage("verify", new Error(verified.message));
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as PackManifest;
  if (manifest.packVersion !== args.packVersion) {
    throw atStage(
      "verify",
      new Error(
        `the signed manifest is for pack version ${manifest.packVersion}, not ` +
        `${args.packVersion}`,
      ),
    );
  }
  if (manifest.platform !== args.platformKey) {
    throw atStage(
      "verify",
      new Error(
        `the signed manifest is for ${manifest.platform}, not ${args.platformKey}`,
      ),
    );
  }
  // Both harnesses' packs are signed by the same key, so a valid signature
  // alone does not say WHICH runtime this is. A Codex manifest served where a
  // Claude Code one was asked for would otherwise pass every check above.
  if (manifest.harnessId !== args.harnessId) {
    throw atStage(
      "verify",
      new Error(
        `the signed manifest is for the ${manifest.harnessId} runtime, not ` +
        `${args.harnessId}`,
      ),
    );
  }
  return manifest;
}

async function fetchOrThrow(url: string): Promise<Response> {
  const response = await installerFetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response;
}

/**
 * Stream the archive to disk, hashing as it goes.
 *
 * Streamed rather than buffered because the archive is 150-200 MB and holding
 * it in memory on a laptop that is also running an agent is not free. The hash
 * is computed on the way past, so verification does not mean reading it again.
 */
async function fetchArchive(args: {
  source: { kind: "file" | "url"; location: string };
  destination: string;
  onPercent: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const hash = createHash("sha256");
  let received = 0;
  let total = 0;

  const track = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error("the runtime pack archive exceeds its size ceiling");
      }
      if (total > 0) {
        args.onPercent(Math.min(99, Math.floor((received / total) * 100)));
      }
      controller.enqueue(chunk);
    },
  });

  if (args.source.kind === "file") {
    const path = args.source.location;
    const info = await stat(path);
    total = info.size;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error("the runtime pack archive exceeds its size ceiling");
    }
    await pipeline(
      createReadStream(path),
      async function* (chunks) {
        for await (const chunk of chunks) {
          const buffer = chunk as Buffer;
          hash.update(buffer);
          received += buffer.byteLength;
          args.onPercent(Math.min(99, Math.floor((received / total) * 100)));
          yield buffer;
        }
      },
      createWriteStream(args.destination, { mode: 0o600 }),
    );
    return hash.digest("hex");
  }

  const response = await installerFetch(args.source.location, {
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!response.ok || response.body === null) {
    throw new Error(
      `the runtime pack could not be downloaded: ${args.source.location} ` +
        `responded ${response.status}`,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new Error("the runtime pack archive exceeds its size ceiling");
  }
  total = declared;

  await pipeline(
    Readable.fromWeb(
      response.body.pipeThrough(track) as Parameters<typeof Readable.fromWeb>[0],
    ),
    createWriteStream(args.destination, { mode: 0o600 }),
  );
  args.onPercent(100);
  return hash.digest("hex");
}

/**
 * Boot: the runtime maintenance a server does once it is up, in order —
 *
 *   1. its LIVENESS record, so GC in any Inspector on this root keeps the packs
 *      this build may select;
 *   2. GC, after the janitor has reclaimed orphaned sessions (whose use
 *      reservations would otherwise look live);
 *   3. per harness, only where this machine already holds a durable
 *      authorization for it AND the update policy is `auto`: refresh the
 *      revocation list and PREFETCH the desired pack if it is not installed.
 *      A machine where nobody chose to run a harness downloads nothing for it.
 *
 * Best-effort throughout: maintenance never affects startup.
 */
export function startLocalHarnessRuntimeMaintenance(options: {
  /** Resolves when the janitor's orphan reclaim is done. */
  afterJanitor?: Promise<unknown>;
} = {}): Promise<void> {
  return (async () => {
    const extra = ownExpectedDigests();
    await writeLivenessRecord(undefined, extra).catch((error) => {
      logger.warn("[local-harness] could not write the runtime liveness record", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    await options.afterJanitor?.catch(() => {});
    await collectRuntimeGarbage({ extra });

    const policy = await readLocalRuntimeUpdatePolicy();
    let machineId: string | null = null;
    try {
      const { getLocalMachineId } = await import("./grants.js");
      machineId = await getLocalMachineId();
    } catch {
      machineId = null;
    }
    const { hasLocalHarnessAuthorizationOnMachine } = await import("./authorization.js");
    let refreshed = false;
    for (const harnessId of SUPPORTED_LOCAL_HARNESS_IDS) {
      try {
        const authorized =
          machineId !== null && (await hasLocalHarnessAuthorizationOnMachine(machineId, harnessId));
        const status = await readRuntimeInstallStatus({ harnessId });
        logger.debug("[local-harness] runtime at boot", {
          harnessId,
          state: status.state,
          ...(status.state === "ready" ? { role: status.role ?? "desired" } : {}),
          authorized,
          updates: policy.policy,
        });
        if (!authorized) continue;
        // Under either policy: a refresh is a read, not an install, and a
        // `manual` fleet must still stop selecting a withdrawn pack.
        if (!refreshed) {
          refreshed = true;
          await refreshRevocations();
        }
        if (policy.policy !== "auto") continue;
        const desired = await readDesiredRuntimeStatus({ harnessId });
        if (desired.state === "ready" || desired.state === "downloading" || desired.state === "verifying") continue;
        if (desired.state === "unsupported-platform") continue;
        await startRuntimeInstall({ harnessId, trigger: "boot" });
      } catch {
        // One harness's maintenance never stops the next one's.
      }
    }
  })().catch(() => {});
}

/**
 * The Playground's readiness check, when the runtime a session would run is
 * not this build's desired pack (or nothing is installed yet): refresh the
 * revocation list and start — never await — the desired pack's install.
 * Policy, revocation and backoff are `startRuntimeInstall`'s to decide.
 */
export async function startBackgroundRuntimeUpdate(harnessId: SupportedLocalHarnessId): Promise<StartRuntimeInstallResult> {
  await refreshRevocations();
  return startRuntimeInstall({ harnessId, trigger: "readiness" });
}

/** @deprecated boot now runs `startLocalHarnessRuntimeMaintenance`. */
export function reportLocalHarnessRuntimeStatusInBackground(): void {
  void startLocalHarnessRuntimeMaintenance();
}

/**
 * One session's bridge start, recorded against the pack it ran on — the
 * signal that rolls a broken update back. Fire-and-forget from the launch
 * path; never throws.
 *
 *   success → clears the pack's failure count; the first one after an install
 *             reports `time_to_first_usable_turn`;
 *   failure → counted; after an update it reports
 *             `launch_failed_after_update`, and the failure that crosses the
 *             threshold marks the pack unhealthy. Selection then falls back to
 *             the permitted previous pack for NEW sessions
 *             (`rolled_back_to_previous`). The failed turn is not replayed.
 */
export async function noteRuntimeLaunch(args: {
  harnessId: SupportedLocalHarnessId;
  status: Extract<RuntimeInstallStatus, { state: "ready" }>;
  outcome: { ok: true } | { ok: false; reason: string };
}): Promise<void> {
  try {
    const target = localPackTarget();
    if (target === null) return;
    const { recordRuntimeLaunch } = await import("./runtime-health.js");
    const folded = await recordRuntimeLaunch({
      key: {
        runtimeRoot: runtimeInstallRoot(),
        harnessId: args.harnessId,
        target,
        packVersion: args.status.packVersion,
        treeDigest: args.status.digest,
      },
      versionRoot: args.status.runtimeRoot,
      outcome: args.outcome,
    });
    const role = args.status.role ?? "desired";
    const common = { harness_id: args.harnessId, pack_version: args.status.packVersion, role };
    if (args.outcome.ok) {
      if (folded.firstUsable && folded.record.installStartedAt !== undefined) {
        emitLocalRuntimeEvent("local_runtime_time_to_first_usable_turn", {
          ...common,
          duration_ms: Date.now() - folded.record.installStartedAt,
        });
      }
      return;
    }
    if (role === "desired" && folded.record.activatedAsUpdate) {
      emitLocalRuntimeEvent("local_runtime_launch_failed_after_update", common);
    }
    if (folded.becameUnhealthy) {
      logger.warn("[local-harness] runtime marked unhealthy after repeated launch failures", {
        harnessId: args.harnessId,
        packVersion: args.status.packVersion,
      });
      const now = await readRuntimeInstallStatus({ harnessId: args.harnessId });
      if (now.state === "ready" && now.role === "permitted") {
        emitLocalRuntimeEvent("local_runtime_rolled_back_to_previous", {
          ...common,
          pack_version: now.packVersion,
        });
      }
    }
  } catch {
    // Health is advisory bookkeeping; a launch never fails on it.
  }
}

/** Is exactly this pack (version AND digest) installed here? Marker-based, cheap. */
export async function isPackInstalled(
  harnessId: SupportedLocalHarnessId,
  pack: { packVersion: string; treeDigest: string },
  target: LocalPackTarget | null = localPackTarget(),
): Promise<boolean> {
  if (target === null) return false;
  const status = await readMarkerStatus({
    harnessId,
    versionRoot: packVersionRoot(harnessId, pack.packVersion, target),
    expected: pack,
  });
  return status.state === "ready";
}

/**
 * `harness repair`: put this machine's desired runtime back into a state a
 * session can use, through the normal installer.
 *
 *   1. clear what is provably abandoned (staging, half-finished retirements,
 *      an interrupted activation);
 *   2. RE-VERIFY the installed desired pack by digest — a fresh process has no
 *      verification cache, so this reads every byte;
 *   3. corrupt, absent, failed or interrupted → reinstall it (download, or
 *      `fromArchive` with no network), through the full candidate flow;
 *   4. installed but marked unhealthy → re-run the startup probe on it and,
 *      if it passes, start its health record afresh.
 *
 * Allowed under any update policy: it is an administrator's command.
 */
export async function repairRuntime(options: {
  harnessId: SupportedLocalHarnessId;
  fromArchive?: string;
  onProgress?: (status: RuntimeInstallStatus) => void;
}): Promise<{ status: RuntimeInstallStatus; actions: string[] }> {
  const actions: string[] = [];
  const resolved = resolveInstallTarget(options);
  if (!resolved.ok) return { status: resolved.status, actions };
  const { key, versionRoot, expected } = resolved;

  if (await recoverInterruptedActivation({ key, versionRoot })) actions.push("restored an interrupted activation");
  const staging = await sweepAbandonedStaging(key);
  if (staging.removed > 0) actions.push(`removed ${staging.removed} abandoned staging director${staging.removed === 1 ? "y" : "ies"}`);
  const { sweepRetired } = await import("./runtime-lifecycle.js");
  const retired = await sweepRetired(key);
  if (retired > 0) actions.push(`finished removing ${retired} retired version${retired === 1 ? "" : "s"}`);

  const verified = await readVerifiedRuntimeStatus({ harnessId: options.harnessId, desiredOnly: true });
  if (verified.state === "ready") {
    const health = await readRuntimeHealth(versionRoot);
    if (!isUnhealthy(health, expected.treeDigest)) {
      actions.push(`verified ${expected.packVersion} byte for byte`);
      return { status: await readRuntimeInstallStatus({ harnessId: options.harnessId }), actions };
    }
    const reprobed = await reprobeInstalledPack({ harnessId: options.harnessId, resolved, health });
    if (!reprobed.ok) {
      actions.push(reprobed.message);
      return {
        status: { state: "failed", packVersion: expected.packVersion, reason: "probe", stage: "probe", message: reprobed.message },
        actions,
      };
    }
    actions.push(`re-probed ${expected.packVersion} and cleared its unhealthy mark`);
    return { status: await readRuntimeInstallStatus({ harnessId: options.harnessId }), actions };
  }

  actions.push(
    verified.state === "corrupt"
      ? `the installed ${expected.packVersion} does not verify; reinstalling it`
      : `installing ${expected.packVersion}`,
  );
  const installed = await installRuntimePack({
    harnessId: options.harnessId,
    trigger: options.fromArchive !== undefined ? "provision" : "cli",
    ...(options.fromArchive !== undefined ? { fromArchive: options.fromArchive } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return { status: installed.state === "ready" ? await readRuntimeInstallStatus({ harnessId: options.harnessId }) : installed, actions };
}
