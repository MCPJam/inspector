/**
 * The Evaluate run body: what broke, and what to do about it.
 *
 * This is the opt-in replacement for the run-detail pane inside
 * {@link EvaluateRunPage}. It is a separate component tree from
 * `RunDetailView` on purpose rather than a refactor of it — that view is
 * shared with `/evals`, the CI surfaces and the commit-detail page, and the
 * ordering this page needs (decision first, measurements last) is the opposite
 * of the one those surfaces ship today. Changing it in place would have moved
 * three other products to make one of them better.
 *
 * The read is the same read: `useEvalRunDecisionDetail` shares its LRU store
 * with the existing decision card, so mounting both surfaces costs one request,
 * not two, and they cannot disagree about a run.
 *
 * `fallbackBody` is the migration seam. Until the case rows land, the old
 * run-detail pane still renders beneath the verdict, so no information is
 * removed from the page in the commit that adds the headline.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";

import { copyToClipboard } from "@/lib/clipboard";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";

import { unifyTriageRows } from "../evals/ai-triage-helpers";
import { groupRunIterationsByTestCase } from "../evals/run-case-groups";
import { useServerQuality } from "../evals/use-server-quality";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import {
  buildEvaluateCaseRows,
  defaultOpenCaseRow,
} from "./evaluate-case-row-model";
import { RunAdvisorySection } from "./run-advisory-section";
import { RunCaseRowBody } from "./run-case-row-body";
import { RunCaseRows } from "./run-case-rows";
import { RunVerdictCaveats } from "./run-verdict-caveats";
import {
  buildEvaluateImprovePrompt,
  buildStageFixPrompt,
} from "./stage-fix-prompt";
import { recommendationForDiagnostic } from "./stage-reason-recommendation";
import { RunVerdictHero } from "./run-verdict-hero";
import { buildRunVerdictHero } from "./run-verdict-hero-model";

export function EvaluateRunContent({
  projectId,
  run,
  iterations,
  decisionSummaryEnabled,
  onOpenIteration,
  onEditCase,
  fallbackBody,
}: {
  projectId: string | null | undefined;
  run: EvalSuiteRun;
  iterations: readonly EvalIteration[];
  decisionSummaryEnabled: boolean;
  /** Focus one iteration's evidence through the app's own routing. */
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  onEditCase?: (testCaseId: string) => void;
  fallbackBody?: ReactNode;
}) {
  // Terminal only, matching `RunDecisionSummarySection`: a running row has no
  // decision to read, and asking anyway spends a request per poll to be told so.
  const active = decisionSummaryEnabled && isTerminalEvalRunStatus(run.status);

  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: run._id,
    enabled: active,
    revision: evalRunDecisionRevision(run),
  });

  const view = useMemo(
    () =>
      buildRunVerdictHero({
        run,
        iterations,
        decision: {
          status: detail.status,
          summary: detail.summary,
          diagnostics: detail.diagnostics,
        },
      }),
    [run, iterations, detail.status, detail.summary, detail.diagnostics],
  );

  // Chains for the iterations D9 does not describe. Diagnostics cover the
  // non-passing set only, by contract, so a passing case's chain comes from
  // here — and this read is page-capped, which is why a row states its
  // coverage instead of implying an unfetched stage was clean.
  const chains = useEvalRunIterationChains({
    projectId,
    run,
    enabled: active,
  });

  const caseRows = useMemo(() => {
    const groups = groupRunIterationsByTestCase([...iterations], "test");
    return buildEvaluateCaseRows({
      groups,
      summary: detail.summary,
      diagnostics: detail.diagnostics,
      chains: chains.chains,
      chainsLoaded: chains.status === "ready",
      decisionStatus: detail.status,
    });
  }, [
    iterations,
    detail.summary,
    detail.diagnostics,
    detail.status,
    chains.chains,
    chains.status,
  ]);

  const openRowKey = useMemo(() => defaultOpenCaseRow(caseRows), [caseRows]);

  // Advisory only, and read from the same place the existing triage card reads
  // it. `autoRequest` is deliberately off: a server-quality generation costs
  // money, and this page's primary action does not depend on it.
  const serverQuality = useServerQuality(run, { autoRequest: false });

  /**
   * Every failing case's prompt, measured failures first.
   *
   * One prompt per diagnostic rather than per case: a diagnostic is one
   * iteration, and grouping them by case is the case-rows step's job. Capped so
   * a hundred-failure run does not produce a prompt nobody can paste.
   */
  const triageRows = useMemo(
    () =>
      serverQuality.result
        ? unifyTriageRows({
            serverQuality: serverQuality.result,
            iterations: [...iterations],
          })
        : [],
    [serverQuality.result, iterations],
  );

  const improvePrompt = useMemo(() => {
    const stagePrompts: string[] = [];
    const seenCases = new Set<string>();
    for (const diagnostic of detail.diagnostics) {
      const caseKey = diagnostic.testCaseId ?? diagnostic.iterationId;
      if (seenCases.has(caseKey)) continue;
      const recommendation = recommendationForDiagnostic(diagnostic);
      if (!recommendation) continue;
      seenCases.add(caseKey);
      const iteration = iterations.find(
        (row) => row._id === diagnostic.iterationId,
      );
      stagePrompts.push(
        buildStageFixPrompt({
          caseTitle: diagnostic.title ?? "Untitled case",
          stage: recommendation.stage,
          reason: recommendation.reason,
          ...(diagnostic.chain.status === "verified"
            ? {
                chain: diagnostic.chain.stages,
                failureCategory: diagnostic.chain.failureCategory,
              }
            : {}),
          nextAction: diagnostic.nextAction,
          expectedToolCalls:
            iteration?.testCaseSnapshot?.expectedToolCalls ??
            diagnostic.expected?.toolNames.map((toolName) => ({ toolName })),
          observedToolCalls:
            iteration?.actualToolCalls ??
            diagnostic.observed?.toolNames?.map((toolName) => ({ toolName })),
          observedFailure: diagnostic.observed?.failure ?? null,
          recommendation,
        }),
      );
      if (stagePrompts.length >= 3) break;
    }
    return buildEvaluateImprovePrompt({
      stagePrompts,
      serverQuality: triageRows.length > 0 ? { rows: triageRows } : null,
    });
  }, [detail.diagnostics, iterations, triageRows]);

  const copyImprovePrompt = useCallback(async () => {
    const ok = await copyToClipboard(improvePrompt);
    if (ok) {
      toast.success("Prompt copied — paste it into your coding agent");
    } else {
      toast.error("Copy failed");
    }
  }, [improvePrompt]);

  const focusTarget = view.focus?.diagnostic;
  const openFailingTrace =
    onOpenIteration && focusTarget?.testCaseId
      ? () =>
          onOpenIteration({
            testCaseId: focusTarget.testCaseId as string,
            iterationId: focusTarget.iterationId,
          })
      : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="evaluate-run-content"
    >
      <RunVerdictHero
        view={view}
        {...(openFailingTrace ? { onOpenFailingTrace: openFailingTrace } : {})}
        actions={
          improvePrompt ? (
            <Button
              type="button"
              size="sm"
              className="h-8"
              onClick={copyImprovePrompt}
              data-testid="run-verdict-improve"
            >
              <Copy className="h-3.5 w-3.5" />
              Prompt to improve
            </Button>
          ) : null
        }
      />

      <div className="px-5 pb-4">
        <RunVerdictCaveats
          summary={detail.summary}
          shownDiagnostics={detail.diagnostics.length}
          scannedIterations={detail.scannedIterations}
          serverComplete={detail.serverComplete}
          walkExhausted={detail.walkExhausted}
        />
      </div>

      <div className="border-t border-border/40">
        <RunCaseRows
          rows={caseRows}
          defaultOpenKey={openRowKey}
          renderBody={(row) => (
            <RunCaseRowBody
              row={row}
              iterations={iterations}
              {...(onOpenIteration ? { onOpenIteration } : {})}
              {...(onEditCase ? { onEditCase } : {})}
            />
          )}
        />
      </div>

      <RunAdvisorySection
        suiteRunId={String(run._id)}
        triageRows={triageRows}
        showActionableFindings={Boolean(serverQuality.result)}
      />

      {fallbackBody ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border/40">
          {fallbackBody}
        </div>
      ) : null}
    </div>
  );
}
