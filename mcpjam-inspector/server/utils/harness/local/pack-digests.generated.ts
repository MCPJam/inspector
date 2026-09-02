/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `scripts/build-local-harness-pack.mjs` (one entry per platform it
 * built) and checked in, so the digest a release verifies against is reviewed
 * in a diff rather than fetched at runtime. `pack-digests.test.ts` asserts the
 * shape and that no placeholder survives into a manifest that claims a
 * platform is native.
 *
 * An absent platform means no pack has been built for it. That resolves
 * `bundle-absent`, exactly as a missing directory would, which is the honest
 * answer: there is nothing to verify against.
 */
import type { LocalPlatform, SupportedLocalHarnessId } from "./targets.js";

export interface PackDigestRecord {
  /** Version of the pack the digest belongs to. */
  packVersion: string;
  /** Canonical tree digest, `sha256:<hex>`. */
  treeDigest: string;
}

/**
 * Tree digests of the built packs, per harness and platform.
 *
 * Empty for every harness until the pack build runs. That is deliberate: an
 * all-zero placeholder digest would be a value that can never match, whereas
 * an absent entry is a state the resolver already names.
 */
export const PACK_TREE_DIGESTS: Readonly<
  Record<SupportedLocalHarnessId, Readonly<Partial<Record<LocalPlatform, string>>>>
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
    Readonly<Partial<Record<LocalPlatform, PackDigestRecord>>>
  >
> = {
  "claude-code": {},
  codex: {},
};

/**
 * The pack version this Inspector build expects.
 *
 * One version across platforms: a pack build produces every platform from the
 * same adapter pin and the same Node version, so a split would mean two
 * different recipes shipped under one release.
 */
export const EXPECTED_PACK_VERSION = "";
