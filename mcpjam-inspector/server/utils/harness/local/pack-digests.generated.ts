/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `scripts/write-pack-digests.mjs` from the pack build's own output
 * and checked in, so the digest a release verifies against is reviewed in a
 * diff rather than fetched at runtime. `pack-digests.test.ts` asserts the shape
 * and that no platform is called native without a digest to admit it.
 *
 * Keyed by pack TARGET — `darwin-arm64`, not `darwin` — because a pack carries
 * `bin/node` and the vendor CLI, which are machine code. An absent target means
 * no pack has been built for it, which resolves `bundle-absent` exactly as a
 * missing directory would: there is nothing to verify against.
 */
import type { LocalPackTarget, SupportedLocalHarnessId } from "./targets.js";

export interface PackDigestRecord {
  /** Version of the pack the digest belongs to. */
  packVersion: string;
  /** Canonical tree digest, `sha256:<hex>`. */
  treeDigest: string;
}

/**
 * Tree digests of the built packs, per harness and pack target.
 *
 * Empty for every harness until the pack build runs. That is deliberate: an
 * all-zero placeholder digest would be a value that can never match, whereas
 * an absent entry is a state the resolver already names.
 */
export const PACK_TREE_DIGESTS: Readonly<
  Record<SupportedLocalHarnessId, Readonly<Partial<Record<LocalPackTarget, string>>>>
> = {
  "claude-code": {
    "darwin-arm64": "sha256:e59586541b541e0673ca9f74f90bcf5b19bde4c553611c5e7745a67a7d9d80f1",
    "darwin-x64": "sha256:c72405c79c67d5578c11fd0bc916594e2dd429e4f1220845c9f67c0002eae749",
    "linux-arm64": "sha256:4b8f8b14f2fe403bcb6d56d6069f4dca661844619f946433bdb6676077cb89b7",
    "linux-x64": "sha256:a21fcb7ccefb2057e7814a6028995a3cdb4ed47daf90bc179d7ee8ed3c748132",
    "win32-x64": "sha256:58d48aa771a3b1d87d22a720504722afb81ac35f43726d49cd303d4c1572d4d0",
  },
  "codex": {
    "darwin-arm64": "sha256:4af884406dfadffff45db2d9b695239c88bb3e24ce5ed95af2729e4179d74428",
    "darwin-x64": "sha256:5b9edbb89ede80eb096dc3f9bbe40b4dbd646a6346e7a0f31c5dedab546ca90d",
    "linux-arm64": "sha256:32065a4edeb7a10c541b01e9080e62383ba5762a3a6960604839888784ae5ee5",
    "linux-x64": "sha256:42d942ba6e9a9d71d51e3303accdf69a6461fbd8f7f425fda85a814360e840da",
    "win32-x64": "sha256:23eb29259906b95b138d78043639635d41063469b1bc6f0cb53ad732bc039cbf",
  },
};

/**
 * Full pack records, for the installer (which needs the version to build a
 * download URL and a target directory) and for the UI (which shows it).
 */
export const PACK_RECORDS: Readonly<
  Record<
    SupportedLocalHarnessId,
    Readonly<Partial<Record<LocalPackTarget, PackDigestRecord>>>
  >
> = {
  "claude-code": {
    "darwin-arm64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:e59586541b541e0673ca9f74f90bcf5b19bde4c553611c5e7745a67a7d9d80f1",
    },
    "darwin-x64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:c72405c79c67d5578c11fd0bc916594e2dd429e4f1220845c9f67c0002eae749",
    },
    "linux-arm64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:4b8f8b14f2fe403bcb6d56d6069f4dca661844619f946433bdb6676077cb89b7",
    },
    "linux-x64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:a21fcb7ccefb2057e7814a6028995a3cdb4ed47daf90bc179d7ee8ed3c748132",
    },
    "win32-x64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:58d48aa771a3b1d87d22a720504722afb81ac35f43726d49cd303d4c1572d4d0",
    },
  },
  "codex": {
    "darwin-arm64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:4af884406dfadffff45db2d9b695239c88bb3e24ce5ed95af2729e4179d74428",
    },
    "darwin-x64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:5b9edbb89ede80eb096dc3f9bbe40b4dbd646a6346e7a0f31c5dedab546ca90d",
    },
    "linux-arm64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:32065a4edeb7a10c541b01e9080e62383ba5762a3a6960604839888784ae5ee5",
    },
    "linux-x64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:42d942ba6e9a9d71d51e3303accdf69a6461fbd8f7f425fda85a814360e840da",
    },
    "win32-x64": {
      packVersion: "1.0.1",
      treeDigest: "sha256:23eb29259906b95b138d78043639635d41063469b1bc6f0cb53ad732bc039cbf",
    },
  },
};

/**
 * The pack version this Inspector build expects, PER HARNESS.
 *
 * Per harness because each harness's pack is its own release with its own
 * semver (`local-harness-pack-v<ver>` for Claude Code,
 * `local-harness-pack-<harness>-v<ver>` for the others): publishing a Codex
 * pack must not move the version an Inspector expects for Claude Code.
 *
 * One version across TARGETS within a harness: a pack build produces every
 * target from the same recipe and the same Node version, so a split would mean
 * two different recipes shipped under one release.
 */
export const EXPECTED_PACK_VERSIONS: Readonly<
  Record<SupportedLocalHarnessId, string>
> = {
  "claude-code": "1.0.1",
  "codex": "1.0.1",
};
