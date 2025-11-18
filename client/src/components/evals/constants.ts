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
  PENDING: "pending",
} as const;

export type ResultStatus = (typeof RESULT_STATUS)[keyof typeof RESULT_STATUS];

// Run statuses
export const RUN_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

// UI configuration
export const UI_CONFIG = {
  MAX_TITLE_LENGTH: 100,
  MAX_DESCRIPTION_LENGTH: 500,
  DEBOUNCE_DELAY: 300,
  ANIMATION_DURATION: 200,
  SIDEBAR_WIDTH: "w-64",
  CHART_COLORS: {
    PASS_RATE: "var(--chart-1)",
    PASSED: "hsl(142.1 76.2% 36.3%)",
    FAILED: "hsl(0 84.2% 60.2%)",
    PENDING: "hsl(45.4 93.4% 47.5%)",
    CANCELLED: "hsl(240 3.7% 15.9%)",
  },
} as const;

// Border colors for iteration results
export const BORDER_COLORS = {
  [RESULT_STATUS.PASSED]: "bg-emerald-500/50",
  [RESULT_STATUS.FAILED]: "bg-red-500/50",
  [RESULT_STATUS.CANCELLED]: "bg-zinc-300/50",
  [RESULT_STATUS.PENDING]: "bg-amber-500/50",
} as const;

// Status dot colors
export const STATUS_DOT_COLORS = {
  [RESULT_STATUS.PASSED]: "bg-emerald-500",
  [RESULT_STATUS.FAILED]: "bg-red-500",
  [RESULT_STATUS.CANCELLED]: "bg-gray-400",
  [RESULT_STATUS.PENDING]: "bg-amber-400",
  RUNNING: "bg-amber-400",
  DEFAULT: "bg-gray-400",
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
