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
  /** Every other local runtime's legs: `{ harness, platform_key, runner, node_dist, pack_version }`. */
  runtime_matrix: string;
}
export declare function planConformance(input: {
  event: string;
  claudeVersion?: string;
  codexVersion?: string;
  /** Published packs of the other local runtimes, `<harnessId>=<version>` pairs. */
  runtimeVersions?: string;
  harnesses?: string;
  /** Drop legs for targets the harness's manifest does not advertise. */
  certifiedOnly?: boolean;
  /** A push that changed no conformance input runs no legs. */
  inputsUnchanged?: boolean;
  record?: RuntimeCompatRecordJson;
  /** Manifest facts by harness id; defaults to the committed definitions. */
  facts?: Record<string, { nativePlatforms: string[]; nativeTargets?: string[] }>;
}): ConformancePlan;
