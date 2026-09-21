import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { routePaths } from "@/lib/app-navigation";
import {
  fetchScoreRun,
  ScoreRunNotFoundError,
  type ScoreSummary,
  type StoredScoreRun,
} from "@/lib/apis/score-api";

const APP_ORIGIN = "https://app.mcpjam.com";

const SUITE_TITLES: Record<string, string> = {
  protocol: "Protocol",
  apps: "Apps",
  tasks: "Tasks",
  oauth: "OAuth",
};

/**
 * The same sentence the SDK's `describeConformanceScore` produces, rebuilt
 * from the stored counts plus the pending count derived from each suite
 * report's `profile.pendingCheckIds` (same intersection as `partitionByStamp`).
 *
 * Advice wording is a count only: the stored row carries `advisoryCount`,
 * not `advicePointsLost`, so the SDK's `(−N)` deduction cannot be
 * reconstructed honestly and is left off. Pending is derived from the
 * report blob (already stored) rather than a flat summary field — adding
 * `pending` to `ScoreSummary`/`summarySchema` is a backend follow-up for
 * surfaces that list summaries without reports.
 */
function describeStoredScore(summary: ScoreSummary, pending = 0): string {
  if (summary.score === null) {
    return `not scored — 0 applicable checks (${summary.notApplicable} not applicable)`;
  }
  const parts = [
    `${summary.passed}/${summary.applicable} applicable checks passed`,
  ];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.couldNotRun > 0)
    parts.push(`${summary.couldNotRun} could not run`);
  if (summary.advisoryCount > 0) {
    parts.push(
      `${summary.advisoryCount} advisor${
        summary.advisoryCount === 1 ? "y" : "ies"
      }`
    );
  }
  if (pending > 0) {
    parts.push(`${pending} pending (unscored by this profile)`);
  }
  const version = summary.protocolVersion
    ? ` [${summary.protocolVersion}]`
    : "";
  return `${summary.score}/100 — ${parts.join(", ")}${version}`;
}

function CheckIcon({ status }: { status: string }) {
  if (status === "passed") {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

interface ReportCheck {
  id?: string;
  title?: string;
  status?: string;
  error?: { message?: string };
  skipReason?: string;
  pending?: boolean;
}

/**
 * Every suite's per-item breakdown, normalized.
 *
 * The OAuth suite names its items `steps`, not `checks` — reading only
 * `checks` made every OAuth section claim "no individual checks" even after a
 * full authorization run, quietly dropping the evidence behind its score.
 */
function collectChecks(suite: unknown): ReportCheck[] {
  const record = suite as { checks?: unknown; steps?: unknown } | undefined;
  const items = Array.isArray(record?.checks)
    ? record.checks
    : Array.isArray(record?.steps)
    ? record.steps
    : [];
  return items as ReportCheck[];
}

/**
 * Pending ids stamped on a suite report. An absent `profile` (legacy stored
 * runs, and suites that have no stamp yet) yields an empty set — those
 * pages render exactly as they did before profiles existed.
 */
function pendingIdsFromSuite(suite: unknown): Set<string> {
  const record = suite as
    | { profile?: { pendingCheckIds?: unknown } }
    | undefined;
  const ids = record?.profile?.pendingCheckIds;
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.filter((id): id is string => typeof id === "string"));
}

export function ScoreResultsPage() {
  const { runToken } = useParams<{ runToken: string }>();
  const [run, setRun] = useState<StoredScoreRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    // Drop the previous result FIRST. Otherwise a token change (or a request
    // that stalls) leaves the old score on screen under the new URL — the one
    // thing a result page must never do is show a number for a server the
    // reader did not ask about.
    setRun(null);
    if (!runToken) return;
    let cancelled = false;
    setError(null);
    setNotFound(false);
    void fetchScoreRun(runToken)
      .then((loaded) => {
        if (!cancelled) setRun(loaded);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ScoreRunNotFoundError) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [runToken]);

  const suites = useMemo(() => {
    if (!run) return [];
    return (["protocol", "apps", "tasks", "oauth"] as const)
      .map((suiteId) => {
        const report = run.report[suiteId];
        const pendingIds = pendingIdsFromSuite(report);
        const checks = collectChecks(report).map((check) => ({
          ...check,
          pending: Boolean(check.id && pendingIds.has(check.id)),
        }));
        return {
          suiteId,
          summary: run.suiteSummaries.find((s) => s.suiteId === suiteId),
          checks,
          // Same derivation as `partitionByStamp`: |checks ∩ pendingIds|.
          pending: checks.filter((check) => check.pending).length,
        };
      })
      .filter((entry) => entry.summary || entry.checks.length > 0);
  }, [run]);

  const pendingTotal = suites.reduce((total, suite) => total + suite.pending, 0);

  if (notFound) {
    return (
      <CenteredNotice
        title="No result here"
        body="That link isn't valid, or the run it pointed at no longer exists. Result links are private — check you copied the whole thing."
      />
    );
  }

  if (error) {
    return <CenteredNotice title="Couldn't load this result" body={error} />;
  }

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const toneClass =
    run.outcome === "failed"
      ? "text-red-400"
      : run.outcome === "incomplete"
      ? "text-amber-500"
      : "text-green-500";

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto px-6 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Conformance score</h1>
        <p className="truncate text-sm text-muted-foreground">
          {run.serverUrl}
        </p>
        <p className="text-xs text-muted-foreground">
          Scanned {new Date(run.createdAt).toLocaleString()}
        </p>
      </header>

      {run.score !== null && (
        <div className="flex items-center gap-4 rounded-md border border-border/50 bg-muted/30 px-6 py-5">
          <div className="text-6xl font-semibold leading-none tabular-nums">
            {run.score}
            <span className="ml-0.5 text-lg font-normal text-muted-foreground">
              /100
            </span>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className={`text-sm font-medium ${toneClass}`}>
              {run.outcome === "failed"
                ? "Not conformant"
                : run.outcome === "incomplete"
                ? "Incomplete run"
                : run.advisoryCount > 0
                ? "Conformant, with advice"
                : "Fully conformant"}
            </div>
            <div className="text-xs text-muted-foreground">
              {describeStoredScore(run, pendingTotal)}
              {run.notApplicable > 0
                ? ` · ${run.notApplicable} not applicable`
                : ""}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {suites.map(({ suiteId, summary, checks, pending }) => (
          <section
            key={suiteId}
            className="overflow-hidden rounded-md border border-border/50"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-muted/20 px-4 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {SUITE_TITLES[suiteId]}
                </div>
                {summary && (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {describeStoredScore(summary, pending)}
                  </div>
                )}
              </div>
              {summary?.score !== null && summary?.score !== undefined && (
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {summary.score}
                  <span className="text-[10px] font-normal text-muted-foreground">
                    /100
                  </span>
                </span>
              )}
            </div>
            {checks.length > 0 ? (
              <ul>
                {checks.map((check, index) => (
                  <li
                    key={check.id ?? index}
                    className="flex items-start gap-2 border-b border-border/30 px-4 py-2 last:border-b-0"
                  >
                    <CheckIcon status={check.status ?? "skipped"} />
                    {check.pending ? (
                      <span
                        title="unscored by this run's profile"
                        className="mt-0.5 shrink-0 rounded-sm border border-border/60 px-1 py-px text-[10px] leading-none text-muted-foreground"
                      >
                        unscored
                      </span>
                    ) : null}
                    <div className="min-w-0">
                      <div className="text-xs">
                        {check.title ?? check.id ?? "check"}
                      </div>
                      {check.error?.message && (
                        <div className="text-[11px] text-red-400">
                          {check.error.message}
                        </div>
                      )}
                      {!check.error?.message && check.skipReason && (
                        <div className="text-[11px] text-muted-foreground">
                          {check.skipReason}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-4 py-3 text-[11px] text-muted-foreground">
                This suite reported no individual checks.
              </div>
            )}
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <a href={`${APP_ORIGIN}/servers`}>Debug these failures in MCPJam</a>
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={routePaths.embedScore}>Run your own scan</a>
        </Button>
      </div>
    </div>
  );
}

function CenteredNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Button asChild size="sm" variant="outline">
        <a href={routePaths.embedScore}>Run your own scan</a>
      </Button>
    </div>
  );
}
