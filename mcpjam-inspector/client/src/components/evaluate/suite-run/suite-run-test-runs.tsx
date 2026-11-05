/**
 * The Suite run page's Test runs list (C10): one row per case in this run.
 * A row opens its Test run page; the pencil opens the case editor from that
 * test run (D13), so its breadcrumb and Back lead back here.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, Pencil } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { groupRunIterationsByTestCase } from "../../evals/run-case-groups";
import type { EvalIteration } from "../../evals/types";
import {
  buildEvaluateCaseRows,
  type BuildCaseRowsInput,
  type EvaluateCaseRow,
} from "../evaluate-case-row-model";
import { RunCaseRows } from "../run-case-rows";
import { trackEvalNav } from "../nav/evaluate-nav-events";
import { useEvaluateNavNavigate } from "../nav/use-evaluate-nav-navigate";
import {
  EvalListFilter,
  ALL_EVAL_FILTER_VALUES,
} from "../../evals/eval-list-filter";

export interface TestRunLinkTarget {
  suiteId: string;
  runId: string;
  /** Model target to open on, when the page is filtered to one. */
  target?: string;
}

/** Where a row leads: its test run, or the case editor from that test run. */
function useTestRunLinks(link: TestRunLinkTarget) {
  const navigate = useEvaluateNavNavigate();
  return {
    open: (caseId: string) =>
      navigate(
        {
          type: "test-run",
          suiteId: link.suiteId,
          runId: link.runId,
          caseId,
          ...(link.target ? { target: link.target } : {}),
        },
        "link",
      ),
    edit: (caseId: string) => {
      trackEvalNav("eval_edit_from_test_run", { surface: "list" });
      navigate(
        {
          type: "test-run-edit",
          suiteId: link.suiteId,
          runId: link.runId,
          caseId,
        },
        "link",
      );
    },
  };
}

export function SuiteRunTestRuns({
  link,
  iterations,
  decision,
  toolbar,
}: {
  link: TestRunLinkTarget;
  /** This run's iterations, already narrowed by the page's model filter. */
  iterations: readonly EvalIteration[];
  decision: Omit<BuildCaseRowsInput, "groups">;
  toolbar?: ReactNode;
}) {
  const { summary, diagnostics, chains, chainsLoaded, decisionStatus } =
    decision;
  const links = useTestRunLinks(link);
  const rows = useMemo(
    () =>
      buildEvaluateCaseRows({
        summary,
        diagnostics,
        chains,
        chainsLoaded,
        decisionStatus,
        groups: groupRunIterationsByTestCase([...iterations], "test"),
      }),
    [iterations, summary, diagnostics, chains, chainsLoaded, decisionStatus],
  );
  return (
    <section data-testid="suite-run-test-runs">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <h3 className="text-sm font-semibold text-foreground">
          Test runs{" "}
          <span className="font-normal tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        </h3>
        {toolbar}
      </div>
      <RunCaseRows
        rows={rows}
        defaultOpenKey={null}
        onOpenRow={(row) => {
          if (row.testCaseId) links.open(row.testCaseId);
        }}
        renderActions={(row) => <TestRunActions links={links} row={row} />}
      />
    </section>
  );
}

function TestRunActions({
  links,
  row,
}: {
  links: ReturnType<typeof useTestRunLinks>;
  row: EvaluateCaseRow;
}) {
  const caseId = row.testCaseId;
  if (!caseId) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8"
        aria-label={`Open test run: ${row.title}`}
        data-testid={`test-run-open-${caseId}`}
        onClick={() => links.open(caseId)}
      >
        <ArrowUpRight className="size-3.5" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8"
        aria-label={`Edit test case: ${row.title}`}
        data-testid={`test-run-edit-${caseId}`}
        onClick={() => links.edit(caseId)}
      >
        <Pencil className="size-3.5" aria-hidden />
      </Button>
    </>
  );
}

/** Models a single run's iterations used, for the page's model filter. */
export function iterationModels(
  iterations: readonly EvalIteration[],
): string[] {
  const models = iterations.flatMap((iteration) =>
    iteration.testCaseSnapshot?.model ? [iteration.testCaseSnapshot.model] : [],
  );
  return [...new Set(models)].sort();
}

/**
 * A single run's Test runs list with its model filter. A run normally used
 * one model, so the filter shows only when its iterations name several.
 */
export function SingleRunTestRuns({
  run,
  iterations,
  decision,
}: {
  run: { _id: string; suiteId: string };
  iterations: readonly EvalIteration[];
  decision: Omit<BuildCaseRowsInput, "groups">;
}) {
  const [model, setModel] = useState(ALL_EVAL_FILTER_VALUES);
  const models = useMemo(() => iterationModels(iterations), [iterations]);
  const selected = models.includes(model) ? model : ALL_EVAL_FILTER_VALUES;
  const shown = useMemo(
    () =>
      selected === ALL_EVAL_FILTER_VALUES
        ? iterations
        : iterations.filter(
            (iteration) => iteration.testCaseSnapshot?.model === selected,
          ),
    [iterations, selected],
  );
  return (
    <SuiteRunTestRuns
      link={{ suiteId: run.suiteId, runId: run._id }}
      iterations={shown}
      decision={decision}
      toolbar={
        models.length > 1 ? (
          <EvalListFilter
            label="Model"
            className="w-40"
            value={selected}
            options={models}
            onChange={setModel}
          />
        ) : null
      }
    />
  );
}
