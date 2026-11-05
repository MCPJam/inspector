import { useMemo } from "react";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { buildRunResultsMatrix } from "../run-results-matrix-model";
import { RunTestRunRows } from "../run-case-rows";
import { trackEvalNav } from "../nav/eval-nav-events";
import { openEvalNavPage } from "../nav/eval-nav-link";

const NO_HOST_NAMES: ReadonlyMap<string, string | null> = new Map();

/** "run #4": how Back on the Test run page names this page. */
export function suiteRunLabel(run: EvalSuiteRunListItem): string {
  return run.runNumber ? `run #${run.runNumber}` : "run";
}

/**
 * The Suite run page's Test runs list, wired to the Test run page and to the
 * case editor opened from a test run (D13).
 */
export function SuiteRunTestRuns({
  run,
  runs,
  iterations,
  hostNamesById = NO_HOST_NAMES,
  targetKeys,
  canEdit,
}: {
  /** The run the page is addressed by; its launch siblings join it. */
  run: EvalSuiteRun;
  runs: readonly EvalSuiteRunListItem[];
  iterations: readonly EvalIteration[];
  hostNamesById?: ReadonlyMap<string, string | null>;
  /** The page's model filter: only these targets' columns. Absent shows all. */
  targetKeys?: ReadonlySet<string>;
  canEdit: boolean;
}) {
  const data = useMemo(() => {
    const matrix = buildRunResultsMatrix<EvalSuiteRunListItem>({
      run,
      runs,
      iterations,
      hostNamesById,
    });
    if (!targetKeys) return matrix;
    const targets = matrix.targets.filter((target) =>
      targetKeys.has(target.key),
    );
    const ran = (key: string) =>
      targets.some((target) => (target.cells.get(key)?.length ?? 0) > 0);
    // A queued run has no cells yet; keep its case list rather than empty it.
    const rows = matrix.rows.some((row) => ran(row.key))
      ? matrix.rows.filter((row) => ran(row.key))
      : matrix.rows;
    return { targets, rows };
  }, [run, runs, iterations, hostNamesById, targetKeys]);
  const from = suiteRunLabel(run);
  return (
    <RunTestRunRows
      data={data}
      onOpen={({ testCaseId }) =>
        openEvalNavPage(
          {
            type: "test-run",
            suiteId: run.suiteId,
            runId: run._id,
            testCaseId,
          },
          from,
        )
      }
      {...(canEdit
        ? {
            onEdit: ({ testCaseId }: { testCaseId: string }) => {
              trackEvalNav("eval_edit_from_test_run", { surface: "list" });
              openEvalNavPage(
                {
                  type: "test-run-edit",
                  suiteId: run.suiteId,
                  runId: run._id,
                  testCaseId,
                },
                from,
              );
            },
          }
        : {})}
    />
  );
}
