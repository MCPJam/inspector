import type { InsightsAnalysisSummary } from "@/hooks/useUsageInsights";

/**
 * What an empty insights view says about itself.
 *
 * An empty Session flow or Findings tab used to say "a few minutes" whatever
 * the reason, so a study waiting on its first session, one refused by the
 * daily limit and one whose analysis failed all read the same. This names the
 * reason from the analysis summary the breakdown already carries: one title,
 * one sentence, and at most one action. First match wins, most blocking first.
 *
 * Pure, so both surfaces and their tests share one reading of the summary.
 */
export type AnalysisStatusKind =
  | "empty"
  | "guest"
  | "deferred"
  | "analyzing"
  | "waiting"
  | "failed"
  | "grouping";

export type AnalysisStatus = {
  kind: AnalysisStatusKind;
  title: string;
  body: string;
  /** Analyze now: treat the quiet sessions as finished and analyze them. */
  action?: "analyze_now";
};

/**
 * Plain words for failures no retry fixes, so they carry no Analyze now.
 * Anything else is offered a retry.
 */
const FAILURE_COPY: Record<string, string> = {
  spend_cap_exceeded: "The workspace reached its AI spend limit.",
  missing_api_key: "No model key is configured for analysis.",
  no_billing_subject: "This study has no owner to bill the analysis to.",
  empty_transcript: "The session has no messages to analyze.",
};

function defaultClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sessions(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

export function analysisStatus(
  summary: InsightsAnalysisSummary | null | undefined,
  now: number,
  options: { formatTime?: (ms: number) => string } = {},
): AnalysisStatus | null {
  if (!summary) return null;
  const clock = options.formatTime ?? defaultClock;

  if (summary.total === 0)
    return {
      kind: "empty",
      title: "No sessions to show",
      body: "New sessions are analyzed shortly after their last message.",
    };

  if ((summary.skips.guest_owned ?? 0) > 0 && summary.analyzed === 0)
    return {
      kind: "guest",
      title: "Sign in to analyze sessions",
      body: "Sessions in a guest study are not analyzed automatically.",
    };

  if (summary.deferred > 0)
    return {
      kind: "deferred",
      title: "Daily analysis limit reached",
      body: summary.deferredUntil
        ? `Analysis resumes at ${clock(summary.deferredUntil)}.`
        : "Analysis resumes tomorrow.",
    };

  // `pending` also counts owed sessions on a current backend; an older one
  // sends no `owed` and every pending session reads as queued, as before.
  const owed = summary.owed ?? 0;
  const inFlight =
    summary.running + Math.max(0, summary.pending - owed - summary.deferred);
  if (inFlight > 0)
    return {
      kind: "analyzing",
      title: `Analyzing ${sessions(inFlight)}…`,
      body: "Each one usually takes under a minute.",
    };

  // The backend computes when: minutes after the last message for User
  // Testing, the idle window for a swarm session its run has not ended.
  if (owed > 0) {
    const due = summary.nextAnalysisAt;
    return {
      kind: "waiting",
      title: "Waiting for the session to go quiet",
      body:
        due && due > now
          ? `Analysis starts around ${clock(due)}, once no new messages arrive.`
          : "Analysis is about to start.",
      action: "analyze_now",
    };
  }

  if (summary.failed > 0 && summary.analyzed === 0) {
    const [reason] =
      Object.entries(summary.failures).sort((a, b) => b[1] - a[1])[0] ?? [];
    const known = reason ? FAILURE_COPY[reason] : undefined;
    return {
      kind: "failed",
      title: "Analysis failed",
      body: known ?? "Something went wrong analyzing these sessions.",
      ...(known ? {} : { action: "analyze_now" as const }),
    };
  }

  if (summary.analyzed > 0)
    return {
      kind: "grouping",
      title: "Grouping sessions into themes",
      body: summary.taxonomies.some((t) => t.errorCode)
        ? "Theme discovery ran into a problem. The sessions are analyzed, and their themes appear once it succeeds."
        : "Themes appear a minute or two after the first session is analyzed.",
    };

  return null;
}

/**
 * The one muted line under Session flow when its themes are provisional.
 * Not an empty state: the diagram is drawn, and this says how far to trust it.
 */
export function themesNote(
  summary: InsightsAnalysisSummary | null | undefined,
): string | null {
  const themes = summary?.themes;
  if (themes?.reason !== "draft") return null;
  // Scope-wide, from the catalog: `total` above is the filtered population.
  const more = themes.sessionsUntilStable;
  return more > 0
    ? `Early themes. They settle after ${more} more ${more === 1 ? "session" : "sessions"}.`
    : "Early themes. They settle as more sessions arrive.";
}
