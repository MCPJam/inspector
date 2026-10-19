/**
 * Conformance history, detail, and sharing — Convex-backed.
 *
 * `/conformance` remains the selected server's latest/history view. Durable
 * runs live at `/conformance/runs/:runId`. Public sharing is a separate
 * redacted artifact at `/conformance/shared/:token`.
 */

import { useCallback, useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Loader2, Lock, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FlaskConical } from "lucide-react";
import { buildConformanceRunPath, useAppNavigate } from "@/lib/app-navigation";
import { toast } from "@/lib/toast";
import { ShareDialog } from "@/components/sharing/ShareDialog";
import { ResourceSharePanel } from "@/components/sharing/ResourceSharePanel";
import { SharedArtifactPage } from "@/components/sharing/SharedArtifactPage";
import { useSharedArtifact } from "@/hooks/useSharedArtifact";
import { buildConformanceSharePath } from "@/lib/app-navigation";
import { fetchArtifact, useArtifactQuery } from "@/lib/artifact-urls";
import {
  OverallScoreCard,
  StatusIcon,
  SUITE_COPY,
  SuiteRow,
  VerdictBadge,
} from "./conformance-ui";

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
const HISTORY_SOURCE_LABEL: Record<string, string> = {
  ui: "Inspector",
  sdk: "SDK",
  cli: "CLI",
  github_action: "GitHub",
  github_app: "GitHub",
  api: "API",
};

const historyDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function RunResultBadge({ run }: { run: ConformanceRunListItem }) {
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
                  className={`w-12 shrink-0 text-right text-sm font-semibold tabular-nums ${
                    run.score == null ? "text-muted-foreground" : ""
                  }`}
                >
                  {run.score == null ? "—" : `${Math.round(run.score)}%`}
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
}: {
  runId: string;
  projectId?: string | null;
  /** Saved server id → display name, for the breadcrumb and score card. */
  serverNames?: ReadonlyMap<string, string>;
}) {
  const navigate = useAppNavigate();
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
  const setSharing = useAction("conformanceRuns:setSharing" as any);
  const unifiedShare =
    useFeatureFlagEnabled("unified-share-conformance") === true;
  const [shareBusy, setShareBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const copyShare = useCallback(
    async (enabled: boolean) => {
      if (!detail) return;
      setShareBusy(true);
      try {
        const result = (await setSharing({
          runId: detail._id,
          enabled,
        })) as { enabled: boolean; token?: string | null; shareUrl?: string };
        if (result.enabled && (result.shareUrl || result.token)) {
          const url =
            result.shareUrl ??
            `${window.location.origin}/conformance/shared/${result.token}`;
          await navigator.clipboard.writeText(url);
          toast.success("Share link copied");
        } else {
          toast.success("Sharing turned off");
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not update sharing",
        );
      } finally {
        setShareBusy(false);
      }
    },
    [detail, setSharing],
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

  const serverName =
    (detail.serverId ? serverNames?.get(detail.serverId) : undefined) ??
    detail.targetKey.replace(/^server:/, "");
  const finished = detail.status === "completed";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-8 pt-5 pb-4">
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            className="font-medium tracking-tight text-muted-foreground hover:text-foreground"
            onClick={() => navigate("/conformance?view=history")}
          >
            Conformance History
          </button>
          <span className="text-muted-foreground/70">/</span>
          <span className="truncate font-semibold">{serverName}</span>
          <div className="ml-auto flex items-center gap-2">
            {unifiedShare ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!finished}
                onClick={() => setShareOpen(true)}
                data-testid="conformance-share-open"
              >
                <Share2 className="size-3.5" aria-hidden /> Share
              </Button>
            ) : (
              <Button
                variant={detail.sharingEnabled ? "secondary" : "outline"}
                size="sm"
                disabled={shareBusy || !finished}
                onClick={() => void copyShare(!detail.sharingEnabled)}
              >
                {detail.sharingEnabled ? (
                  <>
                    <Share2 className="size-3.5" aria-hidden /> Shareable
                  </>
                ) : (
                  <>
                    <Lock className="size-3.5" aria-hidden /> Private
                  </>
                )}
              </Button>
            )}
            <Button size="sm" onClick={() => navigate("/conformance")}>
              Run again
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {detailDateFormat.format(detail.createdAt)} ·{" "}
          {HISTORY_SOURCE_LABEL[detail.source] ?? detail.source}
          {detail.verification === "client_reported"
            ? " · Client-reported"
            : ""}
        </p>
      </div>
      {unifiedShare ? (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          title="Share conformance run"
          description="A frozen redacted snapshot. Guests who redeem the link are auditable browser sessions, not verified individuals."
        >
          <ResourceSharePanel
            resourceType="conformanceRun"
            resourceId={detail._id}
            disabledReason={
              finished ? null : "Only a finished run can be shared"
            }
            footerSlot={
              <p className="text-xs text-muted-foreground">
                Viewers see a frozen snapshot. Revoking access is immediate even
                though the artifact itself does not change.
              </p>
            }
            linkLabel="Share link"
            buildShareUrl={(token) =>
              `${window.location.origin}${buildConformanceSharePath(token)}`
            }
            testIdPrefix="conformance-share"
          />
        </ShareDialog>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-8">
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
        {detail.incompleteReason ? (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            {detail.incompleteReason}
          </p>
        ) : null}

        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
          {detail.reports.map((report) => (
            <SavedSuiteRow
              key={report.suiteKind}
              report={report}
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

const detailDateFormat = new Intl.DateTimeFormat("en-US", {
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
}: {
  report: SavedSuiteReport;
  /** The run as a whole is over, so an unsettled suite will never finish. */
  runSettled: boolean;
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
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded =
    !notApplicable &&
    !noResult &&
    (override ??
      (report.outcome === "failed" || report.outcome === "incomplete"));

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
            ? (report.incompleteReason ??
              "Nothing here applied to this server, so it was not scored.")
            : copy.description
      }
      badge={badge}
      score={
        report.score == null
          ? null
          : {
              score: Math.round(report.score),
              passed: report.passed,
              applicable: report.applicable,
            }
      }
      expanded={expanded}
      collapsible={!notApplicable && !noResult}
      onToggle={() => setOverride(!expanded)}
    >
      <SuiteReportCases
        reportUrl={report.reportUrl}
        incompleteReason={notApplicable ? null : report.incompleteReason}
        load={expanded || override !== null}
      />
    </SuiteRow>
  );
}

type SavedReportCase = {
  id: string;
  title: string;
  status: string;
  skipReason?: string;
  error?: string;
};

/**
 * The checks of a saved suite, read from its report artifact. Fetched the
 * first time the row opens, not on page load.
 */
function SuiteReportCases({
  reportUrl,
  incompleteReason,
  load,
}: {
  reportUrl?: string | null;
  incompleteReason: string | null;
  load: boolean;
}) {
  const [cases, setCases] = useState<SavedReportCase[] | null | "error">(null);
  useEffect(() => {
    if (!load || !reportUrl || cases !== null) return;
    let cancelled = false;
    fetchArtifact(reportUrl)
      .then((response) => {
        // An expired link answers with an error body; never show that as the
        // report. `fetchArtifact` renews the link and retries once.
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((json: { groups?: Array<{ cases?: SavedReportCase[] }> }) => {
        if (cancelled) return;
        setCases((json.groups ?? []).flatMap((group) => group.cases ?? []));
      })
      .catch(() => {
        if (!cancelled) setCases("error");
      });
    return () => {
      cancelled = true;
    };
  }, [load, reportUrl, cases]);

  return (
    <div>
      {incompleteReason ? (
        <p className="py-2 pl-7 text-[13px] text-amber-700 dark:text-amber-400">
          {incompleteReason}
        </p>
      ) : null}
      {!reportUrl || cases === "error" ? (
        <p className="py-3 pl-7 text-[13px] text-muted-foreground">
          The detailed report for this suite is not available.
        </p>
      ) : cases === null ? (
        <p className="flex items-center gap-2 py-3 pl-7 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading checks…
        </p>
      ) : (
        cases.map((check) => (
          <div
            key={check.id}
            className="flex items-start gap-2.5 border-b border-border/60 py-1.75 pl-7 pr-1 last:border-0"
          >
            <span className="mt-0.5">
              <StatusIcon status={check.status} skipReason={check.skipReason} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={
                  check.status === "skipped" &&
                  check.skipReason !== "could-not-run"
                    ? "text-[13px] text-muted-foreground"
                    : "text-[13px]"
                }
              >
                {check.title}
              </span>
              {check.error ? (
                <span
                  className={
                    check.status === "failed"
                      ? "text-[13px] font-medium text-red-600 dark:text-red-400"
                      : "text-[13px] text-muted-foreground"
                  }
                >
                  {check.error}
                </span>
              ) : null}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

export function ConformanceSharedPage({ token }: { token: string }) {
  const { loading, error, artifact } = useSharedArtifact({
    resourceType: "conformanceRun",
    token,
  });
  const body =
    artifact && typeof artifact === "object"
      ? (artifact as Record<string, unknown>)
      : {};

  return (
    <SharedArtifactPage
      title="Conformance report"
      loading={loading}
      error={error}
    >
      <p className="text-sm text-muted-foreground">
        Read-only shared result. Credentials, raw HTTP evidence, and rerun
        controls are not included. Guests who opened this link are auditable
        browser sessions, not verified individuals.
      </p>
      {body.verification === "client_reported" ? (
        <Badge variant="secondary">Client-reported</Badge>
      ) : (
        <Badge variant="outline">MCPJam-verified</Badge>
      )}
      <p className="text-sm">
        Outcome {String(body.outcome ?? "unknown")}
        {typeof body.score === "number"
          ? ` · score ${Math.round(body.score)}`
          : ""}
      </p>
      <pre className="max-h-[70vh] overflow-auto rounded bg-muted/40 p-3 text-xs">
        {JSON.stringify(body, null, 2)}
      </pre>
    </SharedArtifactPage>
  );
}
