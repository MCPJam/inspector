import { ChevronDown, Code, Play } from "lucide-react";
import {
  EXAMPLE_RUNS,
  EXAMPLE_SUITE,
  EXAMPLE_THRESHOLD,
  averagePassRate,
  passRate,
} from "./tour-example-data";
import {
  ExampleDataPill,
  FakeButton,
  StatusTag,
  TourBreadcrumb,
} from "./tour-screen-chrome";

const TABLE_ROWS = 3;

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

function RunsChart() {
  const latest = EXAMPLE_RUNS[EXAMPLE_RUNS.length - 1];
  const latestRate = passRate(latest);
  const latestPassed = latestRate >= EXAMPLE_THRESHOLD;
  return (
    <div className="space-y-3 rounded-xl bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="flex items-baseline gap-2">
          <span className="text-4xl font-semibold tracking-[-0.03em] text-foreground">
            {averagePassRate(EXAMPLE_RUNS)}%
          </span>
          <span className="text-sm text-muted-foreground">
            average across the last {EXAMPLE_RUNS.length} runs
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Last run{" "}
          <span className="font-semibold text-foreground">
            #{latest.number}
          </span>{" "}
          ·{" "}
          <span className={latestPassed ? "text-success" : "text-destructive"}>
            {latestPassed ? "Passed" : "Failed"} {latestRate}%
          </span>{" "}
          · {latest.passed}/{latest.total} passed
        </p>
      </div>
      <div className="grid grid-cols-[36px_1fr] gap-2">
        <div className="relative h-32 text-[10px] text-muted-foreground">
          <span className="absolute top-0">100%</span>
          <span
            className="absolute text-primary"
            style={{ bottom: `calc(${EXAMPLE_THRESHOLD}% - 6px)` }}
          >
            {EXAMPLE_THRESHOLD}%
          </span>
          <span className="absolute bottom-0">0%</span>
        </div>
        <div className="relative h-32">
          <div
            className="absolute inset-x-0 border-t border-dashed border-primary/60"
            style={{ bottom: `${EXAMPLE_THRESHOLD}%` }}
          />
          <div className="flex h-full items-end gap-2">
            {EXAMPLE_RUNS.map((run) => (
              <div
                key={run.number}
                className="flex-1 rounded-t-sm bg-primary/75"
                style={{ height: `${passRate(run)}%` }}
              />
            ))}
          </div>
        </div>
        <span />
        <div className="flex gap-2 text-center text-[11px] text-muted-foreground">
          {EXAMPLE_RUNS.map((run) => (
            <span key={run.number} className="flex-1">
              {run.date}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The suite's home: pass rate over time and the latest runs. */
export function TourMonitorScreen() {
  const rows = [...EXAMPLE_RUNS].reverse().slice(0, TABLE_ROWS);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TourBreadcrumb
        crumbs={[{ label: "Evaluate" }, { label: EXAMPLE_SUITE.name }]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">
              {EXAMPLE_SUITE.name}
            </h1>
            <Chip>Claude Haiku 4.5</Chip>
            <Chip>MCPJam</Chip>
            <ExampleDataPill />
          </div>
          <div className="flex items-center gap-2">
            <FakeButton>
              <Code className="h-3.5 w-3.5" aria-hidden />
              Export as SDK
            </FakeButton>
            <FakeButton>Suite settings</FakeButton>
            <FakeButton variant="primary">
              <Play className="h-3.5 w-3.5" aria-hidden />
              Run
            </FakeButton>
          </div>
        </div>
        <div
          data-tour-anchor="monitor-runs"
          className="rounded-xl border border-border"
        >
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm font-medium text-foreground">Runs</span>
            <div className="flex gap-1.5">
              {["Client", "Model"].map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground"
                >
                  {label}
                  <ChevronDown className="h-3 w-3" aria-hidden />
                </span>
              ))}
            </div>
          </div>
          <div className="px-2 pb-2">
            <RunsChart />
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-y border-border text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                {["Run", "Client", "Model", "Result", "Rate", "Date"].map(
                  (heading) => (
                    <th key={heading} className="px-4 py-2 font-medium">
                      {heading}
                    </th>
                  ),
                )}
                <th className="px-4 py-2 text-right font-medium">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((run) => {
                const rate = passRate(run);
                return (
                  <tr key={run.number} className="text-foreground">
                    <td className="px-4 py-2.5 font-semibold">#{run.number}</td>
                    <td className="px-4 py-2.5">{run.client}</td>
                    <td className="px-4 py-2.5">{run.model}</td>
                    <td className="px-4 py-2.5">
                      <StatusTag
                        status={rate >= EXAMPLE_THRESHOLD ? "passed" : "failed"}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      {rate}%{" "}
                      <span className="text-muted-foreground">
                        {run.passed}/{run.total}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {run.date}, {run.time}
                    </td>
                    <td className="px-4 py-2.5 text-right">{run.latency}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
