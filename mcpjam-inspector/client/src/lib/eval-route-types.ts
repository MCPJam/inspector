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

/** Suite settings tab, from the segment after /settings (none = "settings"). */
export type SuiteSettingsTab = "settings" | "cases" | "evaluators";

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
  /** /evaluate/runs — the Evaluate landing's Runs tab. */
  | { type: "evaluate-runs" }
  /** …/suite/:suiteId/settings[/cases|/evaluators] */
  | {
      type: "suite-settings";
      suiteId: string;
      tab: SuiteSettingsTab;
      /** An import job whose drafts the Test cases tab opens on (?importJob=). */
      importJob?: string;
    }
  /** …/suite/:suiteId/settings/cases/new */
  | { type: "case-new"; suiteId: string }
  /** …/suite/:suiteId/settings/cases/:testCaseId */
  | { type: "case-settings"; suiteId: string; testCaseId: string }
  /** …/suite/:suiteId/settings/cases/:testCaseId/evaluators */
  | { type: "case-evaluators"; suiteId: string; testCaseId: string }
  /** …/suite/:suiteId/runs/:runId/cases/:testCaseId[?target=] */
  | {
      type: "test-run";
      suiteId: string;
      runId: string;
      testCaseId: string;
      /** The model shown when the run used several. Omitted when absent. */
      target?: string;
    }
  /** …/runs/:runId/cases/:testCaseId/iter/:iterationId */
  | {
      type: "iteration";
      suiteId: string;
      runId: string;
      testCaseId: string;
      iterationId: string;
    }
  /** …/runs/:runId/cases/:testCaseId/edit — a test case opened from a test run. */
  | {
      type: "test-run-edit";
      suiteId: string;
      runId: string;
      testCaseId: string;
    };

/** The kinds that give each eval layer its own page. Only /evaluate parses them. */
export type EvalNavRouteType =
  | "evaluate-runs"
  | "suite-settings"
  | "case-new"
  | "case-settings"
  | "case-evaluators"
  | "test-run"
  | "iteration"
  | "test-run-edit";
export type EvalNavRoute = Extract<EvalRoute, { type: EvalNavRouteType }>;
/** Every kind the pre-navigation pages render. */
export type LegacyEvalRoute = Exclude<EvalRoute, EvalNavRoute>;
