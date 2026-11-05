/**
 * Conformance history, detail, and sharing — Convex-backed.
 *
 * `/conformance` remains the selected server's latest/history view. Durable
 * runs live at `/conformance/runs/:runId`. Public sharing is a separate
 * redacted artifact at `/conformance/shared/:token`.
 */

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FlaskConical } from "lucide-react";
import { buildConformanceRunPath, useAppNavigate } from "@/lib/app-navigation";
import { SharedArtifactPage } from "@/components/sharing/SharedArtifactPage";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import { useSharedArtifact } from "@/hooks/useSharedArtifact";
import { useArtifactQuery } from "@/lib/artifact-urls";
import {
  OverallScoreCard,
  SUITE_COPY,
  SuiteRow,
  VerdictBadge,
} from "./conformance-ui";
import { CatalogList } from "./ConformanceCheckRows";
import { SuiteReportCases } from "./ConformanceSavedChecks";
import { ConformanceAdvice, reportAdviceGroups } from "./ConformanceAdvice";
import {
  useSavedRunReports,
  type LoadReport,
  type SavedReportCase,
} from "./use-saved-run-reports";
import { ConformanceVersionNotice } from "./ConformanceVersionNotice";
import { conformanceVersionRefusal } from "./conformance-version-refusal";
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

/** Where a run came from, in the words the History table uses. */
export const HISTORY_SOURCE_LABEL: Record<string, string> = {
  ui: "UI",
  sdk: "SDK",
  cli: "CLI",
  github_action: "GitHub",
  github_app: "GitHub",
  api: "API",
};

export const historyDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function RunResultBadge({ run }: { run: ConformanceRunListItem }) {
  const base =
    "inline-flex h-5.5 shrink-0 items-center rounded-sm px-2 text-[11px] font-semibold tracking-[0.06em]";
  const neutral = "bg-muted text-muted-foreground";
  if (run.status === "timed_out") {
    return (
      <span
        className={`${base} bg-amber-400/25 text-amber-700 dark:text-amber-400`}
      >
        TIMED OUT
      </span>
    );
  }
  if (run.status === "cancelled") {
    return <span className={`${base} ${neutral}`}>CANCELLED</span>;
  }
  if (run.status !== "completed") {
    return <span className={`${base} ${neutral}`}>RUNNING</span>;
  }
  if (run.outcome === "passed") {
    return (
      <span
        className={`${base} bg-emerald-500/15 text-emerald-700 dark:text-emerald-400`}
      >
        PASSED
      </span>
    );
  }
  if (run.outcome === "failed") {
    return (
      <span className={`${base} bg-red-500/10 text-red-600 dark:text-red-400`}>
        FAILED
      </span>
    );
  }
  return <span className={`${base} ${neutral}`}>INCOMPLETE</span>;
}

/**
 * Every conformance run in the project, newest first, as one table. A row
 * opens the run's detail page.
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
  const navigate = useAppNavigate();

  const page = useQuery(
    "conformanceRuns:listRuns" as any,
    projectId
      ? ({ projectId, paginationOpts: { numItems: 20, cursor } } as any)
      : "skip",
  ) as
    | {
        page: ConformanceRunListItem[];
        isDone: boolean;
        continueCursor: string;
      }
    | undefined;

  useEffect(() => {
    if (!page) return;
    setRows((previous) => {
      if (cursor === null) return page.page;
      const seen = new Set(previous.map((row) => row._id));
      return [...previous, ...page.page.filter((row) => !seen.has(row._id))];
    });
  }, [cursor, page]);

  const serverLabel = (run: ConformanceRunListItem) =>
    (run.serverId ? serverNames?.get(run.serverId) : undefined) ??
    run.targetKey.replace(/^server:/, "");

  // "Load more" changes the query's cursor, and the query reads undefined
  // again while that page loads: only the first page may replace the table.
  if (page === undefined && rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading run history…
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No conformance runs yet"
        className="h-auto py-10"
        description="Runs from the Inspector, the CLI, GitHub, and the API land here."
      />
    );
  }

  const header = "text-[11px] font-semibold tracking-[0.06em] text-foreground";

  return (
    <section className="space-y-3" aria-label="Run history">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-4 bg-muted/60 px-4.5 py-2">
          <span className={`w-30 shrink-0 ${header}`}>SERVER</span>
          <span className={`w-35 shrink-0 ${header}`}>DATE</span>
          <span className={`min-w-0 grow ${header}`}>SOURCE</span>
          <span className={`shrink-0 ${header}`}>RESULT</span>
          <span className={`w-12 shrink-0 text-right ${header}`}>SCORE</span>
        </div>
        <ul>
          {rows.map((run) => (
            <li
              key={run._id}
              className="border-t border-border/60 first:border-t-0"
            >
              <button
                type="button"
                className="flex w-full items-center gap-4 px-4.5 py-3.5 text-left transition-colors hover:bg-muted/30"
                data-testid="conformance-history-row"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(buildConformanceRunPath(run._id, projectId));
                }}
              >
                <span className="w-30 shrink-0 truncate text-sm font-semibold">
                  {serverLabel(run)}
                </span>
                <span className="w-35 shrink-0 text-[13px] text-muted-foreground">
                  {historyDateFormat.format(run.createdAt)}
                </span>
                <span className="min-w-0 grow truncate text-[13px] text-muted-foreground">
                  {HISTORY_SOURCE_LABEL[run.source] ?? run.source}
                </span>
                <RunResultBadge run={run} />
                <span
                  className={`w-14 shrink-0 text-right text-sm font-semibold tabular-nums ${
                    run.score == null ? "text-muted-foreground" : ""
                  }`}
                >
                  {run.score == null ? "—" : `${run.score}%`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {page === undefined ? (
        <Button variant="outline" size="sm" disabled>
          Loading…
        </Button>
      ) : !page.isDone ? (
        <Button
          variant="outline"
          size="sm"
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
  const navigate = useAppNavigate();
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
  const serverName =
    savedServerName ?? detail.targetKey.replace(/^server:/, "");
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
        backLabel="Conformance History"
        onBack={() => navigate("/conformance?view=history")}
        backTestId="conformance-saved-run-back"
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
        />
        {/* A suite's own row already says why it is incomplete; repeat the
            run's reason here only when no suite carries it (e.g. a suite
            that never reported). */}
        {detail.incompleteReason &&
        !detail.reports.some(
          (report) => report.incompleteReason === detail.incompleteReason,
        ) ? (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            {detail.incompleteReason}
          </p>
        ) : null}

        <ConformanceAdvice groups={advice} />

        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-popover">
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
        </div>
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
          : notApplicable && !absentApps
            ? (report.incompleteReason ??
              "Nothing here applied to this server, so it was not scored.")
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

/** One suite as a shared artifact stores it: the redacted SDK report. */
type SharedSuiteReport = {
  outcome?: string;
  passed?: boolean;
  incompleteReason?: string;
  score?: {
    score?: number;
    outcome?: string;
    applicable?: number;
    passed?: number;
    failed?: number;
    couldNotRun?: number;
  };
  groups?: Array<{ cases?: SavedReportCase[] }>;
  advisories?: unknown;
};

type SharedConformanceArtifact = {
  score?: number | null;
  outcome?: ConformanceRunListItem["outcome"];
  applicable?: number;
  passed?: number;
  failed?: number;
  couldNotRun?: number;
  notApplicable?: number;
  advisoryCount?: number;
  protocolVersion?: string | null;
  requestedSuites?: string[];
  createdAt?: number;
  reports?: Record<string, SharedSuiteReport>;
};

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
        serverName="Shared run"
        version={run.protocolVersion ?? "Auto"}
      />
      <ConformanceAdvice
        groups={reportAdviceGroups(
          suiteKinds.map((kind) => ({
            suiteKind: kind,
            advisories: reports[kind]!.advisories,
          })),
        )}
      />
      {suiteKinds.length > 0 ? (
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
      ) : null}
      <p className="text-xs text-muted-foreground">
        Read-only shared result. Credentials, raw HTTP evidence, and rerun
        controls are not included. Guests who opened this link are auditable
        browser sessions, not verified individuals.
      </p>
    </SharedArtifactPage>
  );
}
