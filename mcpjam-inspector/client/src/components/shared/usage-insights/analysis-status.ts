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
  | "notRun"
  | "noTranscripts"
  | "guest"
  | "deferred"
  | "analyzing"
  | "waiting"
  | "failed"
  | "provisional"
  | "grouping";

export type AnalysisStatus = {
  kind: AnalysisStatusKind;
  title: string;
  body: string;
  /** Analyze now: treat the sessions as finished and analyze them. */
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

  // Sessions that never ran are not waiting on analysis, and no pass will
  // ever mark them (#5188). When that is every session it is the whole story,
  // and it outranks "Analyzing" and "Waiting": a zero-message session still
  // inside the idle window counts as owed, which read as work in flight on a
  // wave that was refused at launch.
  const notRun = summary.notRun ?? 0;
  if (notRun > 0 && notRun >= summary.total)
    return {
      kind: "notRun",
      title: "These sessions didn't run",
      body: "None of them recorded a message, so there is nothing to analyze.",
    };

  // Every session was read and had nothing in it. A backend without `notRun`
  // lands here for the same refused wave, and so does a study whose sessions
  // are all empty. Either way no analysis is coming.
  const emptyTranscripts = summary.skips.empty_transcript ?? 0;
  if (emptyTranscripts > 0 && emptyTranscripts >= summary.total)
    return {
      kind: "noTranscripts",
      title: "Nothing to analyze",
      body: "None of these sessions recorded a message.",
    };

  // Worded for both readers: a guest owner learns why nothing ran, and a
  // signed-in member gets Analyze now, which works on a guest study.
  if ((summary.skips.guest_owned ?? 0) > 0 && summary.analyzed === 0)
    return {
      kind: "guest",
      title: "Not analyzed automatically",
      body: "Sessions in a guest study are analyzed only when a signed-in member asks.",
      action: "analyze_now",
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

  // Analyzed before the outcome could be asserted: the flow is drawn, and
  // its outcome column reads "Analyzing" until the final pass. Only once a
  // catalog exists; before that the missing themes are the bigger story.
  if (
    (summary.provisional ?? 0) > 0 &&
    summary.taxonomies.some((t) => t.version > 0)
  ) {
    const due = summary.nextAnalysisAt;
    return {
      kind: "provisional",
      title: "Outcomes are still coming",
      body:
        due && due > now
          ? `Outcomes fill in around ${clock(due)}, 30 minutes after the last message.`
          : "Outcomes fill in shortly.",
      action: "analyze_now",
    };
  }

  if (summary.analyzed > 0)
    return {
      kind: "grouping",
      title: "Grouping sessions into themes",
      body: summary.taxonomies.some((t) => t.errorCode)
        ? "Theme discovery ran into a problem. The sessions are analyzed, and their themes appear once it succeeds."
        : "Themes appear as sessions are grouped.",
    };

  return null;
}

/**
 * The one muted line under Session flow when SOME sessions never ran (#5188).
 * The diagram is drawn from the sessions that did; this says the rest were
 * not lost, and that nothing about them was analyzed because there was
 * nothing to read. When none ran, `analysisStatus` says so instead.
 */
export function notRunNote(
  summary: InsightsAnalysisSummary | null | undefined,
): string | null {
  const notRun = summary?.notRun ?? 0;
  if (notRun <= 0 || notRun >= (summary?.total ?? 0)) return null;
  return `${sessions(notRun)} didn't run, so ${
    notRun === 1 ? "it has" : "they have"
  } nothing to analyze.`;
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
