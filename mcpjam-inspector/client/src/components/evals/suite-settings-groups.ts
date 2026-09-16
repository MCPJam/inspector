import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";

/** Edited in the suite settings header, outside the page sections. */
export const SUITE_SETTINGS_HEADER_KEYS = [
  "name",
] as const satisfies readonly EvalSuiteSettingKey[];

export const SUITE_SETTINGS_GROUPS = [
  {
    id: "grading",
    label: "Grading",
    // THREE rows, in the order a reader asks the questions: what must pass,
    // how many times, and does it regress against a baseline. They were one
    // row called "Quality gate", which meant somebody looking for the
    // threshold their runs are decided against had to open a heading about
    // regressions to find it — and once inside, the criterion, the count and
    // the gate shared one Edit/Close and one dirty badge.
    rows: ["policy", "iterations", "qualityGate", "passOrFail"],
  },
  { id: "runs", label: "Where it runs", rows: ["environments"] },
  {
    id: "limits",
    label: "Time & retry limits",
    // Ordered by how the clocks NEST — turn inside tool call inside iteration
    // inside run — so a reader scanning down moves outward, and the retry
    // count that multiplies the innermost sits last.
    rows: [
      "turnTimeoutMs",
      "toolCallTimeoutMs",
      "iterationTimeoutMs",
      "runTimeoutMs",
      "turnRetries",
    ],
  },
  { id: "triggers", label: "Triggers", rows: ["schedule", "githubChecks"] },
] as const;

/**
 * Placement manifest for the fixed sections of one settings page. Grading
 * spans Quality gate and Evaluators, with Where it runs between them.
 * Trigger configuration remains hidden; these groups support key lookup and
 * parity checks, rather than selecting tabs.
 */
export const VISIBLE_SUITE_SETTINGS_GROUPS = SUITE_SETTINGS_GROUPS.filter(
  (group) => group.id !== "triggers",
);

export type SuiteSettingsGroupId = (typeof SUITE_SETTINGS_GROUPS)[number]["id"];

export type SuiteSettingsTabId = SuiteSettingsGroupId;

export const NESTED_SETTING_KEYS: Record<
  string,
  readonly EvalSuiteSettingKey[]
> = {
  // Partitioned, not overlapping: every key below belongs to exactly one row,
  // and the three rows together hold what the single `policy` row used to. A
  // key under two rows would route to whichever subsection matched first,
  // which is how `validity` and the gate conditions both ended up pointing at
  // a heading that named neither.
  policy: ["minimumAccuracy", "passThreshold", "validity"],
  iterations: ["minimumIterations", "repetitions"],
  // The baseline keys left the settings page, so the quality-gate row owns
  // only the condition that never needed a baseline.
  qualityGate: ["qualityGateNoGatingScoreErrors"],
  passOrFail: [
    "assertionBacktest",
    "matchOptions",
    "judge",
    "judgeRubric",
    "judgeGroundedness",
    "checks",
  ],
  environments: ["computerEnvironment"],
};

/**
 * What the `environments` row is called while project environments are not
 * enabled: the row then edits the legacy axes (server group and clients).
 * The manifest label is also "Clients" — the API field stays `environmentIds`.
 */
export const LEGACY_CLIENTS_ROW_LABEL = "Clients";
