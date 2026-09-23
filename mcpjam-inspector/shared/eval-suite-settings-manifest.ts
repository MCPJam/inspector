/**
 * Every row in the eval-suite settings sheet, and how an agent reaches it.
 *
 * THE PROBLEM THIS SOLVES. The settings sheet is the only place several eval
 * behaviors can be configured. A row can ship there — a JSX block, a toggle, a
 * picker — and be invisible from the SDK, the CLI and MCP, with nothing in the
 * codebase that notices. That is not hypothetical: LLM as Judge could not be
 * turned on from the CLI for as long as the public field carried `enabled`
 * without `autoRun`, and the computer-image picker had no API representation
 * at all.
 *
 * A hand-kept list of setting KEYS would not have caught either, because
 * nothing forces a new JSX row to touch such a list. So this manifest is the
 * single DECLARATION both sides read:
 *
 *  - the settings sheet imports it, and `SettingsSection` takes a key from it
 *    and stamps `data-setting-key`. A row rendered without an entry is a TYPE
 *    ERROR where it is authored;
 *  - a render test asserts every stamped key has an entry, so the type error
 *    cannot be cast away silently;
 *  - an API test asserts every `api:` path is actually accepted by the public
 *    PATCH schema, and every `op:` names a real platform operation. A manifest
 *    entry is a CLAIM; those tests are the proof.
 *
 * Three answers, because "reachable" has three honest shapes:
 *
 *   `api`      — a field on `PATCH /v1/projects/{p}/eval-suites/{id}`, written
 *                as its dotted path into the request body.
 *   `op`       — reachable, but through its OWN platform operation rather than
 *                the suite PATCH (a schedule, a delete). Not a gap.
 *   `excluded` — deliberately not on the agent surfaces, with the reason. The
 *                cost of an exclusion is that the one row it silences is the
 *                one nothing will check again, so keep this list short and
 *                make each reason specific enough to argue with.
 */

import {
  EVAL_GRADING_VALIDITY_LABELS,
  EVAL_ITERATION_RULE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_LABELS,
} from "@mcpjam/sdk/contract";

/** One settings row: what it is called, and how an agent reaches it. */
export type EvalSuiteSettingRow = {
  /** Stable identifier, stamped as `data-setting-key` on the rendered row. */
  key: string;
  /**
   * This row is NOT on the suite settings page — it is reached from another
   * surface (the suite header, org settings), and its `api`/`op` claim is how
   * an agent reaches it.
   *
   * It is not a general escape hatch. `SETTINGS_PAGE_HIDDEN_KEYS` below is the
   * closed list, pinned by a test, precisely because "hidden" was once how a
   * row left the page without anything noticing.
   */
  settingsPage?: "hidden";
  /** The row's visible label, so a reader can match manifest to screen. */
  label: string;
} & (
  | { api: string; op?: never; excluded?: never }
  | { op: string; api?: never; excluded?: never }
  | { excluded: string; api?: never; op?: never }
);

export const EVAL_SUITE_SETTINGS_MANIFEST = [
  {
    key: "name",
    label: "Name",
    api: "name",
  },
  {
    key: "minimumAccuracy",
    // The SUITE-WIDE criterion, in percent. Labelled from the shared grading
    // vocabulary rather than spelled here, because the same words have to
    // appear on this row, in the review dialog, in revision history and in the
    // CLI's flag help — and "Minimum accuracy" beside a per-case suite's
    // "Pass threshold" read as two units of one number rather than two
    // different questions.
    label: EVAL_PASS_CRITERION_SCOPE_LABELS.suiteWide,
    api: "settings.minimumAccuracy",
  },
  {
    key: "minimumIterations",
    // A FLOOR that raises a case's own count, not a default that replaces it.
    // The word "minimum" is the whole difference and is never dropped: a case
    // at 7 resolves to 7 under a floor of 3 and to 3 under a default of 3.
    label: EVAL_ITERATION_RULE_LABELS.caseCountWithFloor,
    api: "settings.minimumIterations",
  },
  {
    key: "computerEnvironment",
    label: "Computer environment",
    api: "environment.computerEnvironment",
  },
  {
    key: "environments",
    label: "Where it runs",
    api: "environmentIds",
  },
  {
    key: "passOrFail",
    label: "Evaluators",
    // A PRESENTATION grouping, not a setting. It has no stored field of its
    // own: it arranges settings.matchOptions, settings.checks and
    // settings.judge under the chain stage each one measures, and every one of
    // those is reachable on its own below.
    excluded:
      "A presentation grouping of settings.matchOptions, settings.checks and settings.judge, each of which is reachable on its own.",
  },
  {
    key: "matchOptions",
    label: "Edit tool-call matching",
    api: "settings.matchOptions",
  },
  {
    key: "checks",
    label: "Evaluators",
    api: "settings.checks",
  },
  {
    key: "judge",
    label: "Judge",
    api: "settings.judge",
  },
  {
    key: "judgeRubric",
    label: "Grading instructions",
    api: "settings.judge.rubric",
  },
  {
    key: "judgeGroundedness",
    label: "Groundedness",
    // Read-only run evidence until R2-C1 wires execution. A writable sample
    // would claim a PATCH path the schema explicitly refuses.
    excluded:
      "Displays on-demand groundedness run evidence and cannot yet author settings while execution is unwired.",
  },
  {
    key: "policy",
    // WHAT MUST PASS, and how much. Not the quality gate — that is a
    // comparison against a baseline run and is its own row below. This row
    // held both names for as long as one row held both things, and a reader
    // looking for the threshold their runs are decided against found a heading
    // about regressions.
    label: "Pass criteria",
    // The row shows ONE criterion, the one this suite's runs are decided
    // against, and the scope decides which field that is. Both are reachable
    // on their own above and below.
    excluded:
      "A presentation grouping of settings.minimumAccuracy, settings.passThreshold and settings.validity; the row itself only shows whichever criterion decides this suite.",
  },
  {
    key: "iterations",
    // HOW MANY TIMES each case runs. Split out of the criterion row because
    // the two answer different questions and are edited independently: raising
    // the count does not move the bar, and moving the bar does not change how
    // much evidence there is.
    label: "Iterations",
    excluded:
      "A presentation grouping of settings.minimumIterations and settings.repetitions; the row itself only shows whichever count rule this suite uses.",
  },
  {
    key: "repetitions",
    // A DEFAULT that a case replaces, not a floor that raises it. Same
    // vocabulary as the floor above, one word apart, on purpose.
    label: EVAL_ITERATION_RULE_LABELS.defaultCount,
    api: "settings.repetitions",
  },
  {
    key: "passThreshold",
    /** The PER-CASE criterion, as a fraction. @see minimumAccuracy */
    label: EVAL_PASS_CRITERION_SCOPE_LABELS.perCase,
    api: "settings.passThreshold",
  },
  {
    key: "validity",
    // "Evidence requirements", not "Validity": the stored word names the
    // mechanism and the label names what a reader is deciding — whether a run
    // that measured too little is inconclusive rather than passed or failed.
    label: EVAL_GRADING_VALIDITY_LABELS.enforced,
    api: "settings.validity",
  },
  {
    key: "qualityGate",
    // The quality gate answers a DIFFERENT question from the pass criteria: not
    // "did this run meet the bar" but "should this run block a merge". It has
    // its own conditions and its own audit requirement, and folding it under
    // the criterion row is what made one heading mean both.
    //
    // Baseline comparison is no longer edited here, so the row holds only the
    // condition that never needed a baseline. The comparison fields are still
    // on the API — see `SETTINGS_PAGE_HIDDEN_KEYS`.
    label: "Quality gate",
    excluded:
      "A presentation grouping of the settings.qualityGate conditions, each of which is reachable on its own.",
  },
  {
    key: "qualityGateBaseline",
    settingsPage: "hidden",
    label: "Baseline",
    api: "settings.qualityGate.baseline",
  },
  {
    key: "qualityGateAllowedDrop",
    settingsPage: "hidden",
    label: "Allowed drop",
    api: "settings.qualityGate.maximumPassRateDrop",
  },
  {
    key: "qualityGateNoDeterministicRegressions",
    settingsPage: "hidden",
    label: "Deterministic regressions",
    api: "settings.qualityGate.noDeterministicRegressions",
  },
  {
    key: "qualityGateMaximumP95LatencyIncreaseMs",
    settingsPage: "hidden",
    label: "p95 latency increase",
    api: "settings.qualityGate.maximumP95LatencyIncreaseMs",
  },
  {
    key: "qualityGateNoGatingScoreErrors",
    label: "Any required evaluator errored",
    api: "settings.qualityGate.noGatingScoreErrors",
  },
  {
    key: "schedule",
    settingsPage: "hidden",
    label: "Schedule",
    // Its own route (`PATCH …/eval-suites/{id}/schedule`) because enabling a
    // schedule has to reject a multi-environment suite that names no
    // environment — a validation the suite PATCH would have to grow a
    // cross-field rule for.
    op: "set_eval_suite_schedule",
  },
  {
    key: "githubChecks",
    settingsPage: "hidden",
    label: "GitHub Checks",
    // ORG-scoped, not suite-scoped: connecting a repository configures the
    // organization's GitHub App installation, and the suite only decides which
    // suite that repository answers for. So it has its own route family and its
    // own operations rather than a field on `update_eval_suite`. The op named
    // here is the WRITE this row performs; `list_eval_github_repos` is its read.
    op: "connect_eval_github_repo",
  },
  {
    key: "deleteSuite",
    settingsPage: "hidden",
    label: "Delete suite",
    op: "delete_eval_suite",
  },
] as const satisfies readonly EvalSuiteSettingRow[];

/** The key of every declared settings row. */
export type EvalSuiteSettingKey =
  (typeof EVAL_SUITE_SETTINGS_MANIFEST)[number]["key"];

/**
 * The CLOSED list of rows that are not on the suite settings page, each with
 * where it actually lives.
 *
 * Frozen and pinned by a test. `settingsPage: "hidden"` began as a way to note
 * that a row had moved and became the reason twelve rows could leave the page
 * without a single ratchet noticing — the render-parity check skipped anything
 * carrying it. Adding a key here is now a deliberate test change.
 */
export const SETTINGS_PAGE_HIDDEN_KEYS = {
  // Baseline comparison was removed from the settings page. The fields are
  // unchanged on the API and a run still enforces them, so the three
  // conditions that need a baseline are hidden with it rather than left as
  // controls nothing could satisfy. A suite that carries one is shown
  // read-only in the quality-gate section.
  qualityGateBaseline: "API and CLI only; not edited on the settings page",
  qualityGateAllowedDrop: "API and CLI only; needs a baseline",
  qualityGateNoDeterministicRegressions: "API and CLI only; needs a baseline",
  qualityGateMaximumP95LatencyIncreaseMs: "API and CLI only; needs a baseline",
  schedule: "Triggers group, gated on the scheduled-evals feature flag",
  githubChecks: "Organization settings → GitHub Checks, per repository",
  deleteSuite: "Suite overview header",
} as const satisfies Record<string, string>;

export const EVAL_SUITE_SETTING_KEYS: readonly EvalSuiteSettingKey[] =
  EVAL_SUITE_SETTINGS_MANIFEST.map((row) => row.key);

/**
 * One value per `api:` path, of the shape the PATCH schema actually accepts.
 *
 * Roles ride the check items themselves — there is no `scorerRoles` row.
 * The advisory sample exists so a future schema that dropped `role` /
 * `severity` fails the parity ratchet instead of silently stripping them.
 */
export const SAMPLE_BY_PATH: Readonly<Record<string, unknown>> = {
  name: "Renamed",
  "settings.minimumAccuracy": 80,
  "settings.minimumIterations": 3,
  "settings.matchOptions": { toolCallOrder: "exact" },
  "settings.checks": [
    { type: "responseContains", needle: "hi" },
    { type: "noToolErrors", role: "advisory", severity: "warn" },
  ],
  "settings.judge": {
    enabled: true,
    autoRun: true,
    threshold: 0.8,
    severity: "warn",
  },
  "settings.judge.rubric": {
    criteria: [{ id: "cites", label: "Cites a source" }],
  },
  "settings.repetitions": 3,
  "settings.passThreshold": 0.8,
  "settings.validity": { minCompletionRate: 0.9 },
  "settings.qualityGate.baseline": { kind: "run", runId: "run_baseline" },
  "settings.qualityGate.maximumPassRateDrop": 0.03,
  "settings.qualityGate.noDeterministicRegressions": true,
  "settings.qualityGate.maximumP95LatencyIncreaseMs": 0,
  "settings.qualityGate.noGatingScoreErrors": true,
  "environment.computerEnvironment": "Playwright",
  environmentIds: ["env_1"],
};

/**
 * Vocabulary-2 samples: the same settings, in the canonical spellings.
 *
 * Separate from {@link SAMPLE_BY_PATH} rather than replacing entries in it,
 * because the two are checked against DIFFERENT boundaries. The vocabulary-1
 * samples must keep parsing byte-for-byte as they do today; these must be
 * refused without `x-mcpjam-eval-vocabulary: 2` and accepted with it.
 *
 * `settings.checks` keeps its advisory `severity: "warn"` row in the
 * vocabulary-1 sample for the reason stated above — dropping `severity` is a
 * contraction step, not this one.
 */
export const CANONICAL_ROLE_SAMPLE_BY_PATH: Readonly<Record<string, unknown>> =
  {
    "settings.checks": [
      { type: "responseContains", needle: "hi" },
      { type: "noToolErrors", role: "required" },
    ],
    "settings.judge": { enabled: true, role: "required" },
  };

/**
 * Full PATCH bodies that exercise `settings.qualityGate` against the
 * refined schema. A standalone leaf is not enough: the refine requires
 * `expectedRevisionNumber` and `revisionNote`, and comparative leaves
 * require a baseline.
 */
export const QUALITY_GATE_REQUEST_SAMPLES: ReadonlyArray<{
  name: string;
  body: Record<string, unknown>;
}> = [
  {
    name: "full object",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Tighten the release bar for the next cut.",
      settings: {
        qualityGate: {
          baseline: { kind: "run", runId: "run_baseline" },
          maximumPassRateDrop: 0.05,
          noDeterministicRegressions: true,
          maximumP95LatencyIncreaseMs: 250,
          noGatingScoreErrors: true,
        },
      },
    },
  },
  {
    name: "baseline only",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Pin the comparison run.",
      settings: {
        qualityGate: { baseline: { kind: "run", runId: "run_baseline" } },
      },
    },
  },
  {
    name: "maximum drop",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Cap observed pass-rate drop.",
      settings: {
        qualityGate: {
          baseline: { kind: "run", runId: "run_baseline" },
          maximumPassRateDrop: 0.03,
        },
      },
    },
  },
  {
    name: "deterministic regressions",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Fail a flipped deterministic scorer.",
      settings: {
        qualityGate: {
          baseline: { kind: "commit_sha", commitSha: "abc1234" },
          noDeterministicRegressions: true,
        },
      },
    },
  },
  {
    name: "p95 latency",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Cap p95 growth.",
      settings: {
        qualityGate: {
          baseline: { kind: "run", runId: "run_baseline" },
          maximumP95LatencyIncreaseMs: 0,
        },
      },
    },
  },
  {
    name: "gating-score errors",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Fail on required scorer errors.",
      settings: {
        qualityGate: { noGatingScoreErrors: true },
      },
    },
  },
  {
    name: "null clear",
    body: {
      expectedRevisionNumber: 3,
      revisionNote: "Remove the stored quality-gate policy.",
      settings: { qualityGate: null },
    },
  },
];
