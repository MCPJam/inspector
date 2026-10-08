/**
 * The pinned pack tables, DERIVED from `runtime-compat.generated.json`.
 *
 * This file used to be the generated source of truth, written by
 * `scripts/write-pack-digests.mjs` and parsed back out of TypeScript by every
 * release script. The record moved to JSON (see `runtime-compat.ts`) so that
 * a build can pin a desired pack AND a permitted previous one, and so scripts
 * read it without a TypeScript parser. These exports keep their names and
 * shapes because the installer, the release gate and the UI read them; they
 * describe the DESIRED pack only. `PERMITTED_PACK_RECORDS` is the previous one.
 *
 * Keyed by pack TARGET — `darwin-arm64`, not `darwin` — because a pack carries
 * `bin/node` and the vendor CLI, which are machine code. An absent target means
 * no pack has been built for it, which resolves `bundle-absent` exactly as a
 * missing directory would: there is nothing to verify against.
 */
import { RUNTIME_COMPAT, type RuntimePackRef } from "./runtime-compat.js";
import type { LocalPackTarget, SupportedLocalHarnessId } from "./targets.js";

export type PackDigestRecord = RuntimePackRef;

type PerTarget<T> = Readonly<Partial<Record<LocalPackTarget, T>>>;

function perHarness<T>(
  pick: (slot: {
    desired: RuntimePackRef;
    permitted?: RuntimePackRef;
  }) => T | undefined,
): Readonly<Record<SupportedLocalHarnessId, PerTarget<T>>> {
  const out: Record<string, Partial<Record<LocalPackTarget, T>>> = {};
  for (const [harnessId, entry] of Object.entries(RUNTIME_COMPAT.harnesses)) {
    const targets: Partial<Record<LocalPackTarget, T>> = {};
    for (const [target, slot] of Object.entries(entry.targets)) {
      const value = slot === undefined ? undefined : pick(slot);
      if (value !== undefined) targets[target as LocalPackTarget] = value;
    }
    out[harnessId] = targets;
  }
  return out as Record<SupportedLocalHarnessId, PerTarget<T>>;
}

/** Desired tree digest per harness and pack target. */
export const PACK_TREE_DIGESTS: Readonly<
  Record<SupportedLocalHarnessId, PerTarget<string>>
> = perHarness((slot) => slot.desired.treeDigest);

/** Desired pack records, for the installer and the UI. */
export const PACK_RECORDS: Readonly<
  Record<SupportedLocalHarnessId, PerTarget<PackDigestRecord>>
> = perHarness((slot) => ({ ...slot.desired }));

/** The permitted previous pack per harness and target, where one is pinned. */
export const PERMITTED_PACK_RECORDS: Readonly<
  Record<SupportedLocalHarnessId, PerTarget<PackDigestRecord>>
> = perHarness((slot) => (slot.permitted ? { ...slot.permitted } : undefined));

/**
 * The desired pack version per harness ("" when none is pinned). One version
 * across targets: `parseRuntimeCompatRecord` refuses a record that desires two.
 */
export const EXPECTED_PACK_VERSIONS: Readonly<
  Record<SupportedLocalHarnessId, string>
> = Object.fromEntries(
  Object.entries(RUNTIME_COMPAT.harnesses).map(([harnessId, entry]) => [
    harnessId,
    Object.values(entry.targets)[0]?.desired.packVersion ?? "",
  ]),
) as Record<SupportedLocalHarnessId, string>;
