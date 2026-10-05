/** Types for the generated pack table reader/writer. */
export declare const PACK_TABLE_TARGETS: readonly string[];
export interface PackTableEntry {
  version: string;
  digests: Record<string, string>;
  records: Record<string, { packVersion: string; treeDigest: string }>;
}
export declare function parsePackTables(source: string): Record<string, PackTableEntry>;
export declare function rewriteHarnessPackTables(
  source: string,
  harnessId: string,
  version: string,
  digests: Record<string, string>,
): string;
export declare function parseManifestFacts(
  compatSource: string,
): Record<
  string,
  { conformance: string; nativePlatforms: string[]; nativeTargets?: string[] }
>;
