export type SuiteOverviewView = "runs" | "test-cases" | "executions";

/**
 * Unified eval hash routes for Playground (`#/evals`) and CI/CD (`#/ci-evals`).
 * CI-only shapes (`commit-detail`, `fromCommit`) are omitted from Playground URLs at runtime.
 */

export type EvalRoute =
  | { type: "list" }
  | { type: "create" }
  | {
      type: "suite-overview";
      suiteId: string;
      view?: SuiteOverviewView;
      /** CI: commit sidebar when drilling from Group by commit */
      fromCommit?: string;
    }
  | {
      type: "run-detail";
      suiteId: string;
      runId: string;
      iteration?: string;
      insightsFocus?: boolean;
    }
  | { type: "test-detail"; suiteId: string; testId: string; iteration?: string }
  | {
      type: "test-edit";
      suiteId: string;
      testId: string;
      /** Deep-link: open compare run surface (same as View results) when iterations exist. */
      openCompare?: boolean;
      /** Deep-link: prefer the clicked iteration/session when hydrating compare results. */
      iteration?: string;
    }
  | { type: "suite-edit"; suiteId: string }
  | {
      type: "commit-detail";
      commitSha: string;
      suite?: string;
      iteration?: string;
    };
