/** Types for the release's pack selection. */
import type { RuntimeCompatRecordJson } from "./local-harness-pack-tables.mjs";

export interface ReleasePacks {
  claude_desired: string;
  codex_desired: string;
  claude_permitted: string;
  codex_permitted: string;
  /** Every other local runtime's desired packs, `<harnessId>=<version>` pairs. */
  runtime_desired: string;
  /** Every other local runtime's permitted packs, `<harnessId>=<version>` pairs. */
  runtime_permitted: string;
  permitted_harnesses: string;
  /** Names this set of packs in the evidence marker. */
  key: string;
}
export declare function releasePacks(record?: RuntimeCompatRecordJson): ReleasePacks;
