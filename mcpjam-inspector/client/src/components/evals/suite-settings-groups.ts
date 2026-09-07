import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";

/** Edited in the suite settings header, not a tab group. */
export const SUITE_SETTINGS_HEADER_KEYS = ["name"] as const satisfies readonly EvalSuiteSettingKey[];

export const SUITE_SETTINGS_GROUPS = [
  { id: "grading", label: "Grading", rows: ["policy", "validity", "passOrFail"] },
  { id: "runs", label: "Where it runs", rows: ["computerEnvironment", "environments"] },
  { id: "limits", label: "Limits", rows: ["budgets"] },
  { id: "triggers", label: "Triggers", rows: ["schedule", "githubChecks"] },
  { id: "danger", label: "Delete suite", rows: ["deleteSuite"] },
] as const;

export type SuiteSettingsGroupId = (typeof SUITE_SETTINGS_GROUPS)[number]["id"];

export type SuiteSettingsTabId = SuiteSettingsGroupId;

export const NESTED_SETTING_KEYS: Record<string, readonly EvalSuiteSettingKey[]> = {
  policy: ["minimumAccuracy", "minimumIterations", "repetitions", "passThreshold"],
  passOrFail: ["matchOptions", "judge", "judgeRubric", "checks"],
};

/**
 * What the `environments` row is called while project environments are not
 * enabled: the row then edits the legacy axes (server group and clients), and
 * calling that "Environments" names a thing the person cannot see or use.
 * The manifest keeps "Environments" — the API field is `environmentIds` either
 * way — and the render-parity test accepts this label for that one row.
 */
export const LEGACY_CLIENTS_ROW_LABEL = "Clients";
