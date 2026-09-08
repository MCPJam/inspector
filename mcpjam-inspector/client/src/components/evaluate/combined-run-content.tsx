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
  type RunVerdictHeroView,
} from "./run-verdict-hero-model";
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
  const view = combinedReportView(
    selectedRuns,
    selectedIterations,
    selectedReports.map((report) => report.view),
    isFiltered,
  );
  const fullVerdict = combinedReportView(
    hydratedRuns,
    iterations,
    hydratedRuns.flatMap((run) => reports.get(run._id)?.view ?? []),
    false,
  ).verdict;
  const diagnostics = selectedReports.flatMap((report) => report.diagnostics);
  const chains = new Map(
    selectedReports.flatMap((report) => [...report.chains]),
  );
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {isFiltered
            ? `${targets.length} of ${matrix.targets.length}`
            : `All ${matrix.targets.length}`}{" "}
          client/model pairings
        </p>
        <div className="flex items-center gap-2">
          <EvalListFilter
            label="Client"
            className="w-28"
            value={client}
            options={[
              ...new Set(matrix.targets.map((target) => target.client)),
            ]}
            onChange={setClient}
          />
          <EvalListFilter
            label="Model"
            className="w-40"
            value={model}
            options={[
              ...new Set(matrix.targets.map((target) => target.modelId)),
            ]}
            onChange={setModel}
          />
          <Button
            disabled={!isFiltered}
            variant="ghost"
            size="sm"
            onClick={() => {
              setClient(ALL_EVAL_FILTER_VALUES);
              setModel(ALL_EVAL_FILTER_VALUES);
            }}
          >
            Clear filters
          </Button>
        </div>
      </div>
      {history.loading && runs.some((run) => !history.details.has(run._id)) ? (
        <p role="status" className="p-5 text-sm text-muted-foreground">
          Loading results for every client and model…
        </p>
      ) : history.errorCount ? (
        <div role="alert" className="p-5 text-sm">
          Results unavailable for {history.errorCount} client/model pairings.{" "}
          <Button variant="ghost" size="sm" onClick={history.retry}>
            Retry results
          </Button>
        </div>
      ) : !targets.length ? (
        <p className="p-5 text-sm text-muted-foreground">
          No results match these filters.
        </p>
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
            />
          </div>
        </>
      )}
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
    stats: { ...fallback.stats, cases: { kind: "unavailable" } },
  };
}
