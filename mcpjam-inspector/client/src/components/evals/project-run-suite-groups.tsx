import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { TableCell, TableRow } from "@mcpjam/design-system/table";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Button } from "@mcpjam/design-system/button";
import type { ProjectRunRow } from "./project-runs-table";
import type { ProjectRunHistoryDetail } from "./use-project-run-history";
import { resultCounts } from "../evaluate/run-results-matrix-model";
import { computeRunEffectiveStats } from "./suite-runs-list";
import { RunClientsCell } from "./run-clients-cell";
import {
  readRunGitMetadata,
  RunBranchCell,
  RunCommitCell,
  RunPlatformBadge,
  RunPullRequestCell,
  type RunGitMetadataValue,
} from "./run-git-metadata";
import { resolveRunOrigin } from "@/lib/evals/run-origin";
import {
  buildSuiteRunHistoryAggregates,
  formatRunHistoryDate,
  formatRunHistoryDateRange,
  formatRunHistoryMetric,
  type SuiteRunHistoryRow,
} from "../evaluate/suite-detail-model";

export function groupProjectRuns(
  rows: ProjectRunRow[],
  details: Map<string, ProjectRunHistoryDetail>,
) {
  const suites = new Map<string, ProjectRunRow[]>();
  for (const row of [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || b.runNumber - a.runNumber,
  )) {
    const suite = suites.get(row.suiteId) ?? [];
    suite.push(row);
    suites.set(row.suiteId, suite);
  }
  return [...suites].map(([suiteId, suiteRows]) => {
    const launches = new Map<string, ProjectRunRow[]>();
    for (const row of suiteRows) {
      const groupId = details.get(row._id)?.run.runGroupId;
      const key = groupId ? `group:${groupId}` : `run:${row._id}`;
      const launch = launches.get(key) ?? [];
      launch.push(row);
      launches.set(key, launch);
    }
    return {
      suiteId,
      rows: suiteRows,
      launches: [...launches].map(([key, runs]) => ({ key, runs })),
    };
  });
}

/** Withhold incomplete roll-ups, and weight pass rates by iterations, not runs. */
export function projectRunRollup(
  rows: ProjectRunRow[],
  details: Map<string, ProjectRunHistoryDetail>,
) {
  if (rows.some((row) => !details.has(row._id))) return null;
  const runs = rows.map((row) => details.get(row._id)!.run);
  const iterations = rows.flatMap((row) => details.get(row._id)!.iterations);
  let total = 0;
  let passed = 0;
  for (const row of rows) {
    const detail = details.get(row._id)!;
    if (detail.iterations.length) {
      const counts = resultCounts(detail.iterations);
      total += detail.iterations.length;
      passed += counts.passed;
    } else {
      const stats = computeRunEffectiveStats(detail.run, detail.iterations);
      total += stats.effectiveTotal;
      passed += stats.effectivePassed;
    }
  }
  return {
    ...buildSuiteRunHistoryAggregates(runs, iterations),
    total,
    passed,
    passRate: total > 0 ? Math.round((passed / total) * 100) : null,
    toolCalls:
      iterations.reduce(
        (sum, iteration) => sum + (iteration.actualToolCalls?.length ?? 0),
        0,
      ) || null,
  };
}

type Group = ReturnType<typeof groupProjectRuns>[number];
type SharedProps = {
  details: Map<string, ProjectRunHistoryDetail>;
  historyRows: Map<string, SuiteRunHistoryRow>;
  showGitContext: boolean;
};

export function ProjectRunSuiteGroup({
  group,
  expanded,
  onToggle,
  loading = false,
  renderRun,
  onSelectRun,
  ...shared
}: SharedProps & {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
  loading?: boolean;
  renderRun: (row: ProjectRunRow) => ReactNode;
  onSelectRun: (target: { suiteId: string; runId: string }) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const ready = group.rows.every((row) => shared.details.has(row._id));
  const suiteName = group.rows[0].suiteName ?? "Deleted suite";
  const servers = [
    ...new Set(
      group.rows.flatMap(
        (row) =>
          shared.details.get(row._id)?.run.configSnapshot?.environment
            ?.servers ?? [],
      ),
    ),
  ];
  const visibleLaunches = showAll ? group.launches : group.launches.slice(0, 5);
  return (
    <>
      <GroupSummaryRow
        {...shared}
        rows={group.rows}
        label={suiteName}
        detail={
          !ready
            ? loading
              ? "Loading runs…"
              : "Run details unavailable"
            : `${group.launches.length} run${
                group.launches.length === 1 ? "" : "s"
              }${servers.length ? ` · ${servers.join(", ")}` : ""}`
        }
        expanded={expanded}
        onToggle={onToggle}
        suite
        runCount={group.launches.length}
      />
      {expanded && !ready && (
        <TableRow>
          <TableCell
            colSpan={9 + (shared.showGitContext ? 3 : 0)}
            className="h-16 px-7"
          >
            {loading ? (
              <div role="status" aria-label={`Loading runs for ${suiteName}`}>
                <Skeleton className="h-4 w-48" />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                Unable to load runs. Retry above.
              </span>
            )}
          </TableCell>
        </TableRow>
      )}
      {expanded &&
        ready &&
        visibleLaunches.map((launch) => {
          if (launch.runs.length === 1)
            return (
              <Fragment key={launch.key}>{renderRun(launch.runs[0])}</Fragment>
            );
          const representative = [...launch.runs].sort(
            (a, b) => a.runNumber - b.runNumber || a._id.localeCompare(b._id),
          )[0];
          return (
            <GroupSummaryRow
              key={launch.key}
              {...shared}
              rows={launch.runs}
              label={`#${representative.runNumber}`}
              date={formatRunHistoryDate(representative.createdAt)}
              onOpen={
                representative.suiteName !== null
                  ? () =>
                      onSelectRun({
                        suiteId: representative.suiteId,
                        runId: representative._id,
                      })
                  : undefined
              }
            />
          );
        })}
      {expanded && ready && group.launches.length > 5 && (
        <TableRow>
          <TableCell colSpan={9 + (shared.showGitContext ? 3 : 0)}>
            <Button
              variant="ghost"
              size="sm"
              className="ml-5 h-7 text-xs"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll
                ? "Show fewer runs"
                : `Show all ${group.launches.length} runs in ${suiteName}`}
            </Button>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function GroupSummaryRow({
  rows,
  details,
  historyRows,
  showGitContext,
  label,
  detail,
  date,
  expanded,
  onToggle,
  suite = false,
  runCount = 1,
  onOpen,
  testId,
}: SharedProps & {
  rows: ProjectRunRow[];
  label: string;
  detail?: string;
  date?: string;
  expanded?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
  testId?: string;
  runCount?: number;
  suite?: boolean;
}) {
  const rollup = projectRunRollup(rows, details);
  const active = rows.filter((row) =>
    ["pending", "running", "grading"].includes(row.status),
  ).length;
  const sources = [
    ...new Set(rows.map((row) => row.source ?? row.suiteSource ?? "ui")),
  ];
  const gitRows = rows.map((row) => {
    const origin = resolveRunOrigin(row);
    return origin === "github_check" || origin === "github_action"
      ? readRunGitMetadata(row.ciMetadata)
      : null;
  });
  const firstGit = gitRows[0] ?? null;
  const allGithub = gitRows.length > 0 && gitRows.every(Boolean);
  const sharedPair = (
    value: keyof RunGitMetadataValue,
    url: keyof RunGitMetadataValue,
  ) =>
    !suite &&
    allGithub &&
    firstGit?.[value] &&
    firstGit?.[url] &&
    gitRows.every(
      (git) => git?.[value] === firstGit[value] && git?.[url] === firstGit[url],
    );
  const sharedGit: RunGitMetadataValue | null = firstGit
    ? {
        ...firstGit,
        commitSha: sharedPair("commitSha", "commitUrl")
          ? firstGit.commitSha
          : null,
        commitUrl: sharedPair("commitSha", "commitUrl")
          ? firstGit.commitUrl
          : null,
        pullRequestNumber: sharedPair("pullRequestNumber", "pullRequestUrl")
          ? firstGit.pullRequestNumber
          : null,
        pullRequestUrl: sharedPair("pullRequestNumber", "pullRequestUrl")
          ? firstGit.pullRequestUrl
          : null,
        branch: sharedPair("branch", "branchUrl") ? firstGit.branch : null,
        branchUrl: sharedPair("branch", "branchUrl")
          ? firstGit.branchUrl
          : null,
      }
    : null;
  const Icon = expanded ? ChevronDown : ChevronRight;
  const dateLabel =
    date ??
    (rows.length > 0
      ? formatRunHistoryDateRange(
          Math.min(...rows.map((row) => row.createdAt)),
          Math.max(...rows.map((row) => row.createdAt)),
        )
      : undefined);
  return (
    <TableRow
      data-testid={testId}
      className={
        suite
          ? "[&_td]:bg-accent [&_td]:border-y [&_td]:border-border"
          : onOpen
            ? "cursor-pointer"
            : undefined
      }
      {...(onOpen
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": label,
            onClick: onOpen,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {suite ? (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} suite ${label}`}
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex items-center gap-2 rounded-sm text-left focus-visible:outline-ring"
          >
            <Icon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </button>
        ) : (
          dateLabel
        )}
      </TableCell>
      <TableCell className="max-w-80">
        {suite ? (
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold">
              {label}
            </span>
            {detail ? (
              <span
                className="mt-1 block truncate text-[10px] text-muted-foreground"
                title={detail}
              >
                {detail}
              </span>
            ) : null}
          </span>
        ) : (
          <div className="pl-5">
            <span className="block text-xs font-medium">{label}</span>
          </div>
        )}
      </TableCell>
      <TableCell>
        <RunClientsCell
          rows={rows.flatMap((row) => historyRows.get(row._id) ?? [])}
        />
      </TableCell>
      {showGitContext && (
        <>
          <TableCell>
            <RunCommitCell git={sharedGit} />
          </TableCell>
          <TableCell>
            <RunPullRequestCell git={sharedGit} />
          </TableCell>
          <TableCell>
            <RunBranchCell git={sharedGit} />
          </TableCell>
        </>
      )}
      <TableCell className="text-[10px] text-muted-foreground">
        {!rollup
          ? "—"
          : active
            ? "In progress"
            : suite
              ? `${runCount} finished`
              : "Finished"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-semibold">
          {rollup?.passRate != null ? `${rollup.passRate}%` : "—"}
        </span>
        {rollup && rollup.total > 0 && (
          <span className="mt-1 block text-[10px] text-muted-foreground">
            {rollup.passed}/{rollup.total} passed
          </span>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatRunHistoryMetric(rollup?.latencyP50 ?? null, "duration")}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatRunHistoryMetric(rollup?.totalTokens ?? null, "number")}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatRunHistoryMetric(rollup?.toolCalls ?? null, "number")}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {sources.map((source) => (
            <RunPlatformBadge key={source} run={{ source }} />
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}
