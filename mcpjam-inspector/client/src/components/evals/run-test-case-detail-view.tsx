import { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { TestCaseIterationsTable } from "./test-case-iterations-table";
import {
  formatRunCaseLatencyMs,
  groupRunIterationsByTestCase,
} from "./run-case-groups";
import { RunCaseIterationBar } from "./run-case-list-shared";
import type { EvalCase, EvalIteration, EvalSuiteRun } from "./types";

interface RunTestCaseDetailViewProps {
  run: EvalSuiteRun;
  testCase: EvalCase | null;
  iterations: EvalIteration[];
  onBack: () => void;
  serverNames?: string[];
}

function RunCaseSummaryStrip({
  iterations,
  title,
}: {
  iterations: EvalIteration[];
  title: string;
}) {
  const group = useMemo(
    () => groupRunIterationsByTestCase(iterations, "test")[0] ?? null,
    [iterations],
  );

  if (!group) {
    return (
      <div className="rounded-lg border border-border/25 bg-muted/10 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/25 bg-muted/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {title}
        </h2>
        <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums">
          <div className="inline-flex items-center gap-3">
            <RunCaseIterationBar
              results={group.iterationResults}
              passed={group.passed}
              total={group.total}
              className="max-w-[8rem]"
            />
          </div>
          <span className="text-muted-foreground">
            p50 {formatRunCaseLatencyMs(group.p50Ms)}
          </span>
          <span className="text-muted-foreground">
            p95 {formatRunCaseLatencyMs(group.p95Ms)}
          </span>
          {group.failed > 0 ? (
            <span className="font-medium text-destructive">
              {group.failed} failed
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function RunTestCaseDetailView({
  run,
  testCase,
  iterations,
  onBack,
  serverNames = [],
}: RunTestCaseDetailViewProps) {
  const title =
    testCase?.title ?? iterations[0]?.testCaseSnapshot?.title ?? "Test case";

  const tableTestCase: EvalCase =
    testCase ??
    ({
      _id: iterations[0]?.testCaseId ?? "unknown",
      testSuiteId: run.suiteId,
      createdBy: run.createdBy,
      title,
      query: iterations[0]?.testCaseSnapshot?.query ?? "",
      models: [],
      runs: iterations.length,
      expectedToolCalls: [],
    } satisfies Partial<EvalCase> as EvalCase);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-xs"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to run
        </Button>
        <span className="text-xs text-muted-foreground">
          Run #{run.runNumber}
        </span>
      </div>

      <RunCaseSummaryStrip iterations={iterations} title={title} />

      <div className={cn("min-h-0 flex-1")}>
        <TestCaseIterationsTable
          testCase={tableTestCase}
          iterations={iterations}
          serverNames={serverNames}
          label={`All iterations (${iterations.length})`}
          sortMode="failing-first"
        />
      </div>
    </div>
  );
}
