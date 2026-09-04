import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { CheckCircle2, Loader2, MinusCircle, XCircle } from "lucide-react";
import { routePaths } from "@/lib/app-navigation";
import {
  fetchScoreRun,
  ScoreRunNotFoundError,
  type ScoreSummary,
  type StoredScoreRun,
} from "@/lib/apis/score-api";
import { ScoreCard, type ScoreCardRow } from "./score-card";
import { ScoreSiteShell } from "./ScoreSiteShell";

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
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#3D8A5A]" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-[#C45A3A]" />;
  }
  return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-[var(--score-muted)]" />;
}

function displayHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).hostname.replace(/^www\./, "");
  } catch {
    return serverUrl;
  }
}

function formatRunDate(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

function suiteStatus(summary: ScoreSummary | undefined): {
  status: string;
  emphasize: boolean;
} {
  if (!summary || summary.score === null) {
    return { status: "INCOMPLETE", emphasize: true };
  }
  if (summary.outcome === "failed") {
    return { status: "MIXED", emphasize: true };
  }
  if (summary.outcome === "incomplete") {
    return { status: "INCOMPLETE", emphasize: true };
  }
  if (summary.advisoryCount > 0) {
    return { status: "REVIEW", emphasize: true };
  }
  return { status: "PASSED", emphasize: false };
}

function scoreCardRows(
  suites: Array<{
    suiteId: string;
    summary: ScoreSummary | undefined;
  }>,
): ScoreCardRow[] {
  return suites.map(({ suiteId, summary }) => {
    const { status, emphasize } = suiteStatus(summary);
    return {
      label: SUITE_TITLES[suiteId] ?? suiteId,
      score:
        summary?.score === null || summary?.score === undefined
          ? "—"
          : String(summary.score),
      status,
      emphasize,
    };
  });
}

function ledgerSegments(summary: ScoreSummary, pending: number) {
  return [
    { colorClass: "bg-[#3D8A5A]", share: summary.passed },
    { colorClass: "bg-[#C45A3A]", share: summary.failed },
    { colorClass: "bg-[#C49A4A]", share: summary.couldNotRun },
    { colorClass: "bg-[var(--score-border)]", share: summary.notApplicable },
    { colorClass: "bg-[#1A1918]", share: pending },
  ].filter((segment) => segment.share > 0);
}

function ledgerFooter(summary: ScoreSummary): string {
  const checks = summary.applicable + summary.notApplicable;
  return `${checks} checks. ${summary.passed} passed, ${summary.failed} failed.`;
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
      <ScoreSiteShell preview="none">
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--score-muted)]" />
        </div>
      </ScoreSiteShell>
    );
  }

  return (
    <ScoreSiteShell preview="none">
      <div className="flex w-full flex-col gap-10">
        <ScoreCard
          kicker={`Overall · run ${formatRunDate(run.createdAt)}`}
          server={displayHost(run.serverUrl)}
          score={run.score === null ? "—" : String(run.score)}
          rows={scoreCardRows(suites)}
          segments={ledgerSegments(run, pendingTotal)}
          footer={ledgerFooter(run)}
        />

        <p className="text-[13px] leading-[18px] text-[var(--score-muted)]">
          {describeStoredScore(run, pendingTotal)}
          {run.notApplicable > 0
            ? ` · ${run.notApplicable} not applicable`
            : ""}
        </p>

        <div className="flex flex-col gap-6">
          {suites.map(({ suiteId, summary, checks, pending }) => (
            <section
              key={suiteId}
              className="overflow-hidden rounded-md border border-[var(--score-border)] bg-[var(--score-card)]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--score-border)] px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--score-fg)]">
                    {SUITE_TITLES[suiteId]}
                  </div>
                  {summary && (
                    <div className="truncate text-[11px] text-[var(--score-muted)]">
                      {describeStoredScore(summary, pending)}
                    </div>
                  )}
                </div>
                {summary?.score !== null && summary?.score !== undefined && (
                  <span className="shrink-0 font-[family-name:var(--font-score-mono)] text-sm font-semibold tabular-nums text-[var(--score-fg)]">
                    {summary.score}
                    <span className="text-[10px] font-normal text-[var(--score-muted)]">
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
                      className="flex items-start gap-2 border-b border-[var(--score-border)] px-4 py-2 last:border-b-0"
                    >
                      <CheckIcon status={check.status ?? "skipped"} />
                      {check.pending ? (
                        <span
                          title="unscored by this run's profile"
                          className="mt-0.5 shrink-0 rounded-sm border border-[var(--score-border)] px-1 py-px text-[10px] leading-none text-[var(--score-muted)]"
                        >
                          unscored
                        </span>
                      ) : null}
                      <div className="min-w-0">
                        <div className="text-xs text-[var(--score-fg)]">
                          {check.title ?? check.id ?? "check"}
                        </div>
                        {check.error?.message && (
                          <div className="text-[11px] text-[#E8B4A8]">
                            {check.error.message}
                          </div>
                        )}
                        {!check.error?.message && check.skipReason && (
                          <div className="text-[11px] text-[var(--score-muted)]">
                            {check.skipReason}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-4 py-3 text-[11px] text-[var(--score-muted)]">
                  This suite reported no individual checks.
                </div>
              )}
            </section>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`${APP_ORIGIN}/servers`}
            className="inline-flex h-12 items-center rounded-sm bg-[var(--score-primary)] px-5 text-[15px] font-semibold text-[var(--score-primary-fg)]"
          >
            Debug these failures in MCPJam
          </a>
          <a
            href={routePaths.embedScore}
            className="inline-flex h-12 items-center rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-5 text-[15px] font-semibold text-[var(--score-primary)]"
          >
            Run your own scan
          </a>
        </div>
      </div>
    </ScoreSiteShell>
  );
}

function CenteredNotice({ title, body }: { title: string; body: string }) {
  return (
    <ScoreSiteShell preview="none">
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
        <h1 className="font-[family-name:var(--font-score-display)] text-2xl font-extrabold tracking-[-0.04em] text-[var(--score-fg)]">
          {title}
        </h1>
        <p className="max-w-md text-sm leading-6 text-[var(--score-muted)]">
          {body}
        </p>
        <a
          href={routePaths.embedScore}
          className="inline-flex h-12 items-center rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-5 text-[15px] font-semibold text-[var(--score-primary)]"
        >
          Run your own scan
        </a>
      </div>
    </ScoreSiteShell>
  );
}
