export type SuiteOverviewView =
  | "runs"
  | "test-cases"
  | "executions"
  | "cross-host";

/**
 * Unified eval routes for both Evaluate modes: Suites (`/evals`) and Runs
 * (`/evals/runs`). Runs-only shapes (`commit-detail`, `fromCommit`) are
 * omitted from Suites URLs at runtime.
 */

export type EvalRoute =
  | { type: "list" }
  | { type: "create" }
  /** Frontend-first preview of suites we'd generate from a connected server. */
  | { type: "eval-server"; serverId: string }
  | {
      type: "suite-overview";
      suiteId: string;
      view?: SuiteOverviewView;
      /** CI: commit sidebar when drilling from Group by commit */
      fromCommit?: string;
      /**
       * Open the import review on one authoring job's drafts.
       *
       * How an API import hands its unfinished cases back to a person: the
       * reply's `reviewUrl` carries this, and the drafts are read from the
       * job rather than from whatever this browser happens to remember.
       */
      importJob?: string;
    }
  | {
      type: "run-detail";
      suiteId: string;
      runId: string;
      iteration?: string;
      /** Drill into a test case's iterations within this run. */
      testCaseId?: string;
      insightsFocus?: boolean;
      compareToRunId?: string;
      comparison?: boolean;
    }
  | { type: "test-detail"; suiteId: string; testId: string; iteration?: string }
  | {
      type: "test-edit";
      suiteId: string;
      testId: string;
      /** Deep-link: open compare run surface (same as View results) when iterations exist. */
      openCompare?: boolean;
      checks?: boolean;
      /** Deep-link: prefer the clicked iteration/session when hydrating compare results. */
      iteration?: string;
      /** Return to the Eval my server first-run preview after editing. */
      fromEvalServer?: string;
    }
  | { type: "suite-edit"; suiteId: string; fromCaseChecks?: string }
  | {
      type: "commit-detail";
      commitSha: string;
      suite?: string;
      iteration?: string;
    }
  | EvalNavRoute;

/** The three tabs of Suite settings, each its own address. */
export type SuiteSettingsRouteTab = "settings" | "cases" | "evaluators";

/**
 * Evaluate's page-per-layer routes, parsed under `/evaluate` only. Settings
 * live under `suite/:suite/settings`; a run's layers nest under
 * `suite/:suite/runs/:run/cases/:case`.
 */
export type EvalNavRoute =
  | { type: "evaluate-runs" }
  | { type: "suite-settings"; suiteId: string; tab: SuiteSettingsRouteTab }
  | { type: "case-new"; suiteId: string }
  | { type: "case-settings"; suiteId: string; testCaseId: string }
  | { type: "case-evaluators"; suiteId: string; testCaseId: string }
  | {
      type: "test-run";
      suiteId: string;
      runId: string;
      testCaseId: string;
      /** The model whose iterations the page shows, when the run used several. */
      target?: string;
    }
  | {
      type: "iteration";
      suiteId: string;
      runId: string;
      testCaseId: string;
      iterationId: string;
    }
  /** The case editor opened from a test run, so its trail leads back there. */
  | {
      type: "test-run-edit";
      suiteId: string;
      runId: string;
      testCaseId: string;
    };

export type EvalNavRouteKind = EvalNavRoute["type"];
