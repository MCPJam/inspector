import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";

/** Edited in the suite settings header, not a tab group. */
export const SUITE_SETTINGS_HEADER_KEYS = ["name"] as const satisfies readonly EvalSuiteSettingKey[];

export const SUITE_SETTINGS_GROUPS = [
  { id: "grading", label: "Grading", rows: ["policy", "passOrFail"] },
  { id: "runs", label: "Where it runs", rows: ["environments"] },
  { id: "triggers", label: "Triggers", rows: ["schedule", "githubChecks"] },
] as const;

/** Trigger configuration is retained but hidden from suite settings. */
export const VISIBLE_SUITE_SETTINGS_GROUPS = SUITE_SETTINGS_GROUPS.filter(
  (group) => group.id !== "triggers",
);

export type SuiteSettingsGroupId = (typeof SUITE_SETTINGS_GROUPS)[number]["id"];

export type SuiteSettingsTabId = SuiteSettingsGroupId;

export const NESTED_SETTING_KEYS: Record<string, readonly EvalSuiteSettingKey[]> = {
  policy: [
    "minimumAccuracy",
    "minimumIterations",
    "repetitions",
    "passThreshold",
    "validity",
    "qualityGateBaseline",
    "qualityGateAllowedDrop",
    "qualityGateNoDeterministicRegressions",
    "qualityGateMaximumP95LatencyIncreaseMs",
    "qualityGateNoGatingScoreErrors",
  ],
  passOrFail: ["matchOptions", "judge", "judgeRubric", "judgeGroundedness", "checks", "predicateChecks"],
};

/**
 * What the `environments` row is called while project environments are not
 * enabled: the row then edits the legacy axes (server group and clients).
 * The manifest label is also "Clients" — the API field stays `environmentIds`.
 */
export const LEGACY_CLIENTS_ROW_LABEL = "Clients";
