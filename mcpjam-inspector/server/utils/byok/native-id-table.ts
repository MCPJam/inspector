import type { NativeIdResult } from "./types.js";

/**
 * One reviewed canonical ↔ native pair.
 *
 * `evidence` says why the pair is right: where the native id is documented or
 * already used verbatim against the provider API. A row without evidence is
 * not accepted (see {@link createNativeIdTable}).
 */
export type NativeIdMapping = {
  /** Canonical `provider/model` id. */
  canonicalId: string;
  /** The id the provider API is called with. */
  nativeId: string;
  /**
   * Other native spellings the provider's list endpoint reports for the same
   * model (e.g. a dated snapshot of an alias). Only used for the reverse
   * lookup; requests use `nativeId`.
   */
  nativeAliases?: readonly string[];
  evidence: string;
};

export type NativeIdTable = {
  readonly rows: readonly NativeIdMapping[];
  toNativeId(canonicalId: string): NativeIdResult;
  toCanonicalId(nativeId: string): string | undefined;
};

/**
 * Build the lookups for one provider's reviewed table.
 *
 * Throws on a malformed table (empty evidence, a canonical id listed twice, a
 * native id claimed by two canonical ids) so a bad edit fails every test that
 * imports the adapter instead of mapping silently.
 */
export function createNativeIdTable(
  providerLabel: string,
  rows: readonly NativeIdMapping[],
): NativeIdTable {
  const byCanonical = new Map<string, NativeIdMapping>();
  const byNative = new Map<string, string>();
  for (const row of rows) {
    if (!row.evidence.trim()) {
      throw new Error(
        `${providerLabel} native id table: ${row.canonicalId} has no evidence`,
      );
    }
    if (byCanonical.has(row.canonicalId)) {
      throw new Error(
        `${providerLabel} native id table: ${row.canonicalId} listed twice`,
      );
    }
    byCanonical.set(row.canonicalId, row);
    for (const native of [row.nativeId, ...(row.nativeAliases ?? [])]) {
      const owner = byNative.get(native);
      if (owner !== undefined && owner !== row.canonicalId) {
        throw new Error(
          `${providerLabel} native id table: ${native} claimed by ${owner} and ${row.canonicalId}`,
        );
      }
      byNative.set(native, row.canonicalId);
    }
  }

  return {
    rows,
    toNativeId(canonicalId) {
      const row = byCanonical.get(canonicalId.trim());
      if (!row) {
        return {
          ok: false,
          code: "unmapped",
          reason: `${canonicalId} has no reviewed ${providerLabel} native id`,
        };
      }
      return { ok: true, nativeId: row.nativeId, evidence: row.evidence };
    },
    toCanonicalId(nativeId) {
      return byNative.get(nativeId.trim());
    },
  };
}

/**
 * `toNativeId` for providers whose requests use explicit, connection-specific
 * ids: the saved selection's `nativeModelId` is the only source.
 */
export function explicitNativeIdRequired(
  providerLabel: string,
  what: string,
): NativeIdResult {
  return {
    ok: false,
    code: "explicit_native_id_required",
    reason: `${providerLabel} is addressed by ${what}; use the selection's nativeModelId`,
  };
}
