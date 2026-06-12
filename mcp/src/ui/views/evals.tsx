/**
 * Eval widget views: suite overview, suite run history, single-run status,
 * and per-iteration results. All render the payloads emitted by the
 * corresponding catalog operations unchanged — no extra fetching.
 */
import { Badge } from "@mcpjam/design-system/badge";
import { Card } from "@mcpjam/design-system/card";
import { cn } from "@mcpjam/design-system/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import type {
  GetEvalRunResult,
  ListEvalRunIterationsResult,
  ListEvalSuiteRunsResult,
  ListEvalSuitesResult,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformEvalRunSummary,
  PlatformEvalSuite,
} from "@mcpjam/sdk/platform";
import { Fragment, type ReactNode, useState } from "react";
import { MessageBox } from "../shared/app-shell.js";
import {
  formatDurationMs,
  formatInteger,
  formatPercent,
  formatTimestamp,
} from "../shared/format.js";
import {
  CopyIconButton,
  OutcomeBadge,
  PassRateSparkline,
  StatTile,
  ViewHeader,
} from "./atoms.js";

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

export function EvalSuitesView({
  isDark,
  payload,
}: {
  isDark: boolean;
  payload: ListEvalSuitesResult;
}) {
  const suites = payload.items;

  return (
    <>
      <ViewHeader
        title={payload.project.name}
        badgeLabel={`${suites.length} ${suites.length === 1 ? "eval suite" : "eval suites"}`}
        isDark={isDark}
      />

      {suites.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {suites.map((suite) => (
            <EvalSuiteCard key={suite.id} suite={suite} />
          ))}
        </section>
      ) : (
        <MessageBox
          label="No eval suites"
          message="This project has no eval suites."
        />
      )}
    </>
  );
}

function EvalSuiteCard({ suite }: { suite: PlatformEvalSuite }) {
  const latestRun = suite.latestRun;
  const latestRunAt = formatTimestamp(latestRun?.createdAt);

  return (
    <Card className="h-full rounded-xl border border-border/50 bg-card/60 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {suite.name ?? "Untitled suite"}
        </h2>
        {latestRun ? (
          <OutcomeBadge
            status={latestRun.status}
            result={summaryResult(latestRun)}
            bare
          />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            Never run
          </span>
        )}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tabular-nums">
            {formatPercent(latestRun?.passRate) ?? "—"}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {latestRun
              ? `${formatInteger(latestRun.passed)} passed · ${formatInteger(latestRun.failed)} failed`
              : "No runs recorded"}
          </div>
        </div>
        <PassRateSparkline trend={suite.passRateTrend} />
      </div>

      <div className="mt-3 border-t border-border/50 pt-2 text-xs text-muted-foreground">
        <div>
          All time: {formatInteger(suite.totals.passed)} passed ·{" "}
          {formatInteger(suite.totals.failed)} failed ·{" "}
          {formatInteger(suite.totals.runs)}{" "}
          {suite.totals.runs === 1 ? "run" : "runs"}
        </div>
        {latestRunAt ? <div className="mt-0.5">Last run {latestRunAt}</div> : null}
      </div>
    </Card>
  );
}

export function EvalSuiteRunsView({
  isDark,
  payload,
}: {
  isDark: boolean;
  payload: ListEvalSuiteRunsResult;
}) {
  const runs = payload.items;

  return (
    <>
      <ViewHeader
        title={payload.suite.name ?? "Untitled suite"}
        badgeLabel={`${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
        caption={`Eval runs · ${payload.project.name}`}
        isDark={isDark}
      />

      {runs.length > 0 ? (
        <Card className="overflow-hidden rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Run</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Pass rate</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="pr-4">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id} title={run.notes ?? undefined}>
                  <TableCell className="px-4 font-mono text-xs">
                    {run.runNumber !== null ? `#${run.runNumber}` : "—"}
                  </TableCell>
                  <TableCell>
                    <OutcomeBadge status={run.status} result={run.result} bare />
                  </TableCell>
                  <TableCell>
                    <PassRateCell run={run} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{run.source}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(run.createdAt) ?? "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-xs text-muted-foreground tabular-nums">
                    {formatRunDuration(run) ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <MessageBox
          label="No runs"
          message="This suite has not been run yet."
        />
      )}
    </>
  );
}

function PassRateCell({ run }: { run: PlatformEvalRun }) {
  const percent = formatPercent(run.summary?.passRate);
  const passed = run.summary?.passed;
  const total = run.summary?.total;

  return (
    <span className="text-xs tabular-nums">
      {percent ?? "—"}
      {typeof passed === "number" && typeof total === "number" ? (
        <span className="ml-1 text-muted-foreground">
          ({passed}/{total})
        </span>
      ) : null}
    </span>
  );
}

export function EvalRunView({
  isDark,
  payload,
}: {
  isDark: boolean;
  payload: GetEvalRunResult;
}) {
  const run = payload.run;
  const isTerminal = TERMINAL_RUN_STATUSES.has(run.status);

  return (
    <>
      <ViewHeader
        title={run.runNumber !== null ? `Run #${run.runNumber}` : "Eval run"}
        accessory={<OutcomeBadge status={run.status} result={run.result} />}
        caption={`Eval run · ${payload.project.name}`}
        isDark={isDark}
      />

      {!isTerminal ? (
        <MessageBox
          label="In progress"
          message="This run has not finished — call get_eval_run again for fresh status."
        />
      ) : null}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total" value={formatInteger(run.summary?.total)} />
        <StatTile label="Passed" value={formatInteger(run.summary?.passed)} />
        <StatTile label="Failed" value={formatInteger(run.summary?.failed)} />
        <StatTile
          label="Pass rate"
          value={formatPercent(run.summary?.passRate) ?? "—"}
        />
      </section>

      <Card className="rounded-xl border border-border/50 bg-card/60 p-4 shadow-sm">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <MetaItem label="Started" value={formatTimestamp(run.createdAt)} />
          <MetaItem
            label="Completed"
            value={formatTimestamp(run.completedAt)}
          />
          <MetaItem label="Duration" value={formatRunDuration(run)} />
          <MetaItem label="Source" value={run.source} />
          <MetaItem
            label="Run ID"
            value={
              <span className="inline-flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-xs">{run.id}</span>
                <CopyIconButton value={run.id} label="Copy run ID" />
              </span>
            }
          />
          <MetaItem
            label="Suite ID"
            value={<span className="font-mono text-xs">{run.suiteId}</span>}
          />
          {run.notes ? (
            <MetaItem label="Notes" value={run.notes} className="sm:col-span-2" />
          ) : null}
        </dl>
      </Card>
    </>
  );
}

function MetaItem({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode | undefined;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{value ?? "—"}</dd>
    </div>
  );
}

export function EvalRunIterationsView({
  isDark,
  payload,
}: {
  isDark: boolean;
  payload: ListEvalRunIterationsResult;
}) {
  const iterations = payload.items;
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);

  return (
    <>
      <ViewHeader
        title="Run iterations"
        badgeLabel={`${iterations.length} shown`}
        caption={
          <>
            Run <span className="font-mono text-xs">{payload.runId}</span> ·{" "}
            {payload.project.name}
          </>
        }
        isDark={isDark}
      />

      {iterations.length > 0 ? (
        <Card className="overflow-hidden rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">#</TableHead>
                <TableHead>Test</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead className="pr-4">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {iterations.map((iteration) => (
                <Fragment key={iteration.id}>
                  <TableRow
                    onClick={() =>
                      setExpandedId((current) =>
                        current === iteration.id ? undefined : iteration.id
                      )
                    }
                    className="cursor-pointer"
                  >
                    <TableCell className="px-4 font-mono text-xs">
                      {iteration.iterationNumber}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-xs">
                      {iteration.title ?? iteration.testCaseId ?? "—"}
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge
                        status={iteration.status}
                        result={iteration.result}
                        bare
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {iteration.model ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {iteration.actualToolCalls.length}/
                      {iteration.expectedToolCalls.length}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatInteger(iteration.tokensUsed)}
                    </TableCell>
                    <TableCell className="pr-4 text-xs text-muted-foreground tabular-nums">
                      {formatDurationMs(iteration.durationMs) ?? "—"}
                    </TableCell>
                  </TableRow>
                  {expandedId === iteration.id ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="whitespace-normal px-4 pb-4">
                        <IterationDetail iteration={iteration} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <MessageBox
          label="No iterations"
          message="This run has no recorded iterations."
        />
      )}

      {payload.nextCursor ? (
        <p className="text-xs text-muted-foreground">
          More iterations available — call list_eval_run_iterations again with
          cursor set to fetch the next page.
        </p>
      ) : null}
    </>
  );
}

function IterationDetail({ iteration }: { iteration: PlatformEvalIteration }) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <ToolCallList
        label="Expected tool calls"
        names={toolCallNames(iteration.expectedToolCalls)}
      />
      <ToolCallList
        label="Actual tool calls"
        names={toolCallNames(iteration.actualToolCalls)}
      />
      {iteration.provider ? (
        <div>
          <div className="text-muted-foreground">Provider</div>
          <div className="mt-1">{iteration.provider}</div>
        </div>
      ) : null}
      {iteration.error ? (
        <div>
          <div className="text-muted-foreground">Error</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-destructive">
            {iteration.error}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolCallList({ label, names }: { label: string; names: string[] }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      {names.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {names.map((name, index) => (
            <span
              key={`${name}-${index}`}
              className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px]"
            >
              {name}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-1">None</div>
      )}
    </div>
  );
}

/**
 * Latest-run summaries carry counts but no verdict; derive one for completed
 * runs the way the platform does — any failure fails the run.
 */
function summaryResult(run: PlatformEvalRunSummary): string | null {
  if (run.status !== "completed") {
    return null;
  }
  if (typeof run.failed === "number" && run.failed > 0) {
    return "failed";
  }
  return typeof run.passed === "number" && run.passed > 0 ? "passed" : null;
}

function toolCallNames(calls: Array<Record<string, unknown>>): string[] {
  return calls.map((call) => {
    for (const key of ["toolName", "name", "tool"]) {
      const value = call[key];
      if (typeof value === "string" && value) {
        return value;
      }
    }
    return "unknown tool";
  });
}

function formatRunDuration(run: PlatformEvalRun): string | undefined {
  if (run.completedAt === null) {
    return undefined;
  }

  return formatDurationMs(run.completedAt - run.createdAt);
}
