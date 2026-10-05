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
    "darwin-arm64": "sha256:6be44d7bf98cfb4eb536079835b1516883af2d076fa7911c51dfa4125424fe99",
    "darwin-x64": "sha256:174abc72bacec5d4bc73d6dbfabd7d350a17be78e8b0f2380c642424a62f749f",
    "linux-arm64": "sha256:06c84a9eae32a0eed410c7a757ee7847218a15bbb41c9e42b87b87496a2684c5",
    "linux-x64": "sha256:3e780532617863c2b8350a20e42bed091a76ca21f79a19106ccf6694712c6668",
    "win32-x64": "sha256:13a895fc012dc6d0ccb132a0a895c07e4ae80c9135629028a2508b155903ef5d",
  },
  "codex": {
    "darwin-arm64": "sha256:497de272c280b6ba555445703b45fc21c916754e18caa3476f17acbe36fa4eea",
    "darwin-x64": "sha256:70a5ef882831b15caaf5111a22daf444cd52e2ab5a725331c342c2a72b5b2afd",
    "linux-arm64": "sha256:4e402779f50063f3f983781c0e363306b6d5389b20a43c1c9910fd95db8866bd",
    "linux-x64": "sha256:446052eea51ca42947f4012b2a10ee63e936d772b64a1e00e153f8ff1dbec81f",
    "win32-x64": "sha256:4293b1a9cc8ed5484cb504a5c0d6a9bd5dec2b7a7e1ee4268e68bcb9e8421f82",
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
      packVersion: "1.0.0",
      treeDigest: "sha256:6be44d7bf98cfb4eb536079835b1516883af2d076fa7911c51dfa4125424fe99",
    },
    "darwin-x64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:174abc72bacec5d4bc73d6dbfabd7d350a17be78e8b0f2380c642424a62f749f",
    },
    "linux-arm64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:06c84a9eae32a0eed410c7a757ee7847218a15bbb41c9e42b87b87496a2684c5",
    },
    "linux-x64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:3e780532617863c2b8350a20e42bed091a76ca21f79a19106ccf6694712c6668",
    },
    "win32-x64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:13a895fc012dc6d0ccb132a0a895c07e4ae80c9135629028a2508b155903ef5d",
    },
  },
  "codex": {
    "darwin-arm64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:497de272c280b6ba555445703b45fc21c916754e18caa3476f17acbe36fa4eea",
    },
    "darwin-x64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:70a5ef882831b15caaf5111a22daf444cd52e2ab5a725331c342c2a72b5b2afd",
    },
    "linux-arm64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:4e402779f50063f3f983781c0e363306b6d5389b20a43c1c9910fd95db8866bd",
    },
    "linux-x64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:446052eea51ca42947f4012b2a10ee63e936d772b64a1e00e153f8ff1dbec81f",
    },
    "win32-x64": {
      packVersion: "1.0.0",
      treeDigest: "sha256:4293b1a9cc8ed5484cb504a5c0d6a9bd5dec2b7a7e1ee4268e68bcb9e8421f82",
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
  "claude-code": "1.0.0",
  "codex": "1.0.0",
};
