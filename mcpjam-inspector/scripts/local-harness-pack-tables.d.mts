/** Types for the runtime compatibility record reader/writer. */
export declare const PACK_TABLE_TARGETS: readonly string[];
export declare const RUNTIME_COMPAT_PATH: string;

export interface PackRef {
  packVersion: string;
  treeDigest: string;
}
export interface RuntimeCompatRecordJson {
  schema: 1;
  harnesses: Record<
    string,
    {
      conformance: { version: string; evidence?: string };
      targets: Record<string, { desired: PackRef; permitted?: PackRef }>;
    }
  >;
}
export declare function parseRuntimeCompat(text: string): RuntimeCompatRecordJson;
export declare function readRuntimeCompat(path?: string): RuntimeCompatRecordJson;
export declare function renderRuntimeCompat(record: RuntimeCompatRecordJson): string;

export interface PackTableEntry {
  /** The DESIRED pack version ("" when none is pinned). */
  version: string;
  digests: Record<string, string>;
  records: Record<string, PackRef>;
  /** The permitted previous pack per target, where one is pinned. */
  permitted: Record<string, PackRef>;
  conformance: string;
  evidence?: string;
}
export declare function parsePackTables(source: string): Record<string, PackTableEntry>;
export declare function rewriteHarnessPackTables(
  source: string,
  harnessId: string,
  version: string,
  digests: Record<string, string>,
  options?: { permitPrevious?: boolean; conformance?: string; evidence?: string },
): string;
export declare function parseManifestFacts(
  compatSource: string,
): Record<string, { nativePlatforms: string[]; nativeTargets?: string[] }>;
export declare const TARGETS_BY_PLATFORM: Readonly<Record<string, readonly string[]>>;
/** Every target a harness's manifest advertises, narrowed per D8 (`nativeTargets`). */
export declare function advertisedTargetsOf(
  facts: { nativePlatforms: string[]; nativeTargets?: string[] } | undefined,
): string[];
/** The targets one harness advertises, read from the committed `compatibility.ts`. */
export declare function readAdvertisedTargets(harnessId: string): string[];
