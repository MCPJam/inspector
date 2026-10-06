/** Types for the conformance leg planner. */
import type { RuntimeCompatRecordJson } from "./local-harness-pack-tables.mjs";

export interface ConformancePlan {
  claude_pack_version: string;
  codex_pack_version: string;
  run_claude: "true" | "false" | string;
  run_codex: "true" | "false" | string;
  run_windows: "true" | "false" | string;
  /** JSON matrix `include` list. */
  posix_matrix: string;
  codex_matrix: string;
}
export declare function planConformance(input: {
  event: string;
  claudeVersion?: string;
  codexVersion?: string;
  harnesses?: string;
  record?: RuntimeCompatRecordJson;
}): ConformancePlan;
