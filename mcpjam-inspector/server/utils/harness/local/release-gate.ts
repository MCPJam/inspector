/**
 * What this Inspector build may actually OFFER, as opposed to what its
 * manifest describes.
 *
 * ── The failure this exists to stop ──────────────────────────────────────
 * Three separate facts have to line up before a platform can be offered local
 * Claude Code, and until now nothing asked all three at once:
 *
 *   1. `compatibility.ts` lists the platform in `nativePlatforms` and records
 *      lifecycle conformance evidence for the harness;
 *   2. `pack-digests.generated.ts` carries a digest for the platform's pack
 *      TARGET, at the version this build expects;
 *   3. a signed pack asset actually exists at that version, so the digest
 *      names something a user can download.
 *
 * A build with (1) and not (2) advertises a target whose install can only ever
 * answer `unsupported-platform` — which is what the reviewed checkout does
 * today, with an empty digest table and a manifest that names three platforms.
 * A build with (2) and not (3) advertises a target whose install 404s. Both
 * look like a feature that is broken rather than one that has not shipped.
 *
 * So the offer is DERIVED here, from all three, and the release check
 * (`scripts/check-local-harness-release.mjs`) asks this same module rather than
 * re-deriving the rule in a shell script that can drift from it.
 *
 * ── What this is not ─────────────────────────────────────────────────────
 * Not a runtime health check. "A pack for this target exists and is
 * verifiable" is a fact about the RELEASE; whether one is installed, intact,
 * and launchable on this machine is `runtime-install.ts` and
 * `runtime-identity.ts`, and neither question substitutes for the other.
 */
import {
  LOCAL_HARNESS_MANIFEST,
  type LocalHarnessCompatibility,
} from "./compatibility.js";
import {
  EXPECTED_PACK_VERSION,
  PACK_RECORDS,
} from "./pack-digests.generated.js";
import {
  localPackTarget,
  type LocalPackTarget,
  type LocalPlatform,
  type SupportedLocalHarnessId,
} from "./targets.js";

/** Every architecture a pack is built for, per platform. */
const TARGETS_BY_PLATFORM: Readonly<
  Record<LocalPlatform, readonly LocalPackTarget[]>
> = {
  darwin: ["darwin-arm64", "darwin-x64"],
  linux: ["linux-x64", "linux-arm64"],
  win32: ["win32-x64"],
};

export type ReleaseBlockerKind =
  /** No reviewed compatibility manifest for the harness at all. */
  | "no-manifest"
  /** The manifest records no lifecycle conformance evidence. */
  | "conformance-missing"
  /** The manifest names the platform but no pack target has a digest. */
  | "pack-digest-missing"
  /** A digest exists but names a different pack version than this build expects. */
  | "pack-version-mismatch"
  /** `EXPECTED_PACK_VERSION` is empty: no pack build has ever been recorded. */
  | "no-pack-version";

export interface ReleaseBlocker {
  kind: ReleaseBlockerKind;
  harnessId: SupportedLocalHarnessId;
  /** Present when the blocker is about one platform rather than the harness. */
  platform?: LocalPlatform;
  /** Present when the blocker is about one pack target. */
  target?: LocalPackTarget;
  /**
   * Does this FAIL a release, or only explain why the feature is still dark?
   *
   * The distinction is the whole usefulness of the check. A build with no
   * conformance evidence offers local execution nowhere — `resolveLocalCompatibility`
   * refuses every tuple — so it is not broken, it is unshipped, and blocking
   * every release until an unrelated feature is finished would be noise nobody
   * keeps. What must never ship is an INCONSISTENT build: one whose derived
   * offer names a platform it has no pack for, or whose digest table is
   * stamped at a version whose assets this release does not publish.
   */
  blocking: boolean;
  /** Operator-facing, and says what to do rather than only what is wrong. */
  message: string;
}

/**
 * The pack targets this build carries a usable digest for.
 *
 * "Usable" means present AND stamped with `EXPECTED_PACK_VERSION`: a record
 * left over from an older pack build names a version whose asset URL this
 * release does not publish, so it is not something to offer.
 */
export function packTargetsWithDigests(
  harnessId: SupportedLocalHarnessId,
  records: typeof PACK_RECORDS = PACK_RECORDS,
  expectedVersion: string = EXPECTED_PACK_VERSION,
): LocalPackTarget[] {
  if (expectedVersion.length === 0) return [];
  const forHarness = records[harnessId] ?? {};
  return (Object.keys(forHarness) as LocalPackTarget[]).filter((target) => {
    const record = forHarness[target];
    return (
      record !== undefined &&
      record.packVersion === expectedVersion &&
      /^sha256:[0-9a-f]{64}$/.test(record.treeDigest)
    );
  });
}

/**
 * The platforms this build may offer local execution on.
 *
 * The INTERSECTION of what the manifest reviewed and what the pack build
 * produced — never the manifest alone. A platform listed in `nativePlatforms`
 * with no pack behind it is a promise this build cannot keep.
 */
export function advertisedLocalPlatforms(
  harnessId: SupportedLocalHarnessId,
  manifests: Readonly<
    Partial<Record<string, LocalHarnessCompatibility>>
  > = LOCAL_HARNESS_MANIFEST,
  records: typeof PACK_RECORDS = PACK_RECORDS,
  expectedVersion: string = EXPECTED_PACK_VERSION,
): LocalPlatform[] {
  const manifest = Object.prototype.hasOwnProperty.call(manifests, harnessId)
    ? manifests[harnessId]
    : undefined;
  if (manifest === undefined) return [];
  // Conformance evidence gates the whole harness, not one platform: it is the
  // record that the lifecycle suite ran, and without it `resolveLocalCompatibility`
  // refuses every tuple anyway. Deriving the offer from it here means the
  // release check and the runtime gate cannot disagree.
  if (manifest.lifecycleConformanceVersion === "") return [];
  const withDigests = new Set(
    packTargetsWithDigests(harnessId, records, expectedVersion),
  );
  return manifest.nativePlatforms.filter((platform) =>
    TARGETS_BY_PLATFORM[platform].some((target) => withDigests.has(target)),
  );
}

/**
 * Can THIS machine be offered local execution by this build?
 *
 * Answers the release question only. A `true` here still passes through
 * `resolveLocalCompatibility`, the ownership-proof check, and an actual
 * installed, verified runtime before anything runs.
 */
export function localExecutionReleasedForThisMachine(args: {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injectable, like `advertisedLocalPlatforms` — the tables are the fixture. */
  manifests?: Readonly<Partial<Record<string, LocalHarnessCompatibility>>>;
  records?: typeof PACK_RECORDS;
  expectedVersion?: string;
}): boolean {
  const target = localPackTarget(args.platform, args.arch);
  if (target === null) return false;
  // BOTH facts, about two different things.
  //
  // THIS target must have a digest — a pack that exists for `darwin-arm64`
  // says nothing about an Intel Mac — and its PLATFORM must be one the
  // manifest calls native with conformance evidence behind it.
  //
  // Neither half alone is the answer. The digest check on its own called a
  // machine released when the manifest still refused that platform, or when
  // the build had no conformance at all, and `resolveLocalCompatibility`
  // refuses both at runtime. And `advertisedLocalPlatforms` on its own is an
  // answer about the OS: it lists a platform when ANY of its architectures has
  // a pack, and `TARGETS_BY_PLATFORM` is the static build list rather than the
  // shipped one, so asking only that made every architecture of an advertised
  // OS look released.
  const hasPackForThisTarget = packTargetsWithDigests(
    args.harnessId,
    args.records,
    args.expectedVersion,
  ).includes(target);
  if (!hasPackForThisTarget) return false;
  return advertisedLocalPlatforms(
    args.harnessId,
    args.manifests,
    args.records,
    args.expectedVersion,
  ).some((platform) => TARGETS_BY_PLATFORM[platform].includes(target));
}

/**
 * Everything standing between this build and shipping local execution for a
 * harness, as a list rather than a first failure.
 *
 * A list because a release engineer wants the whole set: fixing conformance
 * and then discovering the digest table is also empty is two release cycles
 * for one problem.
 */
export function localHarnessReleaseBlockers(args: {
  harnessId: SupportedLocalHarnessId;
  /** The release version. Defaults to whatever the digest table was built at. */
  version?: string;
  manifests?: Readonly<Partial<Record<string, LocalHarnessCompatibility>>>;
  records?: typeof PACK_RECORDS;
  expectedVersion?: string;
}): ReleaseBlocker[] {
  const manifests = args.manifests ?? LOCAL_HARNESS_MANIFEST;
  const records = args.records ?? PACK_RECORDS;
  const expectedVersion = args.expectedVersion ?? EXPECTED_PACK_VERSION;
  const harnessId = args.harnessId;
  const blockers: ReleaseBlocker[] = [];

  const manifest = Object.prototype.hasOwnProperty.call(manifests, harnessId)
    ? manifests[harnessId]
    : undefined;
  if (manifest === undefined) {
    return [
      {
        kind: "no-manifest",
        harnessId,
        blocking: false,
        message:
          `${harnessId} has no reviewed local compatibility manifest, so it ` +
          `cannot be offered locally on any platform.`,
      },
    ];
  }

  // With no conformance evidence the harness is offered NOWHERE, so nothing
  // downstream can be inconsistent with it. That makes this a report, not a
  // failure — and it makes every per-platform gap below a report too.
  const wouldOffer = manifest.lifecycleConformanceVersion !== "";
  if (!wouldOffer) {
    blockers.push({
      kind: "conformance-missing",
      harnessId,
      blocking: false,
      message:
        `${harnessId} records no lifecycleConformanceVersion, so local ` +
        `execution is offered on no platform. Run the lifecycle conformance ` +
        `suite on every advertised platform and record its version in ` +
        `compatibility.ts — a green run on one platform is not evidence for ` +
        `the others.`,
    });
  }

  if (expectedVersion.length === 0) {
    blockers.push({
      kind: "no-pack-version",
      harnessId,
      // Blocking only where the build would otherwise offer the harness: a
      // conformance-bearing manifest with no pack at all IS the inconsistent
      // release this check exists to stop.
      blocking: wouldOffer,
      message:
        `EXPECTED_PACK_VERSION is empty, so no pack has been built and no ` +
        `install can ever verify. Run local-harness-pack.yml, then ` +
        `scripts/write-pack-digests.mjs, and commit the generated table.`,
    });
  } else if (args.version !== undefined && args.version !== expectedVersion) {
    blockers.push({
      kind: "pack-version-mismatch",
      harnessId,
      // Always blocking. A digest table stamped at another version points
      // every install at an asset URL this release does not publish, whether
      // or not the offer is live today — and the table is what the NEXT
      // release inherits.
      blocking: true,
      message:
        `EXPECTED_PACK_VERSION is ${expectedVersion} but this release is ` +
        `${args.version}. The asset URL a client downloads is built from the ` +
        `release tag, so the two must be the same version.`,
    });
  }

  const withDigests = new Set(
    packTargetsWithDigests(harnessId, records, expectedVersion),
  );
  for (const platform of manifest.nativePlatforms) {
    for (const target of TARGETS_BY_PLATFORM[platform]) {
      if (withDigests.has(target)) continue;
      blockers.push({
        kind: "pack-digest-missing",
        harnessId,
        platform,
        target,
        blocking: wouldOffer,
        message:
          `${harnessId} advertises ${platform} but carries no ${target} pack ` +
          `digest at version ${expectedVersion || "(none)"}. Either build and ` +
          `publish that target's pack, or drop the platform from ` +
          `nativePlatforms — an advertised target with no pack refuses every ` +
          `install it is offered for.`,
      });
    }
  }

  return blockers;
}

/**
 * The published asset names for one target, so a release check can look for
 * exactly what a client would fetch.
 *
 * Derived from the same stem `build-local-harness-pack.mjs` writes and
 * `packSourceFor` downloads, because a check that guesses the name proves
 * nothing about the name a user's installer will ask for.
 */
export function packAssetNames(
  target: LocalPackTarget,
  packVersion: string,
): { archive: string; manifest: string; signature: string; sha256: string } {
  const stem = `local-harness-pack-${target}-${packVersion}`;
  return {
    archive: `${stem}.tar.gz`,
    manifest: `${stem}.manifest.json`,
    signature: `${stem}.manifest.json.sig`,
    sha256: `${stem}.tar.gz.sha256`,
  };
}
