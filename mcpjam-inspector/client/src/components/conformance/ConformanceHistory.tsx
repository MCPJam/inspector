/**
 * Conformance history, detail, and sharing — Convex-backed.
 *
 * `/conformance` remains the selected server's latest/history view. Durable
 * runs live at `/conformance/runs/:runId`. Public sharing is a separate
 * redacted artifact at `/conformance/shared/:token`.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/evals/LoadingState";
import { FlaskConical, Loader2 } from "lucide-react";
import { useOpenRunFromHistory, useRunBack } from "./conformance-run-origin";
import { SharedArtifactPage } from "@/components/sharing/SharedArtifactPage";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import { useSharedArtifact } from "@/hooks/useSharedArtifact";
import { useArtifactQuery } from "@/lib/artifact-urls";
import {
  OverallScoreCard,
  savedNotApplicableSubtitle,
  SUITE_COPY,
  SuiteRow,
  VerdictBadge,
} from "./conformance-ui";
import { CatalogList } from "./ConformanceCheckRows";
import { SuiteReportCases } from "./ConformanceSavedChecks";
import {
  ConformanceSourceVersion,
  SuiteList,
} from "./conformance-source-version";
import { ConformanceAdvice, reportAdviceGroups } from "./ConformanceAdvice";
import {
  useSavedRunReports,
  type LoadReport,
  type SavedReportCase,
} from "./use-saved-run-reports";
import type {
  SharedConformanceArtifact,
  SharedSuiteReport,
} from "./conformance-shared-artifact";
import { ConformanceVersionNotice } from "./ConformanceVersionNotice";
import {
  ConformanceHistoryTable,
  HISTORY_SOURCE_LABEL,
} from "./ConformanceHistoryTable";
import { ConformanceHistoryEmpty } from "./ConformanceHistoryEmpty";
import {
  ConformanceHistoryFilters,
  DEFAULT_HISTORY_SORT,
  isBackendHistoryOrder,
  searchAndSortHistory,
  type HistorySort,
} from "./ConformanceHistoryFilters";
import { conformanceVersionRefusal } from "./conformance-version-refusal";
import { conformanceRunTargetName } from "./conformance-run-target";
import { suiteCatalog } from "./conformance-catalogs";
import {
  SavedRunActions,
  SavedRunSettings,
  type SavedRunServerSettings,
} from "./ConformanceRunActions";

export type ConformanceRunListItem = {
  _id: string;
  projectId: string;
  targetKind: string;
  targetKey: string;
  serverId: string | null;
  source: string;
  verification: "mcpjam_verified" | "client_reported";
  status: string;
  outcome: "passed" | "failed" | "incomplete" | null;
  incompleteReason: string | null;
  score: number | null;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  /** Absent on rows read from a build that predates the field. */
  notApplicable?: number;
  advisoryCount?: number;
  requestedSuites: string[];
  protocolVersion: string | null;
  actorLabel: string | null;
  ciMetadata: {
    provider?: string;
    repository?: string;
    commitSha?: string;
    branch?: string;
    pullRequestNumber?: number;
    workflow?: string;
    job?: string;
    runUrl?: string;
    runId?: string;
  } | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  sharingEnabled: boolean;
};

export {
  HISTORY_SOURCE_LABEL,
  historyDateFormat,
} from "./ConformanceHistoryTable";

/**
 * The app's loading state (the evals one), centered in all the height left
 * below the toolbar, where the table will be.
 */
function HistoryLoader() {
  return (
    <div
      className="flex min-h-64 flex-1 items-center justify-center"
      role="status"
      data-testid="conformance-history-loading"
    >
      <LoadingState />
    </div>
  );
}

const NO_RUNS_TITLE = "No conformance runs yet";
const NO_RUNS_DESCRIPTION =
  "Runs from the Inspector, the CLI, GitHub, and the API land here.";

/** Runs per page while History shows the newest first. */
const HISTORY_PAGE_SIZE = 20;
/**
 * Runs per page while History reads every run. The backend matches runs by
 * server only and orders them newest first only, so search and every other
 * sort work on the whole history, not on the pages loaded so far.
 */
const HISTORY_READ_ALL_PAGE_SIZE = 100;

/**
 * Every conformance run in the project, newest first, as one table. A row
 * opens the run's detail page. Above it, a full-width search box with the
 * server filter at its right end; the Server, Score and Date headers sort.
 */
export function ConformanceHistory({
  projectId,
  serverNames,
}: {
  projectId: string;
  /** Saved server id → display name, for the Server column. */
  serverNames?: ReadonlyMap<string, string>;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<ConformanceRunListItem[]>([]);
  /** A saved server's id, or null for every server. */
  const [serverFilter, setServerFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<HistorySort>(DEFAULT_HISTORY_SORT);
  const openRun = useOpenRunFromHistory(projectId);

  const query = search.trim().toLowerCase();
  // Any order but the backend's needs every run. One server's runs all share
  // a name, though, so the name sort needs no more of them than are loaded.
  const readsEveryRun =
    query.length > 0 ||
    (!isBackendHistoryOrder(sort) &&
      !(sort.key === "server" && serverFilter !== null));
  /** History is paging forward on its own, on the large page. */
  const [readAll, setReadAll] = useState(false);
  /** Once there are runs, the toolbar stays up through every reload. */
  const [hadRuns, setHadRuns] = useState(false);
  /**
   * The rows as last shown with every run they needed, kept while a sort
   * reads the rest of the history so the table switches order only once.
   */
  const settled = useRef<{
    serverFilter: string | null;
    rows: ConformanceRunListItem[];
  } | null>(null);

  const page = useQuery(
    "conformanceRuns:listRuns" as any,
    projectId
      ? ({
          projectId,
          // The backend filters by server on its index, so a filtered list
          // pages through that server's runs alone.
          ...(serverFilter ? { targetKey: `server:${serverFilter}` } : {}),
          paginationOpts: {
            numItems: readAll ? HISTORY_READ_ALL_PAGE_SIZE : HISTORY_PAGE_SIZE,
            cursor,
          },
        } as any)
      : "skip",
  ) as
    | {
        page: ConformanceRunListItem[];
        isDone: boolean;
        continueCursor: string;
      }
    | undefined;

  // A list that is already complete has nothing left to read.
  if (readsEveryRun && !readAll && page && !page.isDone) setReadAll(true);
  // Paging forward leaves only the last page watched: once cleared, go back to
  // the first page, so new and finishing runs show again.
  if (!readsEveryRun && readAll) {
    setReadAll(false);
    setCursor(null);
  }
  if (rows.length > 0 && !hadRuns) setHadRuns(true);
  /** The page `rows` already holds; the query's newest can be a render ahead. */
  const [mergedPage, setMergedPage] = useState<typeof page>(undefined);

  useEffect(() => {
    if (!page) return;
    setRows((previous) => {
      if (cursor === null) return page.page;
      const seen = new Set(previous.map((row) => row._id));
      return [...previous, ...page.page.filter((row) => !seen.has(row._id))];
    });
    setMergedPage(page);
  }, [cursor, page]);

  // Search and the column sorts keep loading pages until the history is
  // complete.
  useEffect(() => {
    if (readAll && page && !page.isDone) setCursor(page.continueCursor);
  }, [readAll, page]);

  const serverLabel = (run: ConformanceRunListItem) =>
    conformanceRunTargetName(run, serverNames);

  const changeServerFilter = (next: string | null) => {
    if (next === serverFilter) return;
    // Another server is another list: start it from its first page.
    setServerFilter(next);
    setCursor(null);
    setRows([]);
    setReadAll(false);
  };

  // "Load more" changes the query's cursor, and the query reads undefined
  // again while that page loads: only the first page may replace the table.
  // Only the first load returns early: a reload keeps the toolbar and its focus.
  if (!hadRuns && serverFilter === null) {
    if (page === undefined && rows.length === 0) {
      return <HistoryLoader />;
    }

    if (rows.length === 0) {
      return (
        <ConformanceHistoryEmpty
          title={NO_RUNS_TITLE}
          description={NO_RUNS_DESCRIPTION}
        />
      );
    }
  }

  const sortedRows = searchAndSortHistory(rows, {
    query,
    sort,
    texts: (run) => [
      serverLabel(run),
      run.protocolVersion ?? "Auto",
      HISTORY_SOURCE_LABEL[run.source] ?? run.source,
    ],
    serverName: serverLabel,
    score: (run) => run.score,
    createdAt: (run) => run.createdAt,
  });
  // Also true on the render where a sort or search has just asked for every
  // run, before the large page is set, and on the one where the last page has
  // arrived but is not in `rows` yet: done then would sort without it.
  const readingEveryRun =
    readsEveryRun && !(page?.isDone && mergedPage === page);
  // A sort over part of the history leads with the wrong runs, then reorders
  // once the rest arrives. Keep the last complete order up, dimmed, until then.
  // A search narrows as pages arrive, so it shows them as they come.
  const holdOrder =
    readingEveryRun &&
    query.length === 0 &&
    settled.current !== null &&
    settled.current.serverFilter === serverFilter &&
    settled.current.rows.length > 0;
  const visibleRows =
    holdOrder && settled.current ? settled.current.rows : sortedRows;
  if (!readingEveryRun) settled.current = { serverFilter, rows: sortedRows };
  // A sort with no complete order of its own to hold (just switched servers,
  // say) would show part of the history in the wrong order: the loader waits
  // for all of it instead.
  const awaitingOrder = readingEveryRun && query.length === 0 && !holdOrder;
  const filteredServerName = serverFilter
    ? (serverNames?.get(serverFilter) ?? serverFilter)
    : null;

  return (
    <section
      className="flex flex-1 flex-col space-y-3"
      aria-label="Run history"
    >
      <ConformanceHistoryFilters
        search={search}
        onSearchChange={setSearch}
        serverFilter={serverFilter}
        onServerFilterChange={changeServerFilter}
        serverNames={serverNames}
      />

      {/* Always in the DOM, out of the flow: the sorted header's spinner is
          what sighted users see, so the table never shifts for this. */}
      <p className="sr-only" role="status">
        {readingEveryRun && rows.length > 0 && !awaitingOrder
          ? "Loading every run…"
          : ""}
      </p>

      {page === undefined && rows.length === 0 ? (
        <HistoryLoader />
      ) : rows.length === 0 ? (
        filteredServerName ? (
          <ConformanceHistoryEmpty
            title={`No runs for ${filteredServerName} yet`}
            description="Run a check on it, or clear the filter to see every server's runs."
            clear={{
              label: "Clear server filter",
              onClear: () => changeServerFilter(null),
            }}
          />
        ) : (
          <ConformanceHistoryEmpty
            title={NO_RUNS_TITLE}
            description={NO_RUNS_DESCRIPTION}
          />
        )
      ) : visibleRows.length === 0 || awaitingOrder ? (
        readingEveryRun ? (
          <HistoryLoader />
        ) : (
          <ConformanceHistoryEmpty
            title={`No runs match “${search.trim()}”`}
            description="Try another search, or clear it to see every run."
            clear={{ label: "Clear search", onClear: () => setSearch("") }}
          />
        )
      ) : (
        <ConformanceHistoryTable
          rows={visibleRows}
          sort={sort}
          onSort={setSort}
          loading={readingEveryRun}
          dimmed={holdOrder}
          serverLabel={serverLabel}
          onOpenRun={openRun}
        />
      )}

      {readsEveryRun || visibleRows.length === 0 ? null : page === undefined ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled
          aria-busy
        >
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Load more
        </Button>
      ) : !page.isDone ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setCursor(page.continueCursor)}
        >
          Load more
        </Button>
      ) : null}
    </section>
  );
}

export function ConformanceRunDetailPage({
  runId,
  serverNames,
  serverSettings,
  serversLoading = false,
}: {
  runId: string;
  projectId?: string | null;
  /** Saved server id → display name, for the breadcrumb and score card. */
  serverNames?: ReadonlyMap<string, string>;
  /** The servers' default checks, for Settings. Omit to hide Settings. */
  serverSettings?: SavedRunServerSettings;
  serversLoading?: boolean;
}) {
  const back = useRunBack();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Each report carries a short-lived artifact link.
  const detail = useArtifactQuery<
    | (ConformanceRunListItem & {
        reports: Array<{
          suiteKind: string;
          status: string;
          outcome: string | null;
          incompleteReason: string | null;
          score: number | null;
          applicable: number;
          passed: number;
          failed: number;
          couldNotRun: number;
          reportUrl?: string | null;
        }>;
        previous: ConformanceRunListItem | null;
        shareVersion: number;
      })
    | null
  >("conformanceRuns:getRun", runId ? { runId } : "skip");
  const { advice, loadReport, cases: versionCases } = useSavedRunReports(
    runId,
    detail?.reports ?? [],
  );
  if (detail === undefined) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Loading run…
      </p>
    );
  }
  if (detail === null) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="Run not found"
        description="This conformance run is missing or you do not have access."
      />
    );
  }

  // A saved server the project still has: Run again and Settings act on it.
  const savedServerName = detail.serverId
    ? serverNames?.get(detail.serverId)
    : undefined;
  const serverName = conformanceRunTargetName(detail, serverNames);
  const finished = detail.status === "completed";

  if (settingsOpen && savedServerName && serverSettings) {
    return (
      <SavedRunSettings
        key={detail.serverId ?? serverName}
        serverName={savedServerName}
        settings={serverSettings}
        onBack={() => setSettingsOpen(false)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The same chrome as a run on screen, so a saved run reads like it. */}
      <DetailPageHeader
        backLabel={back.label}
        onBack={back.onBack}
        backTestId="conformance-saved-run-back"
        stackWhenNarrow
        title={
          <h1
            className="truncate text-xl font-bold tracking-tight text-foreground"
            title={serverName}
          >
            {serverName}
          </h1>
        }
        actions={
          <SavedRunActions
            runId={detail._id}
            finished={finished}
            serverName={savedServerName}
            settings={serverSettings}
            serversLoading={serversLoading}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        }
      >
        <p className="text-sm text-muted-foreground">
          {detailDateFormat.format(detail.createdAt)} ·{" "}
          {HISTORY_SOURCE_LABEL[detail.source] ?? detail.source}
        </p>
      </DetailPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-8">
        <ConformanceVersionNotice refusal={conformanceVersionRefusal(versionCases, detail.protocolVersion)} serverName={serverName} />
        <OverallScoreCard
          score={
            detail.outcome
              ? {
                  score: detail.score,
                  outcome: detail.outcome,
                  applicable: detail.applicable,
                  passed: detail.passed,
                  failed: detail.failed,
                  couldNotRun: detail.couldNotRun,
                  notApplicable: detail.notApplicable,
                  advisoryCount: detail.advisoryCount,
                }
              : undefined
          }
          serverName={serverName}
          version={detail.protocolVersion ?? "Auto"}
          isRunning={
            !finished &&
            detail.status !== "timed_out" &&
            detail.status !== "cancelled"
          }
          // A suite's own row already says why it is incomplete; the card
          // repeats the run's reason only when no suite carries it (e.g. a
          // suite that never reported).
          note={
            detail.incompleteReason &&
            !detail.reports.some(
              (report) => report.incompleteReason === detail.incompleteReason,
            )
              ? detail.incompleteReason
              : null
          }
        />

        <ConformanceAdvice groups={advice} />

        <SuiteList version={detail.protocolVersion}>
          {detail.reports.map((report) => (
            <SavedSuiteRow
              key={report.suiteKind}
              report={report}
              loadReport={loadReport}
              runSettled={
                detail.status === "completed" ||
                detail.status === "timed_out" ||
                detail.status === "cancelled"
              }
            />
          ))}
        </SuiteList>
      </div>
    </div>
  );
}

export const detailDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type SavedSuiteReport = {
  suiteKind: string;
  status: string;
  outcome: string | null;
  incompleteReason: string | null;
  score: number | null;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  reportUrl?: string | null;
};

/** One suite of a saved run, in the same row the live panel uses. */
function SavedSuiteRow({
  report,
  runSettled,
  cases,
  loadReport,
}: {
  report: SavedSuiteReport;
  /** The run as a whole is over, so an unsettled suite will never finish. */
  runSettled: boolean;
  /** Checks already in hand, as in a shared artifact; skips the fetch. */
  cases?: SavedReportCase[];
  /** Shares the page's fetch of this report. */
  loadReport?: LoadReport;
}) {
  const copy = SUITE_COPY[report.suiteKind as keyof typeof SUITE_COPY] ?? {
    title: report.suiteKind,
    description: "",
  };
  const settled = report.status === "completed" || report.status === "failed";
  // Runs saved before the not-applicable OAuth upload was fixed left that
  // suite at "running" forever; once the run is over, say so plainly.
  const noResult = !settled && report.status !== "skipped" && runSettled;
  const notApplicable =
    report.status === "skipped" ||
    (settled && report.score == null && report.applicable === 0);
  const absentApps =
    report.suiteKind === "apps" &&
    report.status === "completed" &&
    report.outcome === "passed" &&
    report.score == null &&
    report.applicable === 0;
  const [override, setOverride] = useState<boolean | null>(null);
  // A suite that did not apply stays shut but still opens on click, to its
  // list of checks.
  const expanded =
    !noResult &&
    (override ??
      (!notApplicable &&
        (report.outcome === "failed" || report.outcome === "incomplete")));

  const badge = noResult ? (
    <VerdictBadge label="NO RESULT" tone="neutral" />
  ) : notApplicable ? (
    <VerdictBadge label="NOT APPLICABLE" tone="neutral" />
  ) : !settled ? (
    <VerdictBadge label="RUNNING" tone="neutral" spinning />
  ) : report.outcome === "failed" ? (
    <VerdictBadge label="FAILED" tone="danger" />
  ) : report.outcome === "incomplete" ? (
    <VerdictBadge label="INCOMPLETE" tone="warning" />
  ) : (
    <VerdictBadge label="PASSED" tone="success" />
  );

  return (
    <SuiteRow
      title={copy.title}
      subtitle={
        noResult
          ? "This suite did not report a result for this run."
          : notApplicable
            ? savedNotApplicableSubtitle(report, copy.title)
            : copy.description
      }
      badge={badge}
      score={
        report.score == null
          ? null
          : {
              score: report.score,
              passed: report.passed,
              applicable: report.applicable,
            }
      }
      expanded={expanded}
      collapsible={!noResult}
      onToggle={() => setOverride(!expanded)}
    >
      {notApplicable ? (
        <CatalogList
          catalog={suiteCatalog(report.suiteKind)}
          note={
            report.status === "skipped"
              ? ". Not run."
              : absentApps
                ? "."
                : ". None apply to this server."
          }
        />
      ) : (
        <SuiteReportCases
          suiteKind={report.suiteKind}
          reportUrl={report.reportUrl}
          loadReport={loadReport}
          inlineCases={cases}
          incompleteReason={report.incompleteReason}
          load={expanded || override !== null}
        />
      )}
    </SuiteRow>
  );
}

/** A shared suite in the shape the run page's rows read, from its own score. */
function sharedSuiteRow(
  suiteKind: string,
  report: SharedSuiteReport,
): { report: SavedSuiteReport; cases: SavedReportCase[] } {
  const score = report.score ?? {};
  return {
    report: {
      suiteKind,
      status: "completed",
      // The SDK reads a missing outcome as `passed ? "passed" : "failed"`.
      outcome:
        score.outcome ??
        report.outcome ??
        (report.passed === undefined
          ? null
          : report.passed
            ? "passed"
            : "failed"),
      incompleteReason: report.incompleteReason ?? null,
      score: typeof score.score === "number" ? score.score : null,
      applicable: score.applicable ?? 0,
      passed: score.passed ?? 0,
      failed: score.failed ?? 0,
      couldNotRun: score.couldNotRun ?? 0,
    },
    cases: (report.groups ?? []).flatMap((group) => group.cases ?? []),
  };
}

export function ConformanceSharedPage({ token }: { token: string }) {
  const { loading, error, artifact } = useSharedArtifact({
    resourceType: "conformanceRun",
    token,
  });
  const run =
    artifact && typeof artifact === "object"
      ? (artifact as SharedConformanceArtifact)
      : {};
  const reports = run.reports ?? {};
  const suiteKinds = [
    ...(run.requestedSuites ?? []).filter((kind) => kind in reports),
    ...Object.keys(reports).filter(
      (kind) => !(run.requestedSuites ?? []).includes(kind),
    ),
  ];

  return (
    <SharedArtifactPage
      title="Conformance report"
      loading={loading}
      error={error}
    >
      {typeof run.createdAt === "number" ? (
        <p className="text-sm text-muted-foreground">
          {detailDateFormat.format(run.createdAt)}
        </p>
      ) : null}
      <OverallScoreCard
        score={
          run.outcome
            ? {
                score: run.score ?? null,
                outcome: run.outcome,
                applicable: run.applicable ?? 0,
                passed: run.passed ?? 0,
                failed: run.failed ?? 0,
                couldNotRun: run.couldNotRun ?? 0,
                notApplicable: run.notApplicable ?? 0,
                advisoryCount: run.advisoryCount,
              }
            : undefined
        }
        serverName={run.serverName?.trim() || "Shared run"}
        version={run.protocolVersion ?? "Auto"}
      />
      <ConformanceAdvice
        groups={reportAdviceGroups(
          suiteKinds.map((kind) => ({
            suiteKind: kind,
            advisories: reports[kind]!.advisories,
            passedAdvisories: reports[kind]!.passedAdvisories,
          })),
        )}
      />
      {suiteKinds.length > 0 ? (
        <ConformanceSourceVersion version={run.protocolVersion}>
          <div className="overflow-hidden rounded-lg border border-border bg-popover">
            {suiteKinds.map((kind) => {
              const row = sharedSuiteRow(kind, reports[kind]!);
              return (
                <SavedSuiteRow
                  key={kind}
                  report={row.report}
                  cases={row.cases}
                  runSettled
                />
              );
            })}
          </div>
        </ConformanceSourceVersion>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Read-only shared result. Credentials, raw HTTP evidence, and rerun
        controls are not included. Guests who opened this link are auditable
        browser sessions, not verified individuals.
      </p>
    </SharedArtifactPage>
  );
}
