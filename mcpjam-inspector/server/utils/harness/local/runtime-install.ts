/**
 * Installing the runtime pack — the one place a 515 MB third-party tree gets
 * onto the user's machine, and the one place it is proven to be ours.
 *
 * ── Why this is a separate, explicit step ────────────────────────────────
 * The pack cannot ship inside the npm package or the DMG (size, and coupling
 * notarization to a vendor binary), so it is downloaded. The argument this
 * module was written around was against fetching it UNASKED — at boot, on a
 * poll, on a component remount, on the way into a turn — and that argument
 * still holds exactly as it did: none of those is a user asking for 515 MB.
 *
 * What has changed is that a user CAN now ask, in one gesture, from the
 * composer. `startRuntimeInstall` is called from that gesture ("Install &
 * allow") and from `harness install`, and from nowhere else. A session that
 * finds no pack still refuses with `bundle-absent` rather than fetching one;
 * boot still only reports. Downloading on an explicit request is the thing the
 * user asked for, and is not the thing this module refuses to do.
 *
 * ── The verification chain ───────────────────────────────────────────────
 * Three checks, in this order, each covering the next:
 *
 *   1. the manifest's Ed25519 signature — proves MCPJam published it;
 *   2. the archive's sha256 against the manifest — proves the bytes that
 *      arrived are the bytes the manifest describes;
 *   3. the extracted tree's canonical digest against the manifest — proves
 *      extraction produced what was archived, and is the same digest the
 *      session-start path re-verifies against later.
 *
 * Doing (3) as well as (2) is not redundant: extraction is where a path
 * traversal, a symlink, or a truncated write would land, and the tree digest
 * is what every later check compares against.
 *
 * ── Atomicity, and who else is holding the door ──────────────────────────
 * Extraction goes into a sibling `.mcpjam-tmp-*` directory and is renamed into
 * place only after all three checks pass. A crashed or failed install leaves a
 * temp directory, never a half-written version directory that
 * `resolveManagedBundle` would then try to digest.
 *
 * The rename is not the only thing that has to be safe, though, because this
 * process is not the only one here: another Inspector window, the install CLI,
 * and a running session all reach the same root. `runtime-lifecycle.ts` owns
 * that coordination — who is installing, who is using a version directory, and
 * which staging directories are provably abandoned — and every irreversible
 * step below asks it, immediately before taking the step rather than once at
 * the start.
 *
 * ── What this module does NOT do ─────────────────────────────────────────
 * It does not delete old versions. It used to sweep every other version after
 * activating, which is how a running session lost the tree it had already
 * verified and was executing from. Verified versions now sit side by side and
 * cost disk; reclaiming them needs an ownership answer across processes that
 * spans more than one install, and that is deliberately not in this pass.
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
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { x as extractTar } from "tar";
import { logger } from "../../logger.js";
import {
  EXPECTED_PACK_VERSION,
  PACK_RECORDS,
} from "./pack-digests.generated.js";
import { verifyPackManifestSignature } from "./pack-signing-key.js";
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
  type RuntimeOperationKey,
  type RuntimeOperationRecord,
} from "./runtime-lifecycle.js";
import {
  currentLocalPlatform,
  localPackTarget,
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

/**
 * Where packs live.
 *
 * Electron sets `MCPJAM_RUNTIME_ROOT` from `app.getPath("userData")` so a
 * packaged app keeps its runtime with the rest of its own state; npx falls
 * back to the same `~/.mcpjam` tree the grants and machine identity already
 * use. Both are per-user and outside any workspace, which is what keeps the
 * pack out of reach of the agent it launches.
 */
export function runtimeInstallRoot(): string {
  const override = process.env.MCPJAM_RUNTIME_ROOT;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".mcpjam", "harness-local", "runtime");
}

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
  packVersion: string,
  target: LocalPackTarget | null = localPackTarget(),
): string {
  return join(targetInstallRoot(target), packVersion);
}

/** Where every version for one target lives. */
function targetInstallRoot(target: LocalPackTarget | null): string {
  return join(runtimeInstallRoot(), target ?? packPlatformKey());
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
  | "unknown";

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
  | { state: "ready"; packVersion: string; runtimeRoot: string; digest: string }
  /** A pack is installed and does not verify. Repairable, not re-downloadable. */
  | { state: "corrupt"; packVersion: string; message: string }
  | {
      state: "failed";
      packVersion: string;
      reason: RuntimeInstallFailureReason;
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
  // Packs are attached to the Inspector release itself, and stamped with the
  // same version, so the tag is `v<version>` — the tag `release.yml` already
  // creates. No separate release, no separate tag to keep in step.
  return {
    kind: "url",
    location:
      `https://github.com/MCPJam/inspector/releases/download/v${packVersion}/` +
      `local-harness-pack-${platformKey}-${packVersion}.tar.gz`,
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
>(manifest: T, harnessId: SupportedLocalHarnessId, target: LocalPackTarget | null): T {
  if (target === null) return manifest;
  if (manifest.runtime.source !== "managed-bundle") return manifest;
  const expected = expectedPackFor(harnessId, target);
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
}): Promise<RuntimeInstallStatus> {
  const status = await readRuntimeInstallStatus(args);
  if (status.state !== "ready") return status;
  const platform = currentLocalPlatform(args.platform ?? process.platform);
  if (platform === null) return status;

  const resolvedBundle = await resolveManagedBundle({
    manifest: manifestWithExpectedBundleDigest(
      LOCAL_HARNESS_MANIFEST[args.harnessId],
      args.harnessId,
      localPackTarget(args.platform, args.arch),
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
        runtimeRoot: packVersionRoot(record.packVersion, record.target),
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
    versionRoot: packVersionRoot(expected.packVersion, target),
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
}

export type StartRuntimeInstallResult =
  /** This call started the work. Poll for progress. */
  | { kind: "started"; status: RuntimeInstallStatus; attemptId: string }
  /** Work was already running here or in another process. Poll for progress. */
  | { kind: "joined"; status: RuntimeInstallStatus; attemptId?: string }
  /** A verified runtime is already installed. Nothing was downloaded. */
  | { kind: "ready"; status: RuntimeInstallStatus }
  /** The request cannot start work at all. */
  | { kind: "refused"; status: RuntimeInstallStatus; reason: string };

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

  // Claimed SYNCHRONOUSLY, before any await. Two clicks, or a click and the
  // CLI in the same process, must not both get past the "is one running?"
  // check while a filesystem round trip is in flight.
  const keyString = operationKeyString(key);
  const running = active.get(keyString);
  if (running !== undefined) {
    return { kind: "joined", status: running.status };
  }

  await recoverInterruptedActivation({ key, versionRoot });

  // Already installed AND verified: no download, and the answer is as fresh as
  // the probe that produced it.
  const verified = await readVerifiedRuntimeStatus(options);
  if (verified.state === "ready") return { kind: "ready", status: verified };

  const attempt = await beginInstallAttempt(key);
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
  record.promise = runInstallAttempt({
    options,
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

  try {
    const result = await performInstall({
      ...options,
      platform: resolved.platform,
      expected,
      key,
      attemptId,
      setStatus,
    });
    record.status = result;
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
      message: failure.message,
    });
    record.status = failure;
    await updateInstallAttempt(key, attemptId, {
      state: "failed",
      reason: failure.reason,
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

  return { state: "failed", packVersion, reason, message };
}

async function performInstall(args: {
  harnessId: SupportedLocalHarnessId;
  platform: LocalPlatform;
  arch?: string;
  expected: { packVersion: string; treeDigest: string };
  key: RuntimeOperationKey;
  attemptId: string;
  setStatus: (status: RuntimeInstallStatus) => void;
  signal?: AbortSignal;
}): Promise<RuntimeInstallStatus> {
  const { expected, setStatus, key, attemptId } = args;
  const platformKey = packPlatformKey(args.platform, args.arch);
  const target = localPackTarget(args.platform, args.arch);
  const versionRoot = packVersionRoot(expected.packVersion, target);
  // Per TARGET, so staging is confined to this architecture's directory and
  // cannot touch another one's runtime.
  const installRoot = targetInstallRoot(target);
  await mkdir(installRoot, { recursive: true, mode: 0o700 });

  // Reclaim what is PROVABLY abandoned before adding to it. Never by prefix or
  // age: an extraction that cannot be proven dead belongs to somebody.
  await sweepAbandonedStaging(key);

  const staging = join(installRoot, `${STAGING_PREFIX}${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await claimStagingDirectory({ staging, attemptId });

  try {
    const source = packSourceFor(expected.packVersion, platformKey);
    const archivePath = join(staging, "pack.tar.gz");

    setStatus({
      state: "downloading",
      packVersion: expected.packVersion,
      percent: 0,
      attemptId,
    });
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

    setStatus({
      state: "verifying",
      packVersion: expected.packVersion,
      attemptId,
    });

    // 1. Signature over the manifest. A local development source is allowed to
    //    skip this, because it names a file the developer built themselves
    //    rather than something fetched from anywhere.
    const manifest = await loadAndVerifyManifest({
      source,
      packVersion: expected.packVersion,
      platformKey,
      staging,
    });

    // 2. The archive against the manifest.
    if (manifest !== null && manifest.archive?.sha256 !== undefined) {
      if (manifest.archive.sha256 !== archiveSha) {
        throw new Error(
          `the downloaded runtime pack archive does not match its signed ` +
            `manifest (expected ${manifest.archive.sha256}, got ${archiveSha})`,
        );
      }
    }

    // 3. Extract, then the tree against the manifest and against what this
    //    Inspector build expects. Both, because they answer different
    //    questions: the manifest says "this is the pack that was built", the
    //    build's own expectation says "and it is the pack this code was
    //    reviewed against".
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
    // install just wrote and just verified.
    if (args.platform === "darwin") await clearQuarantine(extractRoot);

    // The ownership marker goes in BEFORE the rename, so the rename is the one
    // and only commit point. Written afterwards, a crash in the window between
    // them left a fully activated ~515 MB version directory that carried no
    // marker, and nothing would ever reclaim it. It is a SIBLING of the
    // digested `<harnessId>/` subtree, not a member of it, so writing it here
    // cannot disturb the digest that was just verified.
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
      state: "ready",
      packVersion: expected.packVersion,
      runtimeRoot: versionRoot,
      digest,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
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
    await rm(previous, { recursive: true, force: true }).catch(() => {});
  });

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
  source: { kind: "file" | "url"; location: string };
  packVersion: string;
  platformKey: string;
  staging: string;
}): Promise<PackManifest | null> {
  const stem = `local-harness-pack-${args.platformKey}-${args.packVersion}`;
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
    if (args.source.kind === "file") {
      logger.warn(
        "[local-harness] local pack source has no signed manifest; " +
          "installing on the digest alone",
        { message: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
    throw new Error(
      `the runtime pack has no signed manifest alongside it, so it cannot ` +
        `be shown to have come from MCPJam`,
    );
  }

  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("the runtime pack manifest is implausibly large");
  }
  const verified = verifyPackManifestSignature(manifestBytes, signature);
  if (!verified.ok) {
    if (args.source.kind === "file") {
      logger.warn(
        "[local-harness] local pack manifest signature not verified; " +
          "installing on the digest alone",
        { reason: verified.reason },
      );
      return null;
    }
    throw new Error(verified.message);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as PackManifest;
  if (manifest.packVersion !== args.packVersion) {
    throw new Error(
      `the signed manifest is for pack version ${manifest.packVersion}, not ` +
        `${args.packVersion}`,
    );
  }
  if (manifest.platform !== args.platformKey) {
    throw new Error(
      `the signed manifest is for ${manifest.platform}, not ${args.platformKey}`,
    );
  }
  return manifest;
}

async function fetchOrThrow(url: string): Promise<Response> {
  const response = await fetch(url);
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

  const response = await fetch(args.source.location, {
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
 * Startup hook: report what is installed, and never install anything.
 *
 * Mirrors `startLocalBrowserRenderingSetupInBackground`'s shape but not its
 * behaviour — Chromium is a dependency the eval path cannot work without, so
 * fetching it unasked is defensible; a 515 MB agent runtime for a feature
 * behind a flag, a kill switch and a consent grant is not. A user asking for
 * it in the composer is a different thing entirely, and that is
 * `startRuntimeInstall`; boot has nobody to ask.
 *
 * Boot also deletes nothing. Reading the status recovers an activation that
 * was interrupted mid-rename — which puts a runtime BACK — but no version
 * directory and no staging directory is reclaimed here.
 */
export function reportLocalHarnessRuntimeStatusInBackground(): void {
  void (async () => {
    try {
      const status = await readRuntimeInstallStatus({
        harnessId: "claude-code",
      });
      if (status.state === "ready") {
        logger.info("[local-harness] runtime pack present", {
          packVersion: status.packVersion,
        });
        return;
      }
      logger.debug("[local-harness] no runtime pack installed", {
        state: status.state,
        expected: EXPECTED_PACK_VERSION || "(none built)",
      });
    } catch {
      // Reporting is best-effort by construction: a status probe that throws
      // must not affect server startup.
    }
  })();
}
