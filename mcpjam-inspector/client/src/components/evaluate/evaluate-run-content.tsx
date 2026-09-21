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
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { runClientIdentity } from "../evals/helpers";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";

import { compactModelIdTail } from "@/lib/environment-label";
import { copyToClipboard } from "@/lib/clipboard";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import { useDescriptionExperimentEnabled } from "@/hooks/useDescriptionExperimentEnabled";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";

import { unifyTriageRows } from "../evals/ai-triage-helpers";
import { useServerQuality } from "../evals/use-server-quality";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import {
  describeRunChanges,
  summarizeRunChanges,
} from "./evaluate-run-diff-model";
import { useEvalRunCompare } from "./use-eval-run-compare";
import { UnifiedFindingsSection } from "./unified-findings-section";
import { RunResultsMatrix } from "./run-results-matrix";
import { RunDescriptionExperimentCard } from "./run-description-experiment-card";
import { useEvalDescriptionExperiment } from "./use-eval-description-experiment";
import {
  buildEvaluateImprovePrompt,
  buildStageFixPrompt,
} from "./stage-fix-prompt";
import { remedyForDiagnostic } from "./stage-remedy";
import { HeroExplanation, RunVerdictHero } from "./run-verdict-hero";
import { buildRunVerdictHero } from "./run-verdict-hero-model";
import {
  buildHeroPairings,
  previousCompletedRunOf,
} from "./run-verdict-hero-deltas";
import { CombinedRunContent } from "./combined-run-content";
import { launchRuns } from "./run-results-matrix-model";

export function EvaluateRunContent(
  props: Parameters<typeof SingleRunContent>[0],
) {
  const targets = launchRuns(props.run, props.siblingRuns ?? []);
  return targets.length > 1 ? (
    <CombinedRunContent {...props} runs={targets} />
  ) : (
    <SingleRunContent {...props} />
  );
}

import { useEvaluateRunPageHeaderActions } from "./evaluate-run-page";

export function SingleRunContent({
  projectId,
  run,
  suiteName,
  iterations,
  allIterations,
  siblingRuns = [],
  hostNamesById,
  previousRunId,
  decisionSummaryEnabled,
  onOpenIteration,
  onEditCase,
  onEditEvaluator,
}: {
  projectId: string | null | undefined;
  run: EvalSuiteRun;
  suiteName?: string;
  iterations: readonly EvalIteration[];
  /** Every iteration in the suite, so the previous run's fractions are known. */
  allIterations?: readonly EvalIteration[];
  siblingRuns?: readonly EvalSuiteRun[];
  hostNamesById?: ReadonlyMap<string, string | null>;
  previousRunId?: string | null;
  decisionSummaryEnabled: boolean;
  /** Focus one iteration's evidence through the app's own routing. */
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  onEditCase?: (testCaseId: string) => void;
  onEditEvaluator?: (testCaseId: string) => void;
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

  const previousLaunch = useMemo(() => {
    if (previousRunId) {
      return siblingRuns.filter((candidate) => candidate._id === previousRunId);
    }
    const previous = previousCompletedRunOf(run, siblingRuns);
    return previous ? [previous] : [];
  }, [previousRunId, siblingRuns, run]);

  const previousIterations = useMemo(() => {
    const previousId = previousLaunch[0]?._id;
    if (!previousId || !allIterations) return null;
    const rows = allIterations.filter(
      (iteration) => iteration.suiteRunId === previousId,
    );
    return rows.length > 0 ? rows : null;
  }, [allIterations, previousLaunch]);

  const pairings = useMemo(() => {
    const names = hostNamesById ?? new Map();
    // Identity and label stay separate: the twin lookup keys on the run's
    // own effective model, so a fallback label must not leak into the key.
    const modelId = run.effectiveModelId ?? "";
    const modelLabel = run.effectiveModelId ?? "Client default";
    return buildHeroPairings({
      targets: [
        {
          key: run._id,
          run,
          client: runClientIdentity(run, names).name,
          modelId,
          model: compactModelIdTail(modelLabel),
          iterations,
        },
      ],
      previousLaunch: previousLaunch.length > 0 ? previousLaunch : null,
      previousIterations,
    });
  }, [run, iterations, hostNamesById, previousLaunch, previousIterations]);

  const view = useMemo(
    () => ({
      ...buildRunVerdictHero({
        run,
        iterations,
        decision: {
          status: detail.status,
          summary: detail.summary,
          diagnostics: detail.diagnostics,
        },
        previous: previousIterations
          ? { iterations: previousIterations }
          : null,
      }),
      pairings,
    }),
    [
      run,
      iterations,
      detail.status,
      detail.summary,
      detail.diagnostics,
      previousIterations,
      pairings,
    ],
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

  const descriptionExperimentEnabled = useDescriptionExperimentEnabled();
  const descriptionExperiment = useEvalDescriptionExperiment({
    projectId,
    sourceRunId: run._id,
    revision: evalRunDecisionRevision(run),
    enabled: descriptionExperimentEnabled && active,
  });
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

  // Advisory only, and read from the same place the existing triage card reads
  // it. `autoRequest` is deliberately off: a server-quality generation costs
  // money, and this page's primary action does not depend on it.
  //
  // ALSO the controller the unified-findings experiment borrows. One per run,
  // deliberately: mounting a second would give the page two lifecycles for the
  // same lease and let one click become two billable requests.
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
      toast.success("Prompt copied. Paste it into your coding agent");
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

  /**
   * Open the iteration a finding's evidence names.
   *
   * The page's router wants `{ testCaseId, iterationId }`, so the case is
   * looked up FROM THE ITERATION rather than borrowed from whatever the
   * verdict hero happens to be focused on — those are different cases most of
   * the time, and reusing the focus target would open the wrong one while
   * looking like it worked. An iteration this page does not hold (a finding
   * built from a run whose rows are paged out) opens nothing rather than
   * opening something adjacent.
   */
  const openEvidenceIteration = useCallback(
    (iterationId: string) => {
      if (!onOpenIteration) return;
      const iteration = iterations.find((row) => row._id === iterationId);
      const testCaseId = iteration?.testCaseId;
      if (!testCaseId) return;
      onOpenIteration({ testCaseId: String(testCaseId), iterationId });
    },
    [onOpenIteration, iterations],
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
        explanation={
          <UnifiedFindingsSection
            suiteRunId={String(run._id)}
            iterations={iterations}
            clientLabel={view.pairings?.[0]?.client ?? null}
            fallback={<HeroExplanation view={view} />}
            generation={{
              pending: serverQuality.pending,
              failedGeneration: serverQuality.failedGeneration,
              error: serverQuality.error,
              unavailable: serverQuality.unavailable,
              canRequest: serverQuality.canRequest,
              requestInsight: serverQuality.requestServerQuality,
            }}
            {...(onOpenIteration
              ? { onOpenIteration: openEvidenceIteration }
              : {})}
          />
        }
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

      <div className="border-t border-border/40">
        <RunResultsMatrix
          onEditCase={onEditCase}
          onEditEvaluator={onEditEvaluator}
          key={run._id}
          run={run}
          suiteName={suiteName}
          runs={siblingRuns}
          diagnostics={detail.diagnostics}
          chains={chains.chains}
          iterations={
            allIterations
              ? [
                  ...allIterations.filter(
                    (item) => item.suiteRunId !== run._id,
                  ),
                  ...iterations,
                ]
              : iterations
          }
          hostNamesById={hostNamesById}
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
    </div>
  );
}
