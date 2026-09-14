import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { cn } from "@/lib/utils";
import { compactMetric, runClientIdentity } from "../evals/helpers";
import { resolveRunOrigin } from "@/lib/evals/run-origin";
import { RunClientsCell } from "../evals/run-clients-cell";
import {
  RunCommitCell,
  RunPlatformBadge,
  readRunGitMetadata,
} from "../evals/run-git-metadata";
import { projectRunRollup } from "../evals/project-run-suite-groups";
import type { ProjectRunRow } from "../evals/project-runs-table";
import type { ProjectRunHistoryDetail } from "../evals/use-project-run-history";
import {
  formatRunHistoryMetric,
  type SuiteRunHistoryRow,
} from "./suite-detail-model";

export function EvaluateHistoryHeader({
  showSuite = false,
}: {
  showSuite?: boolean;
}) {
  return (
    <TableHeader>
      <TableRow>
        {[
          "Run",
          ...(showSuite ? ["Suite"] : []),
          "Client / Model",
          "Result",
          "Rate",
          "Platform",
          "When",
          "Latency",
          "Tokens",
          "Calls",
        ].map((label) => (
          <TableHead key={label} className="whitespace-nowrap">
            {label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** Stored outcomes only: a percentage is not enough to infer a run's verdict. */
export function historyResult(rows: readonly ProjectRunRow[]): string {
  if (rows.some((row) => row.status === "running" || row.status === "pending"))
    return "Running";
  if (rows.some((row) => row.status === "grading")) return "Grading";
  if (rows.some((row) => row.result === "failed" || row.status === "failed"))
    return "Failed";
  if (rows.some((row) => row.status === "timed_out")) return "Timed out";
  if (rows.some((row) => row.status === "cancelled")) return "Cancelled";
  if (rows.length > 0 && rows.every((row) => row.result === "passed"))
    return "Passed";
  return "No result";
}

/** One row per launch, preserving fan-out client/model pairs and loaded-data gaps. */
export function EvaluateHistoryRow({
  rows,
  details,
  historyRows,
  showSuite = false,
  onOpen,
  testId,
}: {
  rows: ProjectRunRow[];
  details: Map<string, ProjectRunHistoryDetail>;
  historyRows: Map<string, SuiteRunHistoryRow>;
  showSuite?: boolean;
  onOpen?: () => void;
  testId?: string;
}) {
  const representative = [...rows].sort(
    (a, b) => a.runNumber - b.runNumber || a._id.localeCompare(b._id),
  )[0];
  if (!representative) return null;
  const rollup = projectRunRollup(rows, details);
  const result = historyResult(rows);
  const platforms = [
    ...new Map(
      rows.map((row) => {
        const git = readRunGitMetadata(row.ciMetadata);
        return [
          JSON.stringify([
            resolveRunOrigin(row),
            git?.repository,
            git?.commitSha,
          ]),
          row,
        ];
      }),
    ).values(),
  ];
  const measuredCalls = rows
    .flatMap((row) => details.get(row._id)?.iterations ?? [])
    .flatMap((iteration) =>
      iteration.actualToolCalls != null
        ? [iteration.actualToolCalls.length]
        : [],
    );
  const calls =
    rollup && measuredCalls.length
      ? measuredCalls.reduce((sum, count) => sum + count, 0)
      : null;
  const measuredTokens = rows
    .flatMap((row) => details.get(row._id)?.iterations ?? [])
    .flatMap((iteration) =>
      typeof iteration.tokensUsed === "number" &&
      Number.isFinite(iteration.tokensUsed)
        ? [iteration.tokensUsed]
        : [],
    );
  const tokens =
    rollup && measuredTokens.length
      ? measuredTokens.reduce((sum, count) => sum + count, 0)
      : null;
  return (
    <TableRow
      data-testid={testId}
      className={cn(onOpen && "cursor-pointer")}
      {...(onOpen
        ? {
            tabIndex: 0,
            role: "button",
            "aria-label": `Open run #${representative.runNumber}`,
            onClick: onOpen,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      <TableCell className="font-semibold">
        #{representative.runNumber}
      </TableCell>
      {showSuite && (
        <TableCell className="max-w-64 truncate font-medium">
          {representative.suiteName ?? "Deleted suite"}
        </TableCell>
      )}
      <TableCell>
        <RunClientsCell
          rows={rows.map(
            (row) =>
              historyRows.get(row._id) ?? {
                client: runClientIdentity({
                  client: row.client,
                  namedHostId: row.namedHostId ?? undefined,
                }).name,
                hostStyle: row.client?.hostStyle,
                models: row.client?.modelId ? [row.client.modelId] : [],
              },
          )}
        />
      </TableCell>
      <TableCell>
        <span
          className={cn(
            "whitespace-nowrap rounded px-1.5 py-1 text-[10px] font-semibold uppercase",
            result === "Passed"
              ? "bg-success/15 text-foreground"
              : result === "Failed"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
          )}
        >
          {result}
        </span>
      </TableCell>
      <TableCell
        className="tabular-nums"
        title={
          rollup && rollup.total > 0
            ? `${rollup.passed}/${rollup.total} passed`
            : undefined
        }
      >
        {rollup?.passRate != null ? `${rollup.passRate}%` : "—"}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          {platforms.map((row) => (
            <span key={row._id} className="inline-flex items-center gap-2">
              <RunPlatformBadge run={row} />
              {row.ciMetadata && (
                <RunCommitCell git={readRunGitMetadata(row.ciMetadata)} />
              )}
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        <time dateTime={new Date(representative.createdAt).toISOString()}>
          {new Date(representative.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {formatRunHistoryMetric(rollup?.latencyP50 ?? null, "duration")}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {tokens != null ? compactMetric(tokens) : "—"}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {calls != null ? compactMetric(calls) : "—"}
      </TableCell>
    </TableRow>
  );
}
