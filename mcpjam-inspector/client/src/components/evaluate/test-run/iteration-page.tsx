import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type { EvaluateNavRoute } from "@/lib/eval-route-types";
import { formatRelativeTime } from "../../evals/helpers";
import { computeIterationResult } from "../../evals/pass-criteria";
import { EvaluateNavCrumbBar } from "../nav/evaluate-nav-crumb-bar";
import { useEvaluateNavNavigate } from "../nav/use-evaluate-nav-navigate";
import { IterationEvidence } from "./iteration-evidence";
import { outcomeLabel, outcomeTextTone } from "./iteration-outcome";
import { useTestRunData } from "./use-test-run-data";

type IterationRoute = Extract<EvaluateNavRoute, { type: "iteration" }>;

/** One iteration as a page (C12): full-height evidence and Back to test run. */
export function IterationPage({ route }: { route: IterationRoute }) {
  const { suiteId, runId, caseId, iterationId } = route;
  const navigate = useEvaluateNavNavigate();
  const data = useTestRunData(route);
  const target = data.targets.find((item) =>
    (item.cells.get(caseId) ?? []).some((entry) => entry._id === iterationId),
  );
  const iteration = data.iterations.find((item) => item._id === iterationId);
  const iterationNumber =
    iteration?.iterationNumber ??
    (target
      ? (target.cells.get(caseId) ?? []).findIndex(
          (item) => item._id === iterationId,
        ) + 1
      : undefined);
  // Back keeps the model this iteration ran on picked on the test run.
  const testRunRoute = {
    type: "test-run",
    suiteId,
    runId,
    caseId,
    ...(target && data.targets.length > 1 ? { target: target.targetKey } : {}),
  } as const;
  const result = iteration ? computeIterationResult(iteration) : null;
  const chain = data.diagnostics.find(
    (item) => item.iterationId === iterationId,
  )?.chain;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="iteration-page">
      <EvaluateNavCrumbBar
        route={route}
        names={{
          suiteName: data.suite?.name,
          caseName: data.caseTitle,
          runNumber: data.run?.runNumber,
          iterationNumber,
        }}
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(testRunRoute, "back")}
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Back to test run
        </Button>
        {iteration && target && result && (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
            <h1 className="font-semibold">Iteration #{iterationNumber}</h1>
            <span className={cn("font-medium", outcomeTextTone(result))}>
              {outcomeLabel(result)}
            </span>
            <span className="truncate text-muted-foreground">
              {target.client} · {target.model} ·{" "}
              {formatRelativeTime(
                iteration.createdAt ??
                  iteration.startedAt ??
                  iteration.updatedAt,
              )}
            </span>
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {data.isLoading || data.isRunLoading ? (
          <div className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading the iteration…
          </div>
        ) : !iteration || !target || !data.run ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">
            This iteration is not part of this test run. Go back to the test run
            to pick another one.
          </p>
        ) : (
          <IterationEvidence
            iteration={iteration}
            listRun={target.run}
            run={data.run}
            chain={chain}
          />
        )}
      </div>
    </div>
  );
}
