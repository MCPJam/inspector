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
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";

import { copyToClipboard } from "@/lib/clipboard";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import { useEvalRunRouteFacts } from "@/hooks/use-eval-run-route-facts";
import { useEvalRunStageAnalytics } from "@/hooks/use-eval-run-stage-analytics";
import { useDescriptionExperimentEnabled } from "@/hooks/useDescriptionExperimentEnabled";
import { useFailureGroupsEnabled } from "@/hooks/useFailureGroupsEnabled";
import { useRouteFactsEnabled } from "@/hooks/useRouteFactsEnabled";
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
import {
  describeRunChanges,
  pillsByRowKey,
  summarizeRunChanges,
} from "./evaluate-run-diff-model";
import { useEvalRunCompare } from "./use-eval-run-compare";
import {
  catalogToolNamesFromRun,
  isEmulatedDescriptionExperimentEngine,
  readRunExecutionEngine,
} from "./description-experiment-model";
import { FailureGroupsCard } from "./failure-groups-card";
import { RunAdvisorySection } from "./run-advisory-section";
import { RunCaseRowBody } from "./run-case-row-body";
import { RunCaseRows } from "./run-case-rows";
import { RunDescriptionExperimentCard } from "./run-description-experiment-card";
import { RunDescriptionOverrideDisclosure } from "./run-description-override-disclosure";
import { useEvalDescriptionExperiment } from "./use-eval-description-experiment";
import {
  buildRunRouteFacts,
  routeFactsForRow,
  routeLinesByRowKey,
} from "./route-facts-model";
import { RunStageStrip } from "./run-stage-strip";
import { buildStageStrip } from "./run-stage-strip-model";
import { RunGradingPeek } from "./run-grading-peek";
import { RunVerdictCaveats } from "./run-verdict-caveats";
import {
  buildEvaluateImprovePrompt,
  buildStageFixPrompt,
} from "./stage-fix-prompt";
import { remedyForDiagnostic } from "./stage-remedy";
import { RunVerdictHero } from "./run-verdict-hero";
import { buildRunVerdictHero } from "./run-verdict-hero-model";
import { useEvaluateRunPageHeaderActions } from "./evaluate-run-page";

export function EvaluateRunContent({
  projectId,
  run,
  iterations,
  allIterations,
  previousRunId,
  decisionSummaryEnabled,
  onOpenIteration,
  onEditCase,
  fallbackBody,
}: {
  projectId: string | null | undefined;
  run: EvalSuiteRun;
  iterations: readonly EvalIteration[];
  /** Every iteration in the suite, so the previous run's fractions are known. */
  allIterations?: readonly EvalIteration[];
  previousRunId?: string | null;
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

  const descriptionExperimentEnabled = useDescriptionExperimentEnabled();
  const descriptionExperiment = useEvalDescriptionExperiment({
    projectId,
    sourceRunId: run._id,
    revision: evalRunDecisionRevision(run),
    enabled: descriptionExperimentEnabled && active,
  });
  const catalogToolNames = useMemo(
    () =>
      descriptionExperimentEnabled
        ? catalogToolNamesFromRun(run)
        : new Set<string>(),
    [descriptionExperimentEnabled, run],
  );
  const engineSupported = isEmulatedDescriptionExperimentEngine(
    readRunExecutionEngine(run),
  );
  const descriptionOverride =
    run.configSnapshot?.toolDescriptionOverride ?? null;

  const failureGroupsEnabled = useFailureGroupsEnabled();
  const routeFactsEnabled = useRouteFactsEnabled();
  const persistedRouteFacts = useEvalRunRouteFacts({
    projectId,
    runId: run._id,
    runStatus: run.status,
    enabled: routeFactsEnabled && active,
  });
  const routeFactsDoc = useMemo(() => {
    if (!routeFactsEnabled) return null;
    return (
      persistedRouteFacts.document ?? buildRunRouteFacts(run, iterations)
    );
  }, [routeFactsEnabled, persistedRouteFacts.document, run, iterations]);
  const routeFactsComputedHere =
    routeFactsEnabled &&
    (persistedRouteFacts.status === "absent" ||
      persistedRouteFacts.document === null);
  const routeLines = useMemo(
    () =>
      routeFactsDoc
        ? routeLinesByRowKey(routeFactsDoc, caseRows, iterations)
        : undefined,
    [routeFactsDoc, caseRows, iterations],
  );

  // No second flag. This whole surface is already behind `evaluate-enabled`,
  // and gating the strip again meant it vanished with no way for a reader to
  // tell an ungated section from a broken one — which is exactly what happened.
  // The strip is part of the page; whether it has numbers is the document's
  // business, and it says which.
  const stageAnalytics = useEvalRunStageAnalytics({
    projectId,
    runId: run._id,
    runStatus: run.status,
    enabled: active,
  });
  const stripView = useMemo(
    () =>
      buildStageStrip({
        status: stageAnalytics.status,
        document: stageAnalytics.document,
        error: stageAnalytics.error,
      }),
    [stageAnalytics.status, stageAnalytics.document, stageAnalytics.error],
  );

  // What changed since the previous run. One read, no store: the answer is not
  // shared with another surface and a cache would be more machinery than it is
  // worth.
  const compare = useEvalRunCompare({
    projectId,
    run,
    ...(previousRunId ? { baseRunId: previousRunId } : {}),
    enabled: active,
  });

  const changeSummary = useMemo(
    () => (compare.dto ? summarizeRunChanges(compare.dto) : null),
    [compare.dto],
  );

  /**
   * The previous run's own pass fractions, keyed by case.
   *
   * Read from the iteration rows this page already holds rather than from the
   * comparison: the public compare DTO carries each side's OUTCOME but no
   * per-side counts, so "was 7/10" has to come from somewhere else or not be
   * shown at all.
   */
  const previousFractions = useMemo(() => {
    const byCaseKey = new Map<string, { passed: number; total: number }>();
    if (!previousRunId || !allIterations) return byCaseKey;
    for (const iteration of allIterations) {
      if (iteration.suiteRunId !== previousRunId) continue;
      const caseKey = iteration.testCaseSnapshot?.caseKey;
      if (!caseKey) continue;
      const entry = byCaseKey.get(caseKey) ?? { passed: 0, total: 0 };
      entry.total += 1;
      if (iteration.result === "passed") entry.passed += 1;
      byCaseKey.set(caseKey, entry);
    }
    return byCaseKey;
  }, [allIterations, previousRunId]);

  const rowPills = useMemo(
    () =>
      pillsByRowKey({
        rows: caseRows,
        dto: compare.dto,
        caseKeyOf: (row) => row.caseKey,
        previousIterationsOf: (caseKey) =>
          previousFractions.get(caseKey) ?? null,
      }),
    [caseRows, compare.dto, previousFractions],
  );

  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const visibleRows = useMemo(
    () =>
      stageFilter === null
        ? caseRows
        : caseRows.filter(
            (row) =>
              row.break.kind === "brokeAt" && row.break.stage === stageFilter,
          ),
    [caseRows, stageFilter],
  );

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
      const remedy = remedyForDiagnostic(diagnostic);
      if (!remedy) continue;
      seenCases.add(caseKey);
      const iteration = iterations.find(
        (row) => row._id === diagnostic.iterationId,
      );
      stagePrompts.push(
        buildStageFixPrompt({
          caseTitle: diagnostic.title ?? "Untitled case",
          stage: remedy.stage,
          reason: remedy.reason,
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
          remedy,
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
  const openFailingTrace = useCallback(() => {
    if (!onOpenIteration || !focusTarget?.testCaseId) return;
    onOpenIteration({
      testCaseId: focusTarget.testCaseId,
      iterationId: focusTarget.iterationId,
    });
  }, [onOpenIteration, focusTarget?.testCaseId, focusTarget?.iterationId]);

  const canOpenFailingTrace = Boolean(
    onOpenIteration && focusTarget?.testCaseId,
  );

  const inRunPageHeader = useEvaluateRunPageHeaderActions(
    canOpenFailingTrace || improvePrompt
      ? {
          ...(improvePrompt ? { onImprove: copyImprovePrompt } : {}),
          ...(canOpenFailingTrace
            ? { onOpenFailingTrace: openFailingTrace }
            : {}),
        }
      : null,
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="evaluate-run-content"
    >
      <RunVerdictHero
        view={view}
        {...(!inRunPageHeader && canOpenFailingTrace
          ? { onOpenFailingTrace: openFailingTrace }
          : {})}
        actions={
          !inRunPageHeader && improvePrompt ? (
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

      {changeSummary ? (
        <p
          className="px-5 pb-3 text-[12.5px] text-muted-foreground"
          data-testid="run-change-summary"
        >
          vs run #{changeSummary.baseRunNumber}:{" "}
          {describeRunChanges(changeSummary).join(" · ") ||
            "no case changed state"}
        </p>
      ) : null}

      {descriptionOverride ? (
        <div className="px-5">
          <RunDescriptionOverrideDisclosure
            toolName={descriptionOverride.toolName}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-3 px-5 pb-4">
        {view.sentence.kind === "brokeAt" ? (
          <RunGradingPeek
            expected={view.sentence.expected}
            observed={view.sentence.observed}
          />
        ) : null}
        <RunVerdictCaveats
          summary={detail.summary}
          shownDiagnostics={detail.diagnostics.length}
          scannedIterations={detail.scannedIterations}
          serverComplete={detail.serverComplete}
          walkExhausted={detail.walkExhausted}
        />
      </div>

      <div className="border-t border-border/40">
        <RunStageStrip
          view={stripView}
          activeStage={stageFilter}
          onSelectStage={setStageFilter}
        />
      </div>

      <div className="border-t border-border/40">
        <RunCaseRows
          rows={visibleRows}
          defaultOpenKey={openRowKey}
          pills={rowPills}
          {...(routeLines ? { routeLines } : {})}
          renderBody={(row) => (
            <RunCaseRowBody
              row={row}
              iterations={iterations}
              {...(routeFactsDoc
                ? {
                    routeFacts: routeFactsForRow(
                      routeFactsDoc,
                      row,
                      iterations,
                    ),
                    catalogState: routeFactsDoc.catalogState,
                    ...(routeFactsComputedHere ? { computedHere: true } : {}),
                  }
                : {})}
              {...(onOpenIteration ? { onOpenIteration } : {})}
              {...(onEditCase ? { onEditCase } : {})}
              {...(descriptionExperimentEnabled
                ? {
                    descriptionExperiment: {
                      catalogToolNames,
                      engineSupported,
                      onPropose: (toolName: string) => {
                        void descriptionExperiment.propose({ toolName });
                      },
                      ...(descriptionExperiment.status === "loading"
                        ? {
                            busyToolName:
                              descriptionExperiment.experiment?.toolName ??
                              null,
                          }
                        : {}),
                    },
                  }
                : {})}
            />
          )}
        />
      </div>

      {descriptionExperimentEnabled && descriptionExperiment.experiment ? (
        <RunDescriptionExperimentCard
          experiment={descriptionExperiment.experiment}
          onStart={() => {
            void descriptionExperiment.start();
          }}
          starting={
            descriptionExperiment.status === "loading" &&
            descriptionExperiment.experiment.status === "proposed"
          }
        />
      ) : null}

      <RunAdvisorySection
        suiteRunId={String(run._id)}
        triageRows={triageRows}
        showActionableFindings={Boolean(serverQuality.result)}
      />

      {failureGroupsEnabled && run.suiteId ? (
        <FailureGroupsCard suiteId={String(run.suiteId)} />
      ) : null}

      {fallbackBody ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-border/40">
          {fallbackBody}
        </div>
      ) : null}
    </div>
  );
}
