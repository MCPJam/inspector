import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { CheckCircle2, Loader2, MinusCircle, Plus, XCircle } from "lucide-react";
import { routePaths } from "@/lib/app-navigation";
import {
  fetchScoreRun,
  ScoreRunNotFoundError,
  type ScoreSummary,
  type StoredScoreRun,
} from "@/lib/apis/score-api";
import {
  isScorePreviewResultToken,
  scorePreviewRun,
} from "./score-preview-run";
import { ScoreServerMark } from "./score-server-mark";
import { ScoreSiteShell } from "./ScoreSiteShell";

const APP_ORIGIN = "https://app.mcpjam.com";

const SUITE_TITLES: Record<string, string> = {
  protocol: "Protocol",
  apps: "Apps",
  tasks: "Tasks",
  oauth: "OAuth",
};

const SUITE_BLURBS: Record<string, string> = {
  protocol: "Handshake, tools, resources, and protocol rules.",
  apps: "Did the server work from a real client?",
  tasks: "Evals and user-flow runs. Did real tasks land?",
  oauth: "Authorization, tokens, and client registration.",
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
      }`,
    );
  }
  if (pending > 0) {
    parts.push(`${pending} not scored in this run`);
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

/** Hostname without the common `mcp.` service prefix — "monday.com". */
function displayServerName(serverUrl: string): string {
  return displayHost(serverUrl).replace(/^mcp\./, "");
}

function formatScanTime(createdAt: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));
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

function runTakeaway(
  run: StoredScoreRun,
  failedSuites: number,
  incompleteSuites: number,
): string {
  const score = run.score === null ? "—" : String(run.score);
  if (failedSuites === 1) {
    return `One suite failed, so this run did not pass. ${score} is how much still held.`;
  }
  if (failedSuites > 1) {
    return `${failedSuites} suites failed, so this run did not pass. ${score} is how much still held.`;
  }
  if (incompleteSuites > 0) {
    return `The run is incomplete. ${score} is what we could grade.`;
  }
  if (run.advisoryCount > 0) {
    return `Every suite passed, with notes to review. ${score} is the graded score.`;
  }
  return `Every suite passed. ${score} is the graded score.`;
}

function StatusPill({
  status,
  emphasize,
}: {
  status: string;
  emphasize: boolean;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-sm px-2 text-[10px] font-semibold tracking-[0.08em] ${
        emphasize
          ? "bg-[var(--score-primary)]/15 text-[var(--score-primary)]"
          : "bg-[#3D8A5A]/15 text-[#3D8A5A]"
      }`}
    >
      {status}
    </span>
  );
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
    if (import.meta.env.DEV && isScorePreviewResultToken(runToken)) {
      setError(null);
      setNotFound(false);
      setRun(scorePreviewRun());
      return;
    }
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

  const host = displayHost(run.serverUrl);
  const serverName = displayServerName(run.serverUrl);
  const scoreLabel = run.score === null ? "—" : String(run.score);
  const observed = run.applicable + run.notApplicable + pendingTotal;
  const failedSuites = suites.filter(
    (suite) => suite.summary?.outcome === "failed",
  ).length;
  const incompleteSuites = suites.filter(
    (suite) => suite.summary?.outcome === "incomplete",
  ).length;
  const ledger = [
    { key: "passed", label: `${run.passed} passed`, share: run.passed, tone: "passed" },
    { key: "failed", label: `${run.failed} failed`, share: run.failed, tone: "failed" },
    {
      key: "could-not-run",
      label: `${run.couldNotRun} could not run`,
      share: run.couldNotRun,
      tone: "warn",
    },
    {
      key: "n-a",
      label: `${run.notApplicable} not applicable`,
      share: run.notApplicable,
      tone: "muted",
    },
    {
      key: "pending",
      label: `${pendingTotal} not scored in this run`,
      share: pendingTotal,
      tone: "pending",
    },
  ].filter((segment) => segment.share > 0);

  return (
    <ScoreSiteShell preview="none">
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="font-[family-name:var(--font-score-display)] text-[clamp(2rem,4vw,2.75rem)] font-extrabold leading-none tracking-[-0.04em] text-[var(--score-fg)]">
            {serverName} Scorecard
          </h1>
          <p className="max-w-[640px] text-[15px] leading-6 text-[var(--score-muted)]">
            Assessments across reliability, conformance (protocol, apps, OAuth),
            and security.
          </p>
        </div>

        <section className="score-grade-card rounded-md border border-[var(--score-border)] bg-[var(--score-card)] p-6 md:p-8">
          <div
            aria-hidden="true"
            className="score-grade-card-orb score-grade-card-orb--bloom"
          />
          <div
            aria-hidden="true"
            className="score-grade-card-orb score-grade-card-orb--ember"
          />
          <div className="relative flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-medium uppercase leading-[14px] tracking-[0.12em] text-[var(--score-primary)]">
              <span>Overall score</span>
              <span aria-hidden="true">·</span>
              <span>Scanned {formatScanTime(run.createdAt)}</span>
              {run.protocolVersion ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Protocol {run.protocolVersion}</span>
                </>
              ) : null}
            </div>
            <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
              <div className="flex items-end gap-2">
                <div className="font-[family-name:var(--font-score-display)] text-[80px] font-extrabold leading-none tracking-[-0.05em] text-[var(--score-fg)]">
                  {scoreLabel}
                </div>
                <div className="mb-2 font-[family-name:var(--font-score-display)] text-[28px] font-extrabold leading-none text-[var(--score-muted)]">
                  /100
                </div>
              </div>
              <div className="flex flex-col items-start gap-1.5 md:items-end">
                <div className="flex items-center gap-2.5">
                  <ScoreServerMark host={host} />
                  <div className="text-lg font-semibold leading-6 text-[var(--score-fg)]">
                    {host}
                  </div>
                </div>
                <div className="font-[family-name:var(--font-score-mono)] text-[13px] leading-[18px] text-[var(--score-muted)]">
                  {run.serverUrl}
                </div>
              </div>
            </div>
            <p className="max-w-[420px] rounded-sm bg-[var(--score-surface)] px-3 py-2 text-[13px] leading-5 text-[var(--score-fg)]">
              {runTakeaway(run, failedSuites, incompleteSuites)}
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--score-muted)]">
            How it breaks down
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {suites.map(({ suiteId, summary }) => {
              const { status, emphasize } = suiteStatus(summary);
              return (
                <article
                  key={suiteId}
                  className="flex flex-col gap-4 rounded-md border border-[var(--score-border)] bg-[var(--score-surface)] p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium text-[var(--score-fg)]">
                      {SUITE_TITLES[suiteId]}
                    </div>
                    <StatusPill status={status} emphasize={emphasize} />
                  </div>
                  <div className="font-[family-name:var(--font-score-display)] text-[40px] font-extrabold leading-none tracking-[-0.04em] text-[var(--score-fg)]">
                    {summary?.score === null || summary?.score === undefined
                      ? "—"
                      : summary.score}
                  </div>
                  <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--score-muted)]">
                    {summary
                      ? `${summary.passed} / ${summary.applicable} applicable`
                      : "No summary"}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-4 rounded-md border border-[var(--score-border)] bg-[var(--score-surface)] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-[var(--score-fg)]">
              Check ledger
            </h2>
            <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--score-muted)]">
              {observed} checks observed
            </div>
          </div>
          <div className="flex h-3 overflow-hidden rounded-sm">
            {ledger.map((segment) => (
              <div
                key={segment.key}
                className={
                  segment.tone === "passed"
                    ? "bg-[#3D8A5A]"
                    : segment.tone === "failed"
                      ? "bg-[#C45A3A]"
                      : segment.tone === "warn"
                        ? "bg-[#C49A4A]"
                        : segment.tone === "pending"
                          ? "score-ledger-pending"
                          : "bg-[var(--score-border)]"
                }
                style={{ flex: `${segment.share} 1 0%` }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-[var(--score-muted)]">
            {ledger.map((segment) => (
              <li key={segment.key} className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    segment.tone === "passed"
                      ? "bg-[#3D8A5A]"
                      : segment.tone === "failed"
                        ? "bg-[#C45A3A]"
                        : segment.tone === "warn"
                          ? "bg-[#C49A4A]"
                          : segment.tone === "pending"
                            ? "border border-[var(--score-muted)] bg-transparent"
                            : "bg-[var(--score-border)]"
                  }`}
                />
                {segment.label}
              </li>
            ))}
          </ul>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--score-border)] bg-[var(--score-surface)]">
          {suites.map(({ suiteId, summary, checks, pending }, index) => {
            const { status, emphasize } = suiteStatus(summary);
            return (
              <details
                key={suiteId}
                className={`group ${
                  index < suites.length - 1
                    ? "border-b border-[var(--score-border)]"
                    : ""
                }`}
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 [&::-webkit-details-marker]:hidden">
                  <Plus
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-[var(--score-primary)] transition-transform group-open:rotate-45"
                  />
                  <div className="min-w-0 grow">
                    <div className="text-sm font-semibold text-[var(--score-fg)]">
                      {SUITE_TITLES[suiteId]}
                    </div>
                    <div className="text-[13px] leading-5 text-[var(--score-muted)]">
                      {SUITE_BLURBS[suiteId] ??
                        (summary
                          ? describeStoredScore(summary, pending)
                          : "No checks in this suite.")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {summary?.score !== null &&
                      summary?.score !== undefined && (
                        <span className="flex items-baseline gap-3 font-[family-name:var(--font-score-display)] text-[22px] font-extrabold leading-none tracking-[-0.04em] text-[var(--score-fg)]">
                          {summary.score}
                          <span className="text-[12px] font-medium text-[var(--score-muted)]">
                            {summary.passed}/{summary.applicable}
                          </span>
                        </span>
                      )}
                    <StatusPill status={status} emphasize={emphasize} />
                  </div>
                </summary>
                {checks.length > 0 ? (
                  <ul className="border-t border-[var(--score-border)]">
                    {checks.map((check, checkIndex) => (
                      <li
                        key={check.id ?? checkIndex}
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
                  <div className="border-t border-[var(--score-border)] px-4 py-3 text-[11px] text-[var(--score-muted)]">
                    This suite reported no individual checks.
                  </div>
                )}
              </details>
            );
          })}
        </section>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <a
            href={routePaths.embedScore}
            className="inline-flex h-12 items-center rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-5 text-[15px] font-semibold text-[var(--score-primary)] hover:border-[var(--score-primary)]"
          >
            Run another scan
          </a>
          <a
            href={`${APP_ORIGIN}/servers`}
            className="inline-flex h-12 items-center rounded-sm bg-[var(--score-primary)] px-5 text-[15px] font-semibold text-[var(--score-primary-fg)] hover:opacity-90"
          >
            Debug in MCPJam
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
          className="inline-flex h-12 items-center rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-5 text-[15px] font-semibold text-[var(--score-primary)] hover:border-[var(--score-primary)]"
        >
          Run another scan
        </a>
      </div>
    </ScoreSiteShell>
  );
}
