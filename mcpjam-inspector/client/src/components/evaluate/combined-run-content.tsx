import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EvalRunDecisionDiagnostic,
  EvalRunDecisionChain,
} from "@mcpjam/sdk/contract";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import { useEvalRunIterationChains } from "@/hooks/use-eval-run-iteration-chains";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import { Button } from "@mcpjam/design-system/button";
import {
  EvalListFilter,
  ALL_EVAL_FILTER_VALUES,
} from "../evals/eval-list-filter";
import { useProjectRunHistory } from "../evals/use-project-run-history";
import type { EvalSuiteRun, EvalIteration } from "../evals/types";
import { buildRunResultsMatrix } from "./run-results-matrix-model";
import { RunResultsMatrix } from "./run-results-matrix";
import {
  buildRunVerdictHero,
  heroStatsFor,
  type RunVerdictHeroView,
} from "./run-verdict-hero-model";
import {
  buildHeroPairings,
  buildHeroStatDeltas,
  previousHeroIterations,
  previousLaunchRuns,
} from "./run-verdict-hero-deltas";
import { RunVerdictHero } from "./run-verdict-hero";
import type { SingleRunContent } from "./evaluate-run-content";

type MemberReport = {
  view: RunVerdictHeroView;
  diagnostics: readonly EvalRunDecisionDiagnostic[];
  chains: ReadonlyMap<string, EvalRunDecisionChain>;
};

/** One report, even when execution was distributed across several clients. */
export function CombinedRunContent({
  runs,
  projectId,
  hostNamesById = new Map(),
  siblingRuns = [],
  allIterations,
  previousRunId,
  decisionSummaryEnabled,
  onOpenIteration,
}: Parameters<typeof SingleRunContent>[0] & { runs: EvalSuiteRun[] }) {
  const history = useProjectRunHistory(
    projectId ?? "",
    runs,
    Boolean(projectId),
  );
  const [client, setClient] = useState(ALL_EVAL_FILTER_VALUES);
  const [model, setModel] = useState(ALL_EVAL_FILTER_VALUES);
  const [reports, setReports] = useState<Map<string, MemberReport>>(new Map());
  const record = useCallback((id: string, report: MemberReport) => {
    setReports((previous) => new Map(previous).set(id, report));
  }, []);
  const hydratedRuns = runs.map(
    (run) => history.details.get(run._id)?.run ?? run,
  );
  const iterations = [...history.details.values()].flatMap(
    (detail) => detail.iterations,
  );
  const matrix = buildRunResultsMatrix({
    run: hydratedRuns[0],
    runs: hydratedRuns,
    iterations,
    hostNamesById,
  });
  const targets = matrix.targets.filter(
    (target) =>
      (client === ALL_EVAL_FILTER_VALUES || target.client === client) &&
      (model === ALL_EVAL_FILTER_VALUES || target.modelId === model),
  );
  const selectedRunIds = new Set(targets.map((target) => target.run._id));
  const selectedRuns = hydratedRuns.filter((run) =>
    selectedRunIds.has(run._id),
  );
  const selectedIterations = targets.flatMap((target) => target.iterations);
  const selectedReports = selectedRuns.flatMap(
    (run) => reports.get(run._id) ?? [],
  );
  const isFiltered =
    client !== ALL_EVAL_FILTER_VALUES || model !== ALL_EVAL_FILTER_VALUES;
  const suiteRuns = siblingRuns.length > 0 ? siblingRuns : hydratedRuns;
  const previousIterations = previousHeroIterations({
    selectedRuns,
    suiteRuns,
    allIterations,
    previousRunId,
    matchSelectedPairings: isFiltered,
  });
  const previousLaunch = previousLaunchRuns(
    selectedRuns,
    suiteRuns,
    previousRunId,
  );
  const pairings = buildHeroPairings({
    targets,
    previousLaunch,
    previousIterations,
  });
  const view = {
    ...combinedReportView(
      selectedRuns,
      selectedIterations,
      selectedReports.map((report) => report.view),
      isFiltered,
      previousIterations,
    ),
    pairings,
  };
  const fullVerdict = combinedReportView(
    hydratedRuns,
    iterations,
    hydratedRuns.flatMap((run) => reports.get(run._id)?.view ?? []),
    false,
    previousIterations,
  ).verdict;
  const diagnostics = selectedReports.flatMap((report) => report.diagnostics);
  const chains = new Map(
    selectedReports.flatMap((report) => [...report.chains]),
  );
  const clearPairingFilters = () => {
    setClient(ALL_EVAL_FILTER_VALUES);
    setModel(ALL_EVAL_FILTER_VALUES);
  };
  const pairingFilterProps = {
    client,
    model,
    clientOptions: [...new Set(matrix.targets.map((target) => target.client))],
    modelOptions: [...new Set(matrix.targets.map((target) => target.modelId))],
    isFiltered,
    onClientChange: setClient,
    onModelChange: setModel,
    onClear: clearPairingFilters,
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="combined-run-content"
    >
      {hydratedRuns.map((run) => {
        const detail = history.details.get(run._id);
        return detail ? (
          <MemberDecision
            key={`${run._id}:${evalRunDecisionRevision(run)}`}
            run={run}
            iterations={detail.iterations}
            projectId={projectId}
            enabled={decisionSummaryEnabled}
            onReport={record}
          />
        ) : null;
      })}
      {history.loading && runs.some((run) => !history.details.has(run._id)) ? (
        <div className="px-5 py-3">
          <PairingFilters {...pairingFilterProps} showClear />
          <p role="status" className="pt-2 text-sm text-muted-foreground">
            Loading results for every client and model…
          </p>
        </div>
      ) : history.errorCount ? (
        <div role="alert" className="p-5 text-sm">
          Results unavailable for {history.errorCount} client/model pairings.{" "}
          <Button variant="ghost" size="sm" onClick={history.retry}>
            Retry results
          </Button>
        </div>
      ) : !targets.length ? (
        <div className="px-5 py-3">
          <PairingFilters {...pairingFilterProps} showClear />
          <p className="pt-2 text-sm text-muted-foreground">
            No results match these filters.
          </p>
        </div>
      ) : (
        <>
          <RunVerdictHero view={view} headerVerdict={fullVerdict} />
          <div className="border-t border-border/40">
            <RunResultsMatrix
              run={selectedRuns[0]}
              runs={selectedRuns}
              iterations={selectedIterations}
              hostNamesById={hostNamesById}
              diagnostics={diagnostics}
              chains={chains}
              onOpenIteration={onOpenIteration}
              modelIds={model === ALL_EVAL_FILTER_VALUES ? undefined : [model]}
              toolbarExtra={<PairingFilters {...pairingFilterProps} />}
              extraFiltersActive={isFiltered}
              onClearExtraFilters={clearPairingFilters}
            />
          </div>
        </>
      )}
    </div>
  );
}

function PairingFilters({
  client,
  model,
  clientOptions,
  modelOptions,
  isFiltered,
  onClientChange,
  onModelChange,
  onClear,
  showClear = false,
}: {
  client: string;
  model: string;
  clientOptions: string[];
  modelOptions: string[];
  isFiltered: boolean;
  onClientChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onClear: () => void;
  showClear?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <EvalListFilter
        label="Client"
        className="w-28"
        value={client}
        options={clientOptions}
        onChange={onClientChange}
      />
      <EvalListFilter
        label="Model"
        className="w-40"
        value={model}
        options={modelOptions}
        onChange={onModelChange}
      />
      {showClear && isFiltered ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={onClear}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function MemberDecision({
  run,
  iterations,
  projectId,
  enabled,
  onReport,
}: {
  run: EvalSuiteRun;
  iterations: EvalIteration[];
  projectId: string | null | undefined;
  enabled: boolean;
  onReport: (id: string, report: MemberReport) => void;
}) {
  const active = enabled && isTerminalEvalRunStatus(run.status);
  const detail = useEvalRunDecisionDetail({
    projectId,
    runId: run._id,
    enabled: active,
    revision: evalRunDecisionRevision(run),
  });
  const chains = useEvalRunIterationChains({ projectId, run, enabled: active });
  const report = useMemo(
    () => ({
      view: buildRunVerdictHero({ run, iterations, decision: detail }),
      diagnostics: detail.diagnostics,
      chains: chains.chains,
    }),
    [
      run,
      iterations,
      detail.status,
      detail.summary,
      detail.diagnostics,
      chains.chains,
    ],
  );
  // Decision hooks can return fresh empty arrays while loading. Publish only
  // a changed reading, not a new array identity from the parent's own render.
  const fingerprint = JSON.stringify([
    report.view,
    report.diagnostics,
    [...report.chains],
  ]);
  useEffect(() => {
    onReport(run._id, report);
  }, [run._id, fingerprint, onReport]);
  return null;
}

/** Preserve each recorded decision; a mixed outcome is never one member's verdict. */
export function combinedReportView(
  runs: EvalSuiteRun[],
  iterations: EvalIteration[],
  views: RunVerdictHeroView[],
  filtered: boolean,
  previousIterations?: EvalIteration[] | null,
): RunVerdictHeroView {
  const fallback = buildRunVerdictHero({
    run: runs[0] ?? ({ status: "pending" } as EvalSuiteRun),
    iterations,
    decision: { status: "disabled", summary: null, diagnostics: [] },
  });
  const pending =
    views.length < runs.length || views.some((view) => view.pending);
  const words = new Set(views.map((view) => view.verdict.word));
  const iterationIds = new Set(iterations.map((iteration) => iteration._id));
  const focusView =
    views.find(
      (view) =>
        view.focus &&
        (!filtered || iterationIds.has(view.focus.diagnostic.iterationId)),
    ) ?? (filtered ? undefined : views[0]);
  const stats = { ...fallback.stats, cases: { kind: "unavailable" as const } };
  const previousStats =
    previousIterations && previousIterations.length > 0
      ? {
          ...heroStatsFor({
            run: runs[0] ?? ({ status: "pending" } as EvalSuiteRun),
            iterations: previousIterations,
            decision: { status: "disabled", summary: null, diagnostics: [] },
          }),
          cases: { kind: "unavailable" as const },
        }
      : null;
  return {
    ...fallback,
    pending,
    verdict: pending
      ? { word: "Loading results", tone: "neutral", undecidedLine: null }
      : filtered
        ? {
            word: "Filtered results",
            tone: "neutral",
            undecidedLine: "Across the selected client/model pairings",
          }
        : words.size === 1
          ? {
              ...views[0].verdict,
              undecidedLine: filtered
                ? "Across the selected client/model pairings"
                : `Across all ${runs.length} client/model configurations`,
            }
          : {
              word: "Mixed results",
              tone: "neutral",
              undecidedLine: [...words].join(" · "),
            },
    focus: focusView?.focus ?? null,
    sentence:
      focusView?.sentence ??
      (filtered
        ? {
            kind: "unavailable",
            text: "Results for the selected clients and models.",
          }
        : fallback.sentence),
    // Iteration measurements span precisely the visible population. Do not add
    // canonical case counts from different clients as though they were unique cases.
    stats,
    pairings: fallback.pairings,
    deltas: previousStats ? buildHeroStatDeltas(stats, previousStats) : null,
  };
}
