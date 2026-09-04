/** Tag on manually-created suites that represent MCPJam Explore flows for a server */
export const EXPLORE_SUITE_TAG = "explore";

export function isExploreSuite(suite: { tags?: string[] | null }): boolean {
  return suite.tags?.includes(EXPLORE_SUITE_TAG) === true;
}

/** Tag on suites minted by the Excalidraw quickstart on the Evaluate empty state. */
export const QUICKSTART_SUITE_TAG = "quickstart";

export function isQuickstartSuite(suite: { tags?: string[] | null }): boolean {
  return suite.tags?.includes(QUICKSTART_SUITE_TAG) === true;
}

// Run filters
export const RUN_FILTER_ALL = "all";
export const RUN_FILTER_LEGACY = "legacy";

export type RunFilterValue =
  | typeof RUN_FILTER_ALL
  | typeof RUN_FILTER_LEGACY
  | string;

// Default values
export const DEFAULTS = {
  MIN_PASS_RATE: 100,
  RUNS_PER_TEST: 1,
  CHART_HEIGHT: "h-32",
  MAX_QUERY_DISPLAY_LENGTH: 100,
  BATCH_DELETE_CONFIRMATION_DELAY: 0,
} as const;

// View modes
export const VIEW_MODES = {
  OVERVIEW: "overview",
  RUN_DETAIL: "run-detail",
  TEST_DETAIL: "test-detail",
} as const;

export type ViewMode = (typeof VIEW_MODES)[keyof typeof VIEW_MODES];

// Storage keys
export const STORAGE_KEYS = {
  EVAL_RUNNER_PREFERENCES: "mcp-inspector-eval-runner-preferences",
  SUITE_PASS_CRITERIA: (suiteId: string) => `suite-${suiteId}-criteria-rate`,
} as const;

// Result statuses
export const RESULT_STATUS = {
  PASSED: "passed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  PENDING: "pending",
} as const;

export type ResultStatus = (typeof RESULT_STATUS)[keyof typeof RESULT_STATUS];

// Run statuses
export const RUN_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  /**
   * Every trial finished; the run is HELD for its gating judge.
   *
   * Not terminal, and `result` is still `pending` — the backend's
   * `finalizeAfterJudge` is what will decide it, within 30 minutes. Anything
   * that reads this as done reports a run with no verdict as though it had one.
   */
  GRADING: "grading",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/** Pass/fail foreground text — same semantic tokens as charts/icons (`--success` / `--destructive` in index.css). */
export const EVAL_OUTCOME_STATUS_TEXT_CLASS = {
  passed: "text-success",
  failed: "text-destructive",
} as const;

/** Foreground text color for low pass rates, negative deltas, and fail counts in dense eval UI. */
export const EVAL_LOW_PASS_RATE_TEXT_CLASS = "text-destructive";

/**
 * Filled delete/destructive actions — pastel surface `/50`, neutral text.
 *
 * `hover:bg-destructive/50` is an explicit override: without it, the design-system
 * `Button` default variant's `hover:bg-primary/90` wins under twMerge and the
 * button would flash brand-orange on hover. Pinning hover-bg to the same `/50`
 * destructive token lets `hover:brightness-95` do the affordance work.
 */
export const EVAL_DESTRUCTIVE_BUTTON_CLASS =
  "border-transparent bg-destructive/50 text-foreground shadow-xs hover:bg-destructive/50 hover:brightness-95 focus-visible:ring-destructive/35";

/** Pastel fail fill for stacked iteration bars. */
export const EVAL_FAIL_BAR_CLASS = "bg-destructive/50";

/** Compact failed-outcome badges — pastel surface `/50`, neutral foreground. */
export const EVAL_FAILED_BADGE_CLASS =
  "bg-destructive/50 text-foreground";

/**
 * High-contrast pass/fail badges for spots where a failure must be
 * impossible to miss at a glance (e.g. the per-check gate in
 * predicates-list.tsx). Deliberately NOT `EVAL_FAILED_BADGE_CLASS`'s
 * pastel-surface + neutral-text pattern: at `/50` opacity `--success` and
 * `--destructive` land within ~0.03 OKLCH lightness of each other, so a
 * "1 failed" chip and an "N/N passed" chip read as near-identical washed-out
 * pastel — worse still for red/green color-vision deficiency, where hue is
 * the only differentiator left once lightness converges. Text color itself
 * carries the hue here, mirroring the checks badge already used in
 * iteration-row.tsx.
 */
export const EVAL_PASSED_BADGE_STRONG_CLASS =
  "bg-green-500/15 text-green-700 dark:text-green-300";
export const EVAL_FAILED_BADGE_STRONG_CLASS =
  "bg-red-500/15 text-red-700 dark:text-red-300";

// UI configuration
export const UI_CONFIG = {
  MAX_TITLE_LENGTH: 100,
  MAX_DESCRIPTION_LENGTH: 500,
  DEBOUNCE_DELAY: 300,
  ANIMATION_DURATION: 200,
  SIDEBAR_WIDTH: "w-64",
  CHART_COLORS: {
    PASS_RATE: "var(--chart-1)",
    PASSED: "var(--color-success)",
    FAILED: "var(--color-destructive)",
    PENDING: "var(--color-warning)",
    CANCELLED: "var(--color-muted-foreground)",
    TIMED_OUT: "var(--color-warning)",
  },
} as const;

// Border colors for iteration results
export const BORDER_COLORS = {
  [RESULT_STATUS.PASSED]: "bg-success/50",
  [RESULT_STATUS.FAILED]: "bg-destructive/50",
  [RESULT_STATUS.CANCELLED]: "bg-muted",
  [RESULT_STATUS.PENDING]: "bg-warning/50",
} as const;

// Status dot colors — pastel `/50` surfaces per the sweep. If a 6px dot
// loses legibility against `bg-muted` neighbours, follow up in PR-2 with
// either a full-token fallback or `ring-1 ring-<token>/60`.
export const STATUS_DOT_COLORS = {
  [RESULT_STATUS.PASSED]: "bg-success/50",
  [RESULT_STATUS.FAILED]: "bg-destructive/50",
  [RESULT_STATUS.CANCELLED]: "bg-muted-foreground/50",
  [RESULT_STATUS.PENDING]: "bg-warning/50",
  RUNNING: "bg-warning/50",
  DEFAULT: "bg-muted-foreground/50",
} as const;

// Wizard steps
export const WIZARD_STEPS = [
  {
    key: "servers",
    title: "Select Servers",
    description: "Choose the MCP servers to evaluate.",
  },
  {
    key: "model",
    title: "Choose Model",
    description: "Pick the model and ensure credentials are ready.",
  },
  {
    key: "tests",
    title: "Define Tests",
    description:
      "Author the scenarios you want to run or generate them with AI.",
  },
  {
    key: "review",
    title: "Review & Run",
    description: "Confirm the configuration before launching the run.",
  },
] as const;

export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];

// API endpoints
export const API_ENDPOINTS = {
  EVALS_RUN: "/api/mcp/evals/run",
  EVALS_GENERATE_TESTS: "/api/mcp/evals/generate-tests",
  EVALS_GENERATE_NEGATIVE_TESTS: "/api/mcp/evals/generate-negative-tests",
  EVALS_RUN_TEST_CASE: "/api/mcp/evals/run-test-case",
  LIST_TOOLS: "/api/mcp/list-tools",
} as const;

// Query limits
export const QUERY_LIMITS = {
  SUITE_RUNS: 20,
  ITERATIONS: 100,
} as const;

// Timeouts
export const TIMEOUTS = {
  TOAST_DURATION: 3000,
  API_REQUEST: 30000,
  DEBOUNCE: 300,
} as const;
