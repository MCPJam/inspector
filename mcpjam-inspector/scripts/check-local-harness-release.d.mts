/**
 * Types for the release check's one exported reader.
 *
 * The script is plain ESM — it runs under a bare Node in the release workflow,
 * with no TypeScript in the loop — so it carries a hand-written declaration
 * rather than being compiled. Only `readCommittedFacts` is exported;
 * `release-gate.test.ts` imports it to pin the script's parsing of the
 * generated sources to what the TypeScript modules actually export, because
 * two readers of the same facts drift.
 */
export declare function readCommittedFacts(): Promise<
  Record<
    string,
    {
      /** `EXPECTED_PACK_VERSIONS[harnessId]`, or "" when no pack build has been recorded. */
      expectedVersion: string;
      /** `PACK_RECORDS[harnessId]`, keyed by pack target. */
      records: Record<string, { packVersion: string; treeDigest: string }>;
      /** The harness manifest's `lifecycleConformanceVersion`. */
      conformance: string;
      /** The harness manifest's `nativePlatforms`. */
      nativePlatforms: string[];
    }
  >
>;
