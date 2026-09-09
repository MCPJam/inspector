import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import {
  runHostLabel,
  iterationLatencyP50,
  iterationLatencyP95,
  computeIterationSummary,
} from "../evals/helpers";
import {
  buildSuiteMetricStripData,
  formatCompactNumber,
  formatDurationMs,
} from "../evals/metric-strip-data";
import { toPercent } from "../evals/suite-overview-presentation";

const label = (run: EvalSuiteRun) =>
  run.runNumber != null ? `#${run.runNumber}` : run._id.slice(0, 8);
const caseKey = (it: EvalIteration) =>
  it.testCaseId ||
  it.testCaseSnapshot?.caseKey ||
  it.testCaseSnapshot?.title ||
  it._id;
const number = (value: number | null | undefined) =>
  value == null ? "—" : formatCompactNumber(value);
const duration = (value: number | null | undefined) =>
  value == null ? "—" : formatDurationMs(value);

export function RunComparisonPage({
  currentRun,
  runs,
  iterations,
  suiteName,
  hostNamesById,
  onBack,
  onOpenRun,
}: {
  currentRun: EvalSuiteRun;
  runs: readonly EvalSuiteRun[];
  iterations: readonly EvalIteration[];
  suiteName: string;
  hostNamesById: Map<string, string | null>;
  onBack: () => void;
  onOpenRun: (id: string) => void;
}) {
  const options = [
    currentRun,
    ...runs
      .filter((run) => run._id !== currentRun._id)
      .sort((a, b) => b.createdAt - a.createdAt),
  ];
  const [selected, setSelected] = useState(() =>
    options.slice(0, 4).map((run) => run._id),
  );
  const columns = options
    .filter((run) => selected.includes(run._id))
    .map((run) => {
      const trials = iterations.filter((it) => it.suiteRunId === run._id);
      const complete =
        trials.length > 0 &&
        (!run.summary || trials.length === run.summary.total);
      const metrics = complete
        ? buildSuiteMetricStripData([run], trials)?.latest
        : null;
      return { run, trials, complete, metrics };
    });
  type Column = (typeof columns)[number];
  const rows: { name: string; value: (column: Column) => string }[] = [
    {
      name: "Client",
      value: ({ run }) => runHostLabel(run, hostNamesById) ?? "Unknown client",
    },
    {
      name: "Model",
      value: ({ run, trials }) =>
        run.effectiveModelId ||
        [
          ...new Set(
            trials.map((it) => it.testCaseSnapshot?.model).filter(Boolean),
          ),
        ].join(", ") ||
        [
          ...new Set(
            run.configSnapshot?.tests.map(
              (test) => `${test.provider}/${test.model}`,
            ) ?? [],
          ),
        ].join(", ") ||
        "—",
    },
    { name: "Status", value: ({ run }) => run.status ?? "—" },
    { name: "Result", value: ({ run }) => run.result ?? "No verdict" },
    {
      name: "Started",
      value: ({ run }) => new Date(run.createdAt).toLocaleString(),
    },
    {
      name: "Duration",
      value: ({ run }) =>
        duration(
          run.completedAt != null ? run.completedAt - run.createdAt : null,
        ),
    },
    {
      name: "Pass rate",
      value: ({ run }) =>
        run.summary?.passRate != null
          ? `${toPercent(run.summary.passRate)}%`
          : "—",
    },
    {
      name: "Passed iterations",
      value: ({ run }) => number(run.summary?.passed),
    },
    {
      name: "Failed iterations",
      value: ({ run }) => number(run.summary?.failed),
    },
    {
      name: "Total iterations",
      value: ({ run }) => number(run.summary?.total),
    },
    {
      name: "Latency P50",
      value: ({ metrics }) => duration(metrics?.latencyP50),
    },
    {
      name: "Latency P95",
      value: ({ metrics }) => duration(metrics?.latencyP95),
    },
    {
      name: "Total tokens",
      value: ({ trials, complete }) =>
        complete
          ? number(trials.reduce((sum, it) => sum + (it.tokensUsed ?? 0), 0))
          : "—",
    },
    {
      name: "Tokens / iteration",
      value: ({ metrics }) => number(metrics?.tokens),
    },
    { name: "Tool calls", value: ({ metrics }) => number(metrics?.toolCalls) },
    {
      name: "Cost",
      value: ({ metrics }) =>
        metrics?.costUsd != null && metrics.costedIterations === metrics.total
          ? `$${metrics.costUsd.toFixed(4)}`
          : "—",
    },
    {
      name: "Servers",
      value: ({ run }) =>
        run.configSnapshot?.environment?.servers.join(", ") || "—",
    },
    {
      name: "Configuration revision",
      value: ({ run }) => run.configRevision || "—",
    },
    { name: "Source", value: ({ run }) => run.source || "—" },
    {
      name: "Iteration data loaded",
      value: ({ run, trials }) =>
        `${trials.length} / ${run.summary?.total ?? "unknown"}`,
    },
  ];
  const cases = new Map<string, string>();
  columns.forEach(({ trials }) =>
    trials.forEach((it) =>
      cases.set(caseKey(it), it.testCaseSnapshot?.title || caseKey(it)),
    ),
  );
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="run-comparison-page"
    >
      <header className="space-y-4 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back to run
          </Button>
          <div>
            <h2 className="text-xl font-semibold">Compare runs</h2>
            <p className="text-xs text-muted-foreground">{suiteName}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-4" aria-label="Runs to compare">
          {options.map((run) => (
            <label key={run._id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(run._id)}
                onCheckedChange={(checked) =>
                  setSelected((ids) =>
                    checked
                      ? [...ids, run._id]
                      : ids.filter((id) => id !== run._id),
                  )
                }
              />
              {label(run)} ·{" "}
              {runHostLabel(run, hostNamesById) ?? "Unknown client"}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Each column is one run. — means unavailable or incomplete; cost
          appears only when every iteration is priced.
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {columns.length ? (
          <table
            className="w-full border-collapse text-sm"
            aria-label="Run comparison"
          >
            <thead className="sticky top-0 z-20 bg-background">
              <tr>
                <th className="sticky left-0 z-20 min-w-48 border-b border-border bg-background p-4 text-left">
                  Metric
                </th>
                {columns.map(({ run }) => (
                  <th
                    key={run._id}
                    className="min-w-60 border-b border-l border-border p-4 text-left"
                  >
                    <Button
                      variant="link"
                      className="h-auto p-0 font-semibold"
                      onClick={() => onOpenRun(run._id)}
                    >
                      {label(run)}
                      {run._id === currentRun._id ? " · Current run" : ""}
                    </Button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} className="border-b border-border/60">
                  <th
                    scope="row"
                    className="sticky left-0 bg-background px-4 py-3 text-left font-medium"
                  >
                    {row.name}
                  </th>
                  {columns.map((column) => (
                    <td
                      key={column.run._id}
                      className="border-l border-border/60 px-4 py-3 tabular-nums"
                    >
                      {row.value(column)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th
                  colSpan={columns.length + 1}
                  className="bg-muted/40 px-4 py-4 text-left"
                >
                  Case results · passed / total · latency P50 / P95
                </th>
              </tr>
              {[...cases].map(([id, title]) => (
                <tr key={id} className="border-b border-border/60">
                  <th
                    scope="row"
                    className="sticky left-0 max-w-64 bg-background px-4 py-3 text-left font-medium"
                  >
                    {title}
                  </th>
                  {columns.map(({ run, trials }) => {
                    const matches = trials.filter((it) => caseKey(it) === id);
                    const summary = computeIterationSummary(matches);
                    return (
                      <td
                        key={run._id}
                        className="border-l border-border/60 px-4 py-3 tabular-nums"
                      >
                        {matches.length
                          ? `${summary.passed}/${matches.length} passed · ${duration(iterationLatencyP50(matches))} / ${duration(iterationLatencyP95(matches))}`
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            Select runs to compare.
          </p>
        )}
      </div>
    </section>
  );
}
