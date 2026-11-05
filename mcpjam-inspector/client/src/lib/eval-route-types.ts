export type SuiteOverviewView =
  | "runs"
  | "test-cases"
  | "executions"
  | "cross-host";

/** Suite settings tabs, each with its own address (`…/settings[/cases|/evaluators]`). */
export type SuiteSettingsTab = "settings" | "cases" | "evaluators";

/**
 * Route kinds of the Evaluate navigation rework, `/evaluate` only. Every
 * level of a run and of a suite's settings is a path, so the breadcrumb can
 * be built from the route alone.
 */
export type EvaluateNavRoute =
  | { type: "evaluate-runs" }
  | { type: "suite-settings"; suiteId: string; tab: SuiteSettingsTab }
  | { type: "case-new"; suiteId: string }
  | { type: "case-settings"; suiteId: string; caseId: string }
  | { type: "case-evaluators"; suiteId: string; caseId: string }
  | {
      type: "test-run";
      suiteId: string;
      runId: string;
      caseId: string;
      /** Model target picked on a run that used several (`?target=`). */
      target?: string;
    }
  /** The case editor opened from a test run, so Back returns to it (D13). */
  | { type: "test-run-edit"; suiteId: string; runId: string; caseId: string }
  | {
      type: "iteration";
      suiteId: string;
      runId: string;
      caseId: string;
      iterationId: string;
    };

export type EvaluateNavRouteType = EvaluateNavRoute["type"];

/**
 * Unified eval routes for both Evaluate modes: Suites (`/evals`) and Runs
 * (`/evals/runs`). Runs-only shapes (`commit-detail`, `fromCommit`) are
 * omitted from Suites URLs at runtime.
 */

export type EvalRoute =
  | EvaluateNavRoute
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
    };
