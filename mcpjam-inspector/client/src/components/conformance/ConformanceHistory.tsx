/**
 * Conformance history, detail, and sharing — Convex-backed.
 *
 * `/conformance` remains the selected server's latest/history view. Durable
 * runs live at `/conformance/runs/:runId`. Public sharing is a separate
 * redacted artifact at `/conformance/shared/:token`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Filter,
  Loader2,
  Lock,
  Share2,
  XCircle,
  MinusCircle,
} from "lucide-react";
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

const SOURCE_LABEL: Record<string, string> = {
  ui: "UI",
  sdk: "SDK",
  cli: "CLI",
  github_action: "GitHub Action",
  github_app: "GitHub App",
  api: "API",
};

function ageLabel(createdAt: number): string {
  const delta = Date.now() - createdAt;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function OutcomeIcon({
  outcome,
  status,
}: {
  outcome: ConformanceRunListItem["outcome"];
  status: string;
}) {
  if (
    status !== "completed" &&
    status !== "timed_out" &&
    status !== "cancelled"
  ) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }
  if (outcome === "passed") {
    return <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />;
  }
  if (outcome === "failed") {
    return <XCircle className="size-4 text-destructive" aria-hidden />;
  }
  return <MinusCircle className="size-4 text-amber-500" aria-hidden />;
}

export function ConformanceHistory({
  projectId,
  serverId,
}: {
  projectId: string;
  serverId?: string | null;
}) {
  const [scope, setScope] = useState<"current" | "all">(
    serverId ? "current" : "all"
  );
  const [outcome, setOutcome] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [protocolVersion, setProtocolVersion] = useState<string>("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<ConformanceRunListItem[]>([]);
  const navigate = useAppNavigate();

  const targetKey =
    scope === "current" && serverId ? `server:${serverId}` : undefined;

  const page = useQuery(
    "conformanceRuns:listRuns" as any,
    projectId
      ? ({
          projectId,
          targetKey,
          source: source || undefined,
          outcome: outcome || undefined,
          protocolVersion: protocolVersion || undefined,
          paginationOpts: { numItems: 20, cursor },
        } as any)
      : "skip"
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

  const loading = page === undefined;

  return (
    <section
      className="space-y-3"
      aria-labelledby="conformance-history-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="conformance-history-heading" className="text-sm font-medium">
          Run history
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-md border border-border/60 p-0.5 text-xs"
            role="group"
            aria-label="History scope"
          >
            <button
              type="button"
              className={`rounded px-2 py-1 ${
                scope === "current"
                  ? "bg-muted font-medium"
                  : "text-muted-foreground"
              }`}
              disabled={!serverId}
              onClick={() => {
                setScope("current");
                setCursor(null);
              }}
            >
              Current server
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 ${
                scope === "all"
                  ? "bg-muted font-medium"
                  : "text-muted-foreground"
              }`}
              onClick={() => {
                setScope("all");
                setCursor(null);
              }}
            >
              All runs
            </button>
          </div>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <Filter className="size-3" aria-hidden />
            <span className="sr-only">Outcome</span>
            <select
              className="rounded border border-border/60 bg-background px-1 py-0.5"
              value={outcome}
              onChange={(event) => {
                setOutcome(event.target.value);
                setCursor(null);
              }}
              aria-label="Filter by outcome"
            >
              <option value="">Any outcome</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="incomplete">Incomplete</option>
            </select>
          </label>
          <select
            className="rounded border border-border/60 bg-background px-1 py-0.5 text-xs"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setCursor(null);
            }}
            aria-label="Filter by source"
          >
            <option value="">Any source</option>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-border/60 bg-background px-1 py-0.5 text-xs"
            value={protocolVersion}
            onChange={(event) => {
              setProtocolVersion(event.target.value);
              setCursor(null);
            }}
            aria-label="Filter by protocol version"
          >
            <option value="">Any protocol</option>
            <option value="2025-11-25">2025-11-25</option>
            <option value="2025-06-18">2025-06-18</option>
            <option value="2025-03-26">2025-03-26</option>
            <option value="2024-11-05">2024-11-05</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading run history…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No conformance runs yet"
          description={
            scope === "current"
              ? "Run the suites below to record history for this server, or switch to All runs."
              : "CLI, GitHub, and hosted runs land here. Start a run below or upload with the MCPJam CLI."
          }
        />
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/40">
          {rows.map((run) => (
            <li key={run._id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40"
                data-testid="conformance-history-row"
                onClick={(event) => {
                  // The live runner sits on the same page. Don't let this
                  // click bubble into that surface or be treated as a submit.
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(buildConformanceRunPath(run._id, projectId));
                }}
              >
                <OutcomeIcon outcome={run.outcome} status={run.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium capitalize">
                      {run.outcome ?? run.status}
                    </span>
                    {run.score != null ? (
                      <span className="tabular-nums text-muted-foreground">
                        {Math.round(run.score)}
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {run.passed}/{run.applicable} applicable
                    </span>
                    {run.verification === "client_reported" ? (
                      <Badge variant="secondary">Client-reported</Badge>
                    ) : (
                      <Badge variant="outline">MCPJam-verified</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{SOURCE_LABEL[run.source] ?? run.source}</span>
                    <span>{ageLabel(run.createdAt)}</span>
                    {run.durationMs != null ? (
                      <span>{Math.round(run.durationMs / 1000)}s</span>
                    ) : null}
                    {run.protocolVersion ? (
                      <span>{run.protocolVersion}</span>
                    ) : null}
                    {run.ciMetadata?.branch ? (
                      <span>{run.ciMetadata.branch}</span>
                    ) : null}
                    {run.ciMetadata?.commitSha ? (
                      <span className="font-mono">
                        {run.ciMetadata.commitSha.slice(0, 7)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {page && !page.isDone ? (
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
}: {
  runId: string;
  projectId?: string | null;
}) {
  const navigate = useAppNavigate();
  const detail = useQuery(
    "conformanceRuns:getRun" as any,
    runId ? ({ runId } as any) : "skip"
  ) as
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
    | undefined
    | null;
  const setSharing = useAction("conformanceRuns:setSharing" as any);
  const unifiedShare = useFeatureFlagEnabled("unified-share-conformance") === true;
  const [openSuites, setOpenSuites] = useState<Record<string, boolean>>({});
  const [shareBusy, setShareBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const coverage = useMemo(() => {
    if (!detail) return "";
    const executed = detail.reports.filter(
      (report) => report.status === "completed" || report.status === "failed"
    ).length;
    return `${executed}/${detail.requestedSuites.length} suites`;
  }, [detail]);

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
          error instanceof Error ? error.message : "Could not update sharing"
        );
      } finally {
        setShareBusy(false);
      }
    },
    [detail, setSharing]
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

  const previous = detail.previous;
  const scoreDelta =
    previous && detail.score != null && previous.score != null
      ? detail.score - previous.score
      : null;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => navigate("/conformance")}
          >
            ← History
          </button>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-medium">
            <OutcomeIcon outcome={detail.outcome} status={detail.status} />
            {detail.outcome ?? detail.status}
          </h1>
          <p className="text-sm text-muted-foreground">
            {coverage}
            {detail.score != null ? ` · score ${Math.round(detail.score)}` : ""}
            {scoreDelta != null
              ? ` · ${scoreDelta > 0 ? "+" : ""}${Math.round(
                  scoreDelta
                )} vs previous`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.verification === "client_reported" ? (
            <Badge variant="secondary">Client-reported</Badge>
          ) : (
            <Badge variant="outline">MCPJam-verified</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/conformance")}
          >
            Run again
          </Button>
          {unifiedShare ? (
            <Button
              variant="outline"
              size="sm"
              disabled={detail.status !== "completed"}
              onClick={() => setShareOpen(true)}
              data-testid="conformance-share-open"
            >
              <Share2 className="size-3.5" aria-hidden /> Share
            </Button>
          ) : (
            <Button
              variant={detail.sharingEnabled ? "secondary" : "outline"}
              size="sm"
              disabled={shareBusy || detail.status !== "completed"}
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
        </div>
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
              detail.status === "completed"
                ? null
                : "Only a finished run can be shared"
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

      {detail.incompleteReason ? (
        <p className="text-sm text-amber-600">{detail.incompleteReason}</p>
      ) : null}

      {detail.reports.map((report) => {
        const open = openSuites[report.suiteKind] === true;
        return (
          <section
            key={report.suiteKind}
            className="rounded-md border border-border/50"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              onClick={() =>
                setOpenSuites((current) => ({
                  ...current,
                  [report.suiteKind]: !open,
                }))
              }
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
              <span className="font-medium capitalize">{report.suiteKind}</span>
              <span className="text-muted-foreground">{report.outcome}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {report.passed}/{report.applicable}
              </span>
            </button>
            {open ? (
              <SuiteReportBody
                incompleteReason={report.incompleteReason}
                reportUrl={report.reportUrl}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function SuiteReportBody({
  incompleteReason,
  reportUrl,
}: {
  incompleteReason: string | null;
  reportUrl?: string | null;
}) {
  const [body, setBody] = useState<unknown>(null);
  useEffect(() => {
    if (!reportUrl) {
      setBody(null);
      return;
    }
    let cancelled = false;
    fetch(reportUrl)
      .then((response) => response.json())
      .then((json) => {
        if (!cancelled) setBody(json);
      })
      .catch(() => {
        if (!cancelled) setBody(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reportUrl]);
  return (
    <div className="space-y-2 border-t border-border/40 px-3 py-2">
      {incompleteReason ? (
        <p className="text-xs text-amber-600">{incompleteReason}</p>
      ) : null}
      <pre className="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-xs">
        {JSON.stringify(body, null, 2)}
      </pre>
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
        {typeof body.score === "number" ? ` · score ${Math.round(body.score)}` : ""}
      </p>
      <pre className="max-h-[70vh] overflow-auto rounded bg-muted/40 p-3 text-xs">
        {JSON.stringify(body, null, 2)}
      </pre>
    </SharedArtifactPage>
  );
}
