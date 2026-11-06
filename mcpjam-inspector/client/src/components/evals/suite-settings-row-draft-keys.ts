import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import type { SuiteSettingsKey } from "./suite-settings-draft";

/** Which draft keys light each settings row's Unsaved and conflict chips. */
export const ROW_DRAFT_KEYS: Partial<
  Record<EvalSuiteSettingKey, SuiteSettingsKey[]>
> = {
  name: ["name"],
  checks: ["defaultPredicates"],
  // Partitioned by ROW, so a dirty badge names the row that is actually
  // dirty. One `policy` entry used to carry all five keys, which meant
  // editing the quality gate lit the criterion row's badge and editing the
  // threshold lit the gate's — invisible while the three were one row, and
  // wrong the moment they were not.
  //
  // `verdictPolicyDefaults` is the one key that genuinely belongs to more
  // than one row: it is a single stored object holding the threshold, the
  // count and the validity block. Splitting it here would need a deep diff of
  // a stored shape, and a badge that under-reports is worse than one that
  // over-reports — so both rows watch it and say so.
  policy: ["defaultPassCriteria", "verdictPolicyDefaults"],
  iterations: ["minIterations", "verdictPolicyDefaults"],
  qualityGate: ["gatePolicy"],
  validity: ["verdictPolicyDefaults"],
  passOrFail: [
    "defaultMatchOptions",
    "defaultPredicates",
    "judgeConfig",
    "judgeRubric",
  ],
  computerEnvironment: ["computerEnvironmentId"],
  // One clock per row, so each badge names exactly the clock it belongs to.
  turnTimeoutMs: ["turnTimeoutMs"],
  toolCallTimeoutMs: ["toolCallTimeoutMs"],
  iterationTimeoutMs: ["iterationTimeoutMs"],
  runTimeoutMs: ["runTimeoutMs"],
  turnRetries: ["turnRetries"],
};
