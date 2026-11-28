import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useQuery } from "convex/react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  CODE_EVALUATOR_TEST_FAILED_COPY,
  CodeEvaluatorTestError,
  testCodeEvaluator,
  type CodeEvaluatorTestResult,
} from "@/lib/apis/code-evaluator-test-api";
import { CodeEvaluatorLogs } from "../code-grading/code-evaluator-logs";
import {
  testableProblem,
  type CodeEvaluatorDraft,
} from "./code-evaluator-model";
import { listPastIterationsRef, pastIterationLabel } from "./past-iterations";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

/** Where a test runs: the suite, and the grading network its draft sets. */
export type CodeEvaluatorTestTarget = {
  projectId: string;
  suiteId: string;
  network: "none" | "web";
};

type TestRun =
  | { status: "running"; input: string }
  | { status: "done"; input: string; result: CodeEvaluatorTestResult }
  | { status: "failed"; input: string; message: string };

function verdictOf(result: CodeEvaluatorTestResult["result"]): VerdictStatus {
  if (result.status === "error") return "error";
  return result.passed ? "passed" : "failed";
}

/**
 * "Test on a past iteration" for a code evaluator draft: the tray docked
 * under the editor's form. The draft runs once, in a fresh box, against a
 * stored iteration of one of the suite's finished runs; nothing is saved.
 * After an edit the last result stays, marked out of date, so its logs stay
 * readable while the script is fixed.
 */
export function CodeEvaluatorTestPanel({
  target,
  draft,
  evaluatorId,
}: {
  target: CodeEvaluatorTestTarget;
  draft: CodeEvaluatorDraft;
  /** A saved evaluator's ID; a new one has none yet. */
  evaluatorId?: string;
}) {
  const iterations = useQuery(listPastIterationsRef, {
    suiteId: target.suiteId,
  });
  const [open, setOpen] = useState(false);
  const [iterationId, setIterationId] = useState("");
  const [run, setRun] = useState<TestRun | null>(null);
  const chosen =
    iterations?.find((row) => row.iterationId === iterationId)?.iterationId ??
    iterations?.[0]?.iterationId ??
    "";
  const evaluator = {
    fileName: draft.fileName.trim(),
    script: draft.script,
    threshold: draft.threshold,
    ...(evaluatorId ? { id: evaluatorId } : {}),
  };
  const input = JSON.stringify({
    iterationId: chosen,
    evaluator,
    network: target.network,
  });
  const problem = testableProblem(draft);
  const running = run?.status === "running";
  const stale = run !== null && !running && run.input !== input;
  const verdict =
    run?.status === "running"
      ? "running"
      : run?.status === "done"
        ? verdictOf(run.result.result)
        : undefined;

  const start = async () => {
    setRun({ status: "running", input });
    try {
      const result = await testCodeEvaluator({
        projectId: target.projectId,
        suiteId: target.suiteId,
        iterationId: chosen,
        evaluator,
        network: target.network,
      });
      setRun({ status: "done", input, result });
    } catch (error) {
      setRun({
        status: "failed",
        input,
        message:
          error instanceof CodeEvaluatorTestError
            ? error.message
            : CODE_EVALUATOR_TEST_FAILED_COPY,
      });
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
        <h3 className="text-sm font-medium">
          <CollapsibleTrigger className="flex items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground",
                open && "rotate-90",
              )}
            />
            Test on a past iteration
          </CollapsibleTrigger>
        </h3>
        {verdict ? (
          <span className={cn("shrink-0", stale && "opacity-60")}>
            <VerdictPill status={verdict} size="sm" />
            {stale ? (
              <span className="sr-only"> from an earlier draft</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <CollapsibleContent className="max-h-[40dvh] overflow-y-auto px-4 pb-4 sm:px-5">
        {iterations?.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Run this suite once to test an evaluator on a past iteration.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <Select value={chosen} onValueChange={setIterationId}>
                <SelectTrigger
                  aria-label="Past iteration"
                  className="h-9 w-full text-xs"
                >
                  <SelectValue placeholder="Loading iterations…" />
                </SelectTrigger>
                <SelectContent>
                  {(iterations ?? []).map((row, index) => (
                    <SelectItem
                      key={row.iterationId}
                      value={row.iterationId}
                      title={row.iterationId}
                    >
                      {pastIterationLabel(row, index)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!chosen || running || Boolean(problem)}
                  onClick={start}
                >
                  {running ? (
                    <>
                      <LoaderCircle aria-hidden className="animate-spin" />
                      Testing…
                    </>
                  ) : (
                    "Run test"
                  )}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Saves nothing.
                </span>
              </div>
              {problem ? (
                <p className="text-xs text-muted-foreground">{problem}</p>
              ) : null}
            </div>
            <div aria-live="polite" className="min-w-0">
              <TestOutcome run={run} stale={stale} />
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TestOutcome({ run, stale }: { run: TestRun | null; stale: boolean }) {
  if (!run) {
    return (
      <p className="text-xs text-muted-foreground">
        Runs this draft on the iteration you pick, in a fresh box. It can take
        up to two minutes.
      </p>
    );
  }
  if (run.status === "running") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        Running the test. It can take up to two minutes.
      </p>
    );
  }
  if (run.status === "failed") {
    return (
      <p
        role="alert"
        className="rounded-md border border-border bg-background p-3 text-xs text-foreground"
      >
        {run.message}
      </p>
    );
  }
  const { result } = run;
  const outcome = result.result;
  return (
    <div className="space-y-1.5">
      {stale ? (
        <p className="text-xs text-muted-foreground">
          From an earlier draft. Run the test again.
        </p>
      ) : null}
      <div
        data-testid="code-evaluator-test-result"
        className={cn(
          "flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-background p-3 text-xs",
          stale && "opacity-60",
        )}
      >
        <div className="flex items-center gap-2">
          <VerdictPill status={verdictOf(outcome)} />
          {outcome.status === "scored" ? (
            <span className="font-code [font-variant-ligatures:none]">
              {outcome.score.toFixed(2)} / {outcome.threshold.toFixed(2)}
            </span>
          ) : null}
        </div>
        {outcome.status === "scored" ? (
          outcome.reason ? (
            <p className="text-foreground">{outcome.reason}</p>
          ) : null
        ) : (
          <>
            <p className="text-foreground">{outcome.error}</p>
            <p className="text-muted-foreground">Not counted as a failure.</p>
          </>
        )}
        {result.input === "transcript" ? (
          <p className="text-muted-foreground">
            This iteration has no stored files, so the evaluator saw the
            transcript only.
          </p>
        ) : null}
        <CodeEvaluatorLogs
          output={result.logs.output}
          defaultOpen={outcome.status === "error"}
        />
      </div>
    </div>
  );
}
