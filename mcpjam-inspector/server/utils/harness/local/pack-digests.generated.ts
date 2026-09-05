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
  "claude-code": {},
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
  "claude-code": {},
  codex: {},
};

/**
 * The pack version this Inspector build expects.
 *
 * One version across targets: a pack build produces every target from the same
 * adapter pin and the same Node version, so a split would mean two different
 * recipes shipped under one release.
 */
export const EXPECTED_PACK_VERSION = "";
