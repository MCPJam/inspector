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

/** One settings row: what it is called, and how an agent reaches it. */
export type EvalSuiteSettingRow = {
  /** Stable identifier, stamped as `data-setting-key` on the rendered row. */
  key: string;
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
    label: "Minimum accuracy",
    api: "settings.minimumAccuracy",
  },
  {
    key: "minimumIterations",
    label: "Minimum iterations",
    api: "settings.minimumIterations",
  },
  {
    key: "computerEnvironment",
    label: "Computer environment",
    api: "environment.computerEnvironment",
  },
  {
    key: "environments",
    label: "Environments",
    api: "environmentIds",
  },
  {
    key: "toolCalls",
    label: "Tool calls",
    api: "settings.matchOptions",
  },
  {
    key: "defaultChecks",
    label: "Default checks",
    api: "settings.checks",
  },
  {
    key: "schedule",
    label: "Schedule",
    // Its own route (`PATCH …/eval-suites/{id}/schedule`) because enabling a
    // schedule has to reject a multi-environment suite that names no
    // environment — a validation the suite PATCH would have to grow a
    // cross-field rule for.
    op: "set_eval_suite_schedule",
  },
  {
    key: "githubChecks",
    label: "GitHub Checks",
    // ORG-scoped, not suite-scoped: connecting a repository configures the
    // organization's GitHub App installation, and the suite only decides which
    // suite that repository answers for. So it has its own route family and its
    // own operations rather than a field on `update_eval_suite`. The op named
    // here is the WRITE this row performs; `list_eval_check_repos` is its read.
    op: "connect_eval_check_repo",
  },
  {
    key: "llmAsJudge",
    label: "LLM as Judge",
    api: "settings.judge",
  },
  {
    key: "deleteSuite",
    label: "Delete suite",
    op: "delete_eval_suite",
  },
] as const satisfies readonly EvalSuiteSettingRow[];

/** The key of every declared settings row. */
export type EvalSuiteSettingKey =
  (typeof EVAL_SUITE_SETTINGS_MANIFEST)[number]["key"];

export const EVAL_SUITE_SETTING_KEYS: readonly EvalSuiteSettingKey[] =
  EVAL_SUITE_SETTINGS_MANIFEST.map((row) => row.key);
