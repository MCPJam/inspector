import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { cn } from "@/lib/utils";
import { runClientIdentity } from "../evals/helpers";
import {
  resolveRunOrigin,
  resolveRunOriginDetail,
  runOriginTitle,
  RUN_ORIGIN_META,
} from "@/lib/evals/run-origin";
import { RunClientsCell } from "../evals/run-clients-cell";
import {
  RunCommitCell,
  readRunGitMetadata,
  type RunGitMetadataValue,
} from "../evals/run-git-metadata";
import { projectRunRollup } from "../evals/project-run-suite-groups";
import { runEffectiveOutcome } from "../evals/project-runs-table";
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
          "Client",
          "Model",
          "Result",
          "Rate",
          "Platform",
          "Commit",
          "Date",
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

/**
 * Stored outcomes only: a percentage is not enough to infer a run's verdict.
 *
 * Read through `runEffectiveOutcome`, the same rule the single-run rows use,
 * so a run that recorded `cancelled`, `timed_out` or `inconclusive` in its
 * `result` is reported as decided rather than as having no result at all.
 */
export function historyResult(rows: readonly ProjectRunRow[]): string {
  if (rows.length === 0) return "No result";
  const outcomes = rows.map(runEffectiveOutcome);
  if (outcomes.some((it) => it === "running" || it === "pending"))
    return "Running";
  if (outcomes.some((it) => it === "grading")) return "Grading";
  if (outcomes.some((it) => it === "failed")) return "Failed";
  if (outcomes.some((it) => it === "timed_out")) return "Timed out";
  if (outcomes.some((it) => it === "cancelled")) return "Cancelled";
  // A real verdict, and NOT a failure: the run could not be measured well
  // enough to decide. Named rather than folded into either side.
  if (outcomes.some((it) => it === "inconclusive")) return "Inconclusive";
  if (outcomes.every((it) => it === "passed")) return "Passed";
  return "No result";
}

/** One glyph for every absent measurement in the row. */
const MISSING = "—";

/**
 * A measurement this row does not have yet is NOT a missing one. `MISSING`
 * means "no such value" everywhere else in the table, so showing it while the
 * run's detail is still in flight reports a zero that was never measured.
 */
function metricCell(
  value: number | null | undefined,
  kind: "number" | "duration",
  pending: boolean,
  width: string,
) {
  if (value != null) return formatRunHistoryMetric(value, kind);
  return pending ? <Skeleton className={cn("h-3", width)} /> : MISSING;
}

function historyTimestamp(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** One row per launch, preserving fan-out client/model pairs and loaded-data gaps. */
export function EvaluateHistoryRow({
  rows,
  details,
  historyRows,
  hostNamesById,
  showSuite = false,
  onOpen,
  testId,
  highlighted = false,
  loading = false,
}: {
  rows: ProjectRunRow[];
  details: Map<string, ProjectRunHistoryDetail>;
  /**
   * More run detail is still on its way. Only then is an absent measurement
   * reported as loading rather than as absent.
   */
  loading?: boolean;
  historyRows: Map<string, SuiteRunHistoryRow>;
  /** Current names for named hosts, so a renamed host is not shown stale. */
  hostNamesById?: ReadonlyMap<string, string | null>;
  showSuite?: boolean;
  onOpen?: () => void;
  testId?: string;
  highlighted?: boolean;
}) {
  const representative = [...rows].sort(
    (a, b) => a.runNumber - b.runNumber || a._id.localeCompare(b._id),
  )[0];
  if (!representative) return null;
  const rollup = projectRunRollup(rows, details);
  // This row's own detail, not the table's: a page that has landed is
  // reported in full even while later pages are still loading.
  const pending = loading && rows.some((row) => !details.has(row._id));
  const result = historyResult(rows);
  // Parsed once per row and carried: the dedup key and the chips below read
  // the same value rather than re-parsing the CI metadata.
  const commits: { row: ProjectRunRow; git: RunGitMetadataValue | null }[] = [
    ...new Map(
      rows.map((row) => {
        const git = readRunGitMetadata(row.ciMetadata);
        return [
          JSON.stringify([
            resolveRunOrigin(row),
            git?.repository,
            git?.commitSha,
            git?.commitUrl,
          ]),
          { row, git },
        ] as const;
      }),
    ).values(),
  ];
  // The platform cell names WHERE the run came from, so it is keyed by origin
  // alone. Keying it by commit as well printed "GitHub Actions" once per
  // distinct commit in a launch that fanned out over several.
  const platforms = [
    ...new Map(
      rows.map((row) => [resolveRunOrigin(row) ?? "ui", row]),
    ).values(),
  ];
  const createdAt = historyTimestamp(representative.createdAt);
  const clientRows = rows.map(
    (row) =>
      historyRows.get(row._id) ?? {
        client: runClientIdentity(
          { client: row.client, namedHostId: row.namedHostId ?? undefined },
          hostNamesById,
        ).name,
        hostStyle: row.client?.hostStyle,
        models: row.client?.modelId ? [row.client.modelId] : [],
      },
  );
  return (
    <TableRow
      data-testid={testId}
      data-highlighted={highlighted || undefined}
      className={cn(onOpen && "cursor-pointer", highlighted && "bg-muted/50")}
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
        <RunClientsCell rows={clientRows} column="client" />
      </TableCell>
      <TableCell>
        {pending && clientRows.every((row) => !row.models?.length) ? (
          <Skeleton className="h-3 w-24" />
        ) : (
          <RunClientsCell rows={clientRows} column="model" />
        )}
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
        className="whitespace-nowrap tabular-nums"
        title={
          rollup && rollup.total > 0
            ? `${rollup.passed}/${rollup.total} passed`
            : undefined
        }
      >
        <span>
          {rollup?.passRate != null ? (
            `${rollup.passRate}%`
          ) : pending ? (
            <Skeleton className="h-3 w-11" />
          ) : (
            MISSING
          )}
        </span>
        {/* Rendered, not just a tooltip: the counts behind the percentage are
            unreachable on touch and to a screen reader when they live in a
            `title` alone. */}
        {rollup && rollup.total > 0 ? (
          <span className="ml-1 text-[10px] text-muted-foreground">
            {rollup.passed}/{rollup.total}
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          {platforms.map((row) => {
            const resolved = resolveRunOriginDetail(row);
            return (
              <span
                key={row._id}
                className="text-muted-foreground"
                title={runOriginTitle(resolved?.origin, resolved?.basis)}
              >
                {RUN_ORIGIN_META[resolved?.origin ?? "ui"].label}
              </span>
            );
          })}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          {commits.map(({ row, git }) => (
            <RunCommitCell key={row._id} git={git} />
          ))}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {/* An unset or nonsensical timestamp is one missing cell, never a
            `toISOString()` that throws and unmounts the whole table. */}
        {createdAt == null ? (
          MISSING
        ) : (
          <time dateTime={new Date(createdAt).toISOString()}>
            {new Date(createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        )}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {metricCell(rollup?.latencyP50, "duration", pending, "w-9")}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {metricCell(rollup?.totalTokens, "number", pending, "w-9")}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {metricCell(rollup?.toolCalls, "number", pending, "w-5")}
      </TableCell>
    </TableRow>
  );
}
