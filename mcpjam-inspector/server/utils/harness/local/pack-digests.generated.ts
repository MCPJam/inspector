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
    "darwin-arm64": "sha256:4691b55e3d704e443355bf4e12e1fa2a0dd8d0cd4d38d93fd13bf0d022a92a9a",
    "darwin-x64": "sha256:6f314d80d2ab3e6361ba52b33a44697085d17d4f2265edafaefae397896ca7e0",
    "linux-arm64": "sha256:3326079564bafad84322a9d6ea9d7268e1b1fd9a8716d4e3aee4e1058cf53322",
    "linux-x64": "sha256:9a78a6e369abc0d67ef19c71e751046f48303315cb086098e7728e34f153e3a9",
    "win32-x64": "sha256:ef8f01c61a4058684c808aee90c063a2d5418337697fec6190ec193041f4e860",
  },
  codex: {},
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
      packVersion: "3.3.6",
      treeDigest: "sha256:4691b55e3d704e443355bf4e12e1fa2a0dd8d0cd4d38d93fd13bf0d022a92a9a",
    },
    "darwin-x64": {
      packVersion: "3.3.6",
      treeDigest: "sha256:6f314d80d2ab3e6361ba52b33a44697085d17d4f2265edafaefae397896ca7e0",
    },
    "linux-arm64": {
      packVersion: "3.3.6",
      treeDigest: "sha256:3326079564bafad84322a9d6ea9d7268e1b1fd9a8716d4e3aee4e1058cf53322",
    },
    "linux-x64": {
      packVersion: "3.3.6",
      treeDigest: "sha256:9a78a6e369abc0d67ef19c71e751046f48303315cb086098e7728e34f153e3a9",
    },
    "win32-x64": {
      packVersion: "3.3.6",
      treeDigest: "sha256:ef8f01c61a4058684c808aee90c063a2d5418337697fec6190ec193041f4e860",
    },
  },
  codex: {},
};

/**
 * The pack version this Inspector build expects.
 *
 * One version across targets: a pack build produces every target from the same
 * adapter pin and the same Node version, so a split would mean two different
 * recipes shipped under one release.
 */
export const EXPECTED_PACK_VERSION = "3.3.6";
