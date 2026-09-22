import { describe, expect, it } from "vitest";
import {
  advertisedLocalPlatforms,
  localExecutionReleasedForThisMachine,
  localHarnessReleaseBlockers,
  packAssetNames,
  packTargetsWithDigests,
} from "../release-gate.js";
import {
  EXPECTED_PACK_VERSION,
  PACK_RECORDS,
  type PackDigestRecord,
} from "../pack-digests.generated.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import type { LocalPackTarget } from "../targets.js";

/**
 * What this build may OFFER, as opposed to what its manifest describes.
 *
 * Three facts have to line up — manifest, digest table, published asset — and
 * nothing asked all three at once, which is how the reviewed checkout ended up
 * naming three native platforms with an empty digest table behind them.
 */

const DIGEST = `sha256:${"a".repeat(64)}`;

function records(
  entries: Partial<Record<LocalPackTarget, PackDigestRecord>>,
): typeof PACK_RECORDS {
  return { "claude-code": entries, codex: {} } as typeof PACK_RECORDS;
}

function manifestWith(overrides: {
  conformance?: string;
  platforms?: readonly ("darwin" | "linux" | "win32")[];
}) {
  return {
    "claude-code": {
      ...LOCAL_HARNESS_MANIFEST["claude-code"],
      lifecycleConformanceVersion: overrides.conformance ?? "cc-2026-09-01",
      nativePlatforms: overrides.platforms ?? (["darwin"] as const),
    },
  } as unknown as Readonly<
    Partial<Record<string, (typeof LOCAL_HARNESS_MANIFEST)["claude-code"]>>
  >;
}

describe("packTargetsWithDigests", () => {
  it("takes a digest only at the version this build expects", () => {
    // A record left over from an older pack build names a version whose asset
    // URL this release does not publish, so it is not something to offer.
    const table = records({
      "darwin-arm64": { packVersion: "3.4.0", treeDigest: DIGEST },
      "linux-x64": { packVersion: "3.3.0", treeDigest: DIGEST },
    });
    expect(packTargetsWithDigests("claude-code", table, "3.4.0")).toEqual([
      "darwin-arm64",
    ]);
  });

  it("rejects a malformed digest rather than passing it downstream", () => {
    const table = records({
      "darwin-arm64": { packVersion: "3.4.0", treeDigest: "not-a-digest" },
    });
    expect(packTargetsWithDigests("claude-code", table, "3.4.0")).toEqual([]);
  });

  it("offers nothing when no pack build has been recorded at all", () => {
    expect(
      packTargetsWithDigests(
        "claude-code",
        records({ "darwin-arm64": { packVersion: "", treeDigest: DIGEST } }),
        "",
      ),
    ).toEqual([]);
  });
});

describe("the derived offer", () => {
  it("is the intersection of the manifest and the packs actually built", () => {
    // A platform listed in `nativePlatforms` with no pack behind it is a
    // promise this build cannot keep.
    const platforms = advertisedLocalPlatforms(
      "claude-code",
      manifestWith({ platforms: ["darwin", "linux", "win32"] }),
      records({ "linux-x64": { packVersion: "3.4.0", treeDigest: DIGEST } }),
      "3.4.0",
    );
    expect(platforms).toEqual(["linux"]);
  });

  it("offers a platform when ONE of its architectures has a pack", () => {
    // darwin is two artifacts. An arm64-only release still offers darwin —
    // the x64 machine's own install resolves `unsupported-platform`, which is
    // the honest per-machine answer rather than a per-platform blackout.
    expect(
      advertisedLocalPlatforms(
        "claude-code",
        manifestWith({ platforms: ["darwin"] }),
        records({ "darwin-arm64": { packVersion: "3.4.0", treeDigest: DIGEST } }),
        "3.4.0",
      ),
    ).toEqual(["darwin"]);
  });

  it("is empty without conformance evidence, whatever the digests say", () => {
    expect(
      advertisedLocalPlatforms(
        "claude-code",
        manifestWith({ conformance: "", platforms: ["linux"] }),
        records({ "linux-x64": { packVersion: "3.4.0", treeDigest: DIGEST } }),
        "3.4.0",
      ),
    ).toEqual([]);
  });

  it("says nothing is offered on the reviewed checkout", () => {
    // Reads the REAL committed table and manifest, so this fails the day
    // somebody records conformance evidence without shipping packs — which is
    // the inconsistent release the gate exists to stop.
    expect(advertisedLocalPlatforms("claude-code")).toEqual([]);
    expect(
      localExecutionReleasedForThisMachine({ harnessId: "claude-code" }),
    ).toBe(false);
  });

  // A digest record is ONE of the three facts a release needs. On its own it
  // used to answer "released" for a build with no conformance evidence — which
  // `resolveLocalCompatibility` then refuses at runtime, so the release check
  // and the runtime gate disagreed about the same machine.
  it("refuses a digest-backed target when conformance evidence is missing", () => {
    const withDigest = records({
      "darwin-arm64": {
        packVersion: "3.4.0",
        treeDigest: DIGEST,
      } as PackDigestRecord,
    });
    expect(
      localExecutionReleasedForThisMachine({
        harnessId: "claude-code",
        platform: "darwin",
        arch: "arm64",
        manifests: manifestWith({ conformance: "cc-2026-09-01" }),
        records: withDigest,
        expectedVersion: "3.4.0",
      }),
    ).toBe(true);
    expect(
      localExecutionReleasedForThisMachine({
        harnessId: "claude-code",
        platform: "darwin",
        arch: "arm64",
        manifests: manifestWith({ conformance: "" }),
        records: withDigest,
        expectedVersion: "3.4.0",
      }),
    ).toBe(false);
  });

  it("refuses an architecture with no pack, on an OS that has one", () => {
    // `advertisedLocalPlatforms` answers about the OS: it lists `darwin` when
    // ANY darwin architecture has a pack. Asking only that — against the
    // static per-platform build list — called an Intel Mac released on the
    // strength of an Apple Silicon pack.
    const armOnly = records({
      "darwin-arm64": {
        packVersion: "3.4.0",
        treeDigest: DIGEST,
      } as PackDigestRecord,
    });
    expect(
      localExecutionReleasedForThisMachine({
        harnessId: "claude-code",
        platform: "darwin",
        arch: "arm64",
        manifests: manifestWith({}),
        records: armOnly,
        expectedVersion: "3.4.0",
      }),
    ).toBe(true);
    expect(
      localExecutionReleasedForThisMachine({
        harnessId: "claude-code",
        platform: "darwin",
        arch: "x64",
        manifests: manifestWith({}),
        records: armOnly,
        expectedVersion: "3.4.0",
      }),
    ).toBe(false);
  });

  it("refuses a digest-backed target the manifest does not call native", () => {
    expect(
      localExecutionReleasedForThisMachine({
        harnessId: "claude-code",
        platform: "darwin",
        arch: "arm64",
        manifests: manifestWith({ platforms: ["linux"] }),
        records: records({
          "darwin-arm64": {
            packVersion: "3.4.0",
            treeDigest: DIGEST,
          } as PackDigestRecord,
        }),
        expectedVersion: "3.4.0",
      }),
    ).toBe(false);
  });

  it("refuses an architecture nobody builds for", () => {
    expect(
      localExecutionReleasedForThisMachine({
        harnessId: "claude-code",
        platform: "linux",
        arch: "riscv64",
      }),
    ).toBe(false);
  });
});

describe("release blockers", () => {
  const blockersFor = (
    args: Parameters<typeof localHarnessReleaseBlockers>[0],
  ) => localHarnessReleaseBlockers(args);

  it("reports a dark release without failing it", () => {
    // No conformance evidence means the harness is offered nowhere, so
    // nothing downstream can be inconsistent with it. Failing every release
    // until an unrelated feature lands is noise nobody keeps.
    const blockers = blockersFor({
      harnessId: "claude-code",
      manifests: manifestWith({ conformance: "", platforms: ["darwin"] }),
      records: records({}),
      expectedVersion: "",
    });
    expect(blockers.map((b) => b.kind)).toEqual([
      "conformance-missing",
      "no-pack-version",
      "pack-digest-missing",
      "pack-digest-missing",
    ]);
    expect(blockers.every((b) => !b.blocking)).toBe(true);
  });

  it("FAILS a release that would offer a platform it has no pack for", () => {
    const blockers = blockersFor({
      harnessId: "claude-code",
      manifests: manifestWith({ platforms: ["darwin", "linux"] }),
      records: records({ "linux-x64": { packVersion: "3.4.0", treeDigest: DIGEST } }),
      expectedVersion: "3.4.0",
    });
    const blocking = blockers.filter((b) => b.blocking);
    expect(blocking.map((b) => b.target)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
    ]);
  });

  it("FAILS a digest table stamped at another version, dark or not", () => {
    // The table is what the NEXT release inherits, and it points every install
    // at an asset URL this release does not publish.
    const blockers = blockersFor({
      harnessId: "claude-code",
      version: "3.5.0",
      manifests: manifestWith({ conformance: "", platforms: [] }),
      records: records({}),
      expectedVersion: "3.4.0",
    });
    expect(blockers).toContainEqual(
      expect.objectContaining({ kind: "pack-version-mismatch", blocking: true }),
    );
  });

  it("passes a release whose offer is fully backed", () => {
    const blockers = blockersFor({
      harnessId: "claude-code",
      version: "3.4.0",
      manifests: manifestWith({ platforms: ["linux"] }),
      records: records({
        "linux-x64": { packVersion: "3.4.0", treeDigest: DIGEST },
        "linux-arm64": { packVersion: "3.4.0", treeDigest: DIGEST },
      }),
      expectedVersion: "3.4.0",
    });
    expect(blockers).toEqual([]);
  });

  it("names an unmanifested harness rather than throwing", () => {
    expect(
      blockersFor({
        harnessId: "claude-code",
        manifests: {},
        records: records({}),
        expectedVersion: "3.4.0",
      }).map((b) => b.kind),
    ).toEqual(["no-manifest"]);
  });

  it("holds the real committed state to the same rule", () => {
    // Whatever `pack-digests.generated.ts` and `compatibility.ts` say today,
    // they must not describe a build that offers something it cannot serve.
    const blocking = localHarnessReleaseBlockers({
      harnessId: "claude-code",
      version: EXPECTED_PACK_VERSION || undefined,
    }).filter((b) => b.blocking);
    expect(blocking).toEqual([]);
  });
});

describe("packAssetNames", () => {
  it("names exactly what a client's installer would fetch", () => {
    // Derived from the same stem the build writes and `packSourceFor`
    // downloads: a check that guesses the name proves nothing about the name
    // a user's installer asks for.
    expect(packAssetNames("darwin-arm64", "3.4.0")).toEqual({
      archive: "local-harness-pack-darwin-arm64-3.4.0.tar.gz",
      manifest: "local-harness-pack-darwin-arm64-3.4.0.manifest.json",
      signature: "local-harness-pack-darwin-arm64-3.4.0.manifest.json.sig",
      sha256: "local-harness-pack-darwin-arm64-3.4.0.tar.gz.sha256",
    });
  });
});

describe("the release script and this module read the same committed facts", () => {
  it("agrees about what is advertised and whether it is blocking", async () => {
    // `scripts/check-local-harness-release.mjs` cannot import TypeScript, so
    // it parses the two generated/reviewed sources instead. That is a second
    // reader of the same facts, and two readers drift. This pins them: if the
    // script's regexes stop finding the version, the digests or the platform
    // list, they answer "" / {} / [] and this comparison fails loudly rather
    // than the release check quietly passing everything.
    const { readCommittedFacts } = await import(
      "../../../../../scripts/check-local-harness-release.mjs"
    );
    const facts = await readCommittedFacts();

    expect(facts.expectedVersion).toBe(EXPECTED_PACK_VERSION);
    expect(facts.conformance).toBe(
      LOCAL_HARNESS_MANIFEST["claude-code"].lifecycleConformanceVersion,
    );
    expect(facts.nativePlatforms).toEqual([
      ...LOCAL_HARNESS_MANIFEST["claude-code"].nativePlatforms,
    ]);
    expect(Object.keys(facts.records).sort()).toEqual(
      Object.keys(PACK_RECORDS["claude-code"]).sort(),
    );
    for (const [target, record] of Object.entries(facts.records)) {
      expect(record).toEqual(
        PACK_RECORDS["claude-code"][target as LocalPackTarget],
      );
    }
  });
});
