import type { ReactNode } from "react";
import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import { useSelectedRun } from "../evals/use-selected-run";
import {
  average,
  compactMetric,
  formatRelativeTime,
  formatRunId,
  iterationLatencyP50,
  iterationLatencyP95,
  runClientIdentity,
} from "../evals/helpers";
import { formatRunCaseLatencyMs } from "../evals/run-case-groups";
import { computeIterationResult } from "../evals/pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import { EvalInspectBody, EvalInspectHeader } from "./eval-inspect-sheet";
import {
  resultCounts,
  type RunResultsMatrixData,
} from "./run-results-matrix-model";
import { IterationDetails } from "../evals/iteration-details";
import { IterationReportScorecard } from "./case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "./case-scorecard/trial-authored";
import { CaseJudgeAnswer } from "./case-scorecard/case-judge-answer";
import { resolveIterationJudge } from "../evals/goal-completion-presentation";

const outcomeLabel = (result: string) =>
  ({
    passed: "Passed",
    failed: "Failed",
    pending: "In progress",
    cancelled: "Cancelled",
    timed_out: "Timed out",
  })[result] ?? "Unknown";
export const outcomeTextTone = (result: string) =>
  result === "passed"
    ? "text-success"
    : result === "failed" || result === "timed_out"
      ? "text-destructive"
      : result === "pending"
        ? "text-pending"
        : "text-muted-foreground";

const outcomeDotTone = (result: string) =>
  result === "passed"
    ? "bg-success"
    : result === "failed" || result === "timed_out"
      ? "bg-destructive"
      : result === "pending"
        ? "bg-pending"
        : "bg-muted-foreground";

export function CaseIterations({
  target,
  caseKey,
  onSelectIteration,
}: {
  target: RunResultsMatrixData["targets"][number];
  caseKey: string;
  onSelectIteration: (iterationId: string) => void;
}) {
  const items = target.cells.get(caseKey) ?? [];
  if (!items.length) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No recorded iterations for this case on this client and model.
      </p>
    );
  }
  const counts = resultCounts(items);
  const tokenAverage = average(
    items.flatMap((item) =>
      typeof item.tokensUsed === "number" ? [item.tokensUsed] : [],
    ),
  );
  const callAverage = average(
    items.flatMap((item) =>
      item.actualToolCalls ? [item.actualToolCalls.length] : [],
    ),
  );
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rank = (item: EvalIteration) =>
        ["failed", "timed_out"].includes(computeIterationResult(item))
          ? 0
          : computeIterationResult(item) === "pending"
            ? 1
            : 2;
      return rank(a.item) - rank(b.item) || a.index - b.index;
    });
  const passTone = counts.pending
    ? "text-pending"
    : counts.passed === items.length
      ? "text-success"
      : counts.cancelled === items.length
        ? "text-muted-foreground"
        : "text-destructive";
  const metricLabel =
    "text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-muted-foreground";
  return (
    <>
      <div className="mb-4 flex w-full rounded-xl border border-border px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={metricLabel}>Passed</span>
          <span
            className={cn(
              "text-[28px] font-bold leading-8 tracking-[-0.03em] tabular-nums",
              passTone,
            )}
          >
            {counts.passed}/{items.length}
          </span>
        </div>
        <DrawerAverage label="P50">
          {formatRunCaseLatencyMs(iterationLatencyP50(items))}
        </DrawerAverage>
        <DrawerAverage label="P95">
          {formatRunCaseLatencyMs(iterationLatencyP95(items))}
        </DrawerAverage>
        <DrawerAverage label="Tokens">
          {tokenAverage === null ? "—" : compactMetric(tokenAverage)}
        </DrawerAverage>
        <DrawerAverage label="Calls">
          {callAverage === null ? "—" : compactMetric(callAverage)}
        </DrawerAverage>
      </div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Iterations
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-[760px]">
          <div
            className="grid grid-cols-[minmax(130px,1fr)_minmax(180px,1fr)_120px_120px_110px_70px] items-center gap-2 bg-muted px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
            aria-hidden="true"
          >
            <span>Iteration</span>
            <span>Client / Model</span>
            <span>Result</span>
            <span>Latency</span>
            <span>Tokens</span>
            <span>Calls</span>
          </div>
          {sorted.map(({ item, index }) => {
            const result = computeIterationResult(item);
            const row = (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      outcomeDotTone(result),
                    )}
                  />
                  <span className="text-[13px] font-medium text-card-foreground">
                    #{item.iterationNumber ?? index + 1}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {formatRelativeTime(
                      item.createdAt ?? item.startedAt ?? item.updatedAt,
                    )}
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[13px] font-medium text-card-foreground">
                    {target.client}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {target.model}
                  </span>
                </span>
                <span
                  className={cn("text-xs font-medium", outcomeTextTone(result))}
                >
                  {outcomeLabel(result)}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatRunCaseLatencyMs(iterationLatencyP95([item]))}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {typeof item.tokensUsed === "number"
                    ? compactMetric(item.tokensUsed)
                    : "—"}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {item.actualToolCalls?.length ?? "—"}
                </span>
              </>
            );
            return (
              <button
                key={item._id}
                type="button"
                className="grid w-full grid-cols-[minmax(130px,1fr)_minmax(180px,1fr)_120px_120px_110px_70px] items-center gap-2 border-t border-border px-3 py-2.5 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`Open iteration ${item.iterationNumber ?? index + 1} details`}
                onClick={() => onSelectIteration(item._id)}
              >
                {row}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function IterationDrawer({
  iteration,
  iterationNumber,
  target,
  caseTitle,
  suiteName,
  diagnostic,
  chain,
  onBack,
  onEditEvaluator,
}: {
  iteration: EvalIteration;
  iterationNumber: number;
  target: RunResultsMatrixData["targets"][number];
  caseTitle: string;
  suiteName?: string;
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  onBack: () => void;
  onEditEvaluator?: () => void;
}) {
  const result = computeIterationResult(iteration);
  const fullRun = useSelectedRun(target.run.suiteId, target.run._id).run;
  const judgeCase = resolveIterationJudge(iteration, fullRun ? [fullRun] : []);
  const authored = authoredForTrial({
    trial: { kind: "persisted", iteration, source: "route" },
    draft: { steps: [], toolsChoice: "unset" },
    run:
      "tests" in (target.run.configSnapshot ?? {})
        ? (target.run as EvalSuiteRun)
        : fullRun,
    forceSnapshot: true,
  }).authored;
  const decisionChain = diagnostic?.chain ?? chain;

  return (
    <>
      <EvalInspectHeader
        crumb={
          <>
            {caseTitle} <span aria-hidden="true">›</span> Run #
            {target.run.runNumber}
          </>
        }
        onBack={onBack}
        backAriaLabel="Back to test case iterations"
        title={`#${iterationNumber} ${suiteName ?? target.run.name ?? "Run"}`}
        badge={
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              result === "passed"
                ? "border-success/30 bg-success/10 text-success"
                : result === "failed" || result === "timed_out"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground",
            )}
          >
            {outcomeLabel(result)}
          </span>
        }
        description={
          <>
            {target.client} · {target.model} ·{" "}
            {formatRelativeTime(
              iteration.createdAt ?? iteration.startedAt ?? iteration.updatedAt,
            )}{" "}
            · {formatRunId(iteration._id)}
          </>
        }
      />
      {/* `fill` keeps IterationDetails / TraceViewer in a definite flex
          height so the Trace tab paints instead of collapsing to the resize
          handle. */}
      <EvalInspectBody fill>
        <div className="flex min-h-0 flex-1 flex-col">
          <IterationDetails
            hostSnapshot={hostSnapshotFromStyle(
              runClientIdentity(target.run).hostStyle,
            )}
            iteration={iteration}
            testCase={null}
            layoutMode="full"
            judgeCase={judgeCase}
            trialVerdictWord={outcomeLabel(result)}
            scorecard={{
              render: (context) => (
                <>
                  <IterationReportScorecard
                    authored={authored}
                    iteration={iteration}
                    steps={authored.steps}
                    chain={decisionChain}
                    judgeCase={judgeCase}
                    judgeSlot={
                      <CaseJudgeAnswer
                        run={fullRun}
                        iteration={iteration}
                        isQuickRun={false}
                        skippedForCase={
                          authored.judgeConfigOverride?.goalCompletion
                            ?.enabled === false
                        }
                        hidden={context.reviewActive && context.judgeHidden}
                      />
                    }
                    envelope={context.envelope}
                    trace={context.trace}
                    scoresSection={context.scoresSection}
                    judgeHidden={context.judgeHidden}
                  />
                  {onEditEvaluator && (
                    <div className="mt-4 flex justify-end">
                      <Button onClick={onEditEvaluator}>
                        Configure test case evaluators
                      </Button>
                    </div>
                  )}
                </>
              ),
            }}
          />
        </div>
      </EvalInspectBody>
    </>
  );
}

function DrawerAverage({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span className="text-[28px] font-bold leading-8 tracking-[-0.03em] text-card-foreground tabular-nums">
        {children}
      </span>
    </div>
  );
}
