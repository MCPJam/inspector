import { describe, expect, it } from "vitest";
import type { InsightsAnalysisSummary } from "@/hooks/useUsageInsights";
import { analysisStatus, notRunNote, themesNote } from "../analysis-status";

const NOW = 1_000_000;
const clock = (ms: number) => `T+${(ms - NOW) / 60_000}m`;
const catalog = (version: number) => ({
  dimension: "goal",
  version,
  status: "idle",
  assigned: 1,
  unassigned: 0,
  sampleSize: 1,
});

function summary(
  overrides: Partial<InsightsAnalysisSummary> = {},
): InsightsAnalysisSummary {
  return {
    total: 1,
    analyzed: 0,
    pending: 0,
    running: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    awaitingTaxonomy: 0,
    unassigned: 0,
    staleAssignments: 0,
    projectionPending: 0,
    projectionFailed: 0,
    deferredUntil: null,
    lastAnalyzedAt: null,
    failures: {},
    skips: {},
    sampled: false,
    taxonomies: [],
    ...overrides,
  };
}

/**
 * Every empty view names its reason, and the most blocking reason wins: a
 * guest study says so even while a session waits; the daily limit beats a
 * queue that cannot drain; work in flight beats work still waiting.
 */
describe("analysisStatus", () => {
  it.each<[string, Partial<InsightsAnalysisSummary>, string, string, boolean]>([
    ["no sessions", { total: 0 }, "empty", "No sessions to show", false],
    [
      "a guest-owned study",
      { skipped: 1, skips: { guest_owned: 1 }, owed: 1, pending: 1 },
      "guest",
      "Not analyzed automatically",
      // A signed-in member's Analyze now works on a guest study; the panel
      // shows the button to members only.
      true,
    ],
    [
      "the daily limit",
      { deferred: 1, pending: 1, deferredUntil: NOW + 60 * 60_000 },
      "deferred",
      "Daily analysis limit reached",
      false,
    ],
    [
      "sessions queued or running",
      { pending: 3, owed: 1, running: 1 },
      "analyzing",
      "Analyzing 3 sessions…",
      false,
    ],
    [
      "a session still inside its settle window",
      { owed: 1, pending: 1, nextAnalysisAt: NOW + 2 * 60_000 },
      "waiting",
      "Waiting for the session to go quiet",
      true,
    ],
    [
      "a failure a retry may fix",
      { failed: 1, failures: { timeout: 1 } },
      "failed",
      "Analysis failed",
      true,
    ],
    [
      "a failure no retry fixes",
      { failed: 1, failures: { spend_cap_exceeded: 1 } },
      "failed",
      "Analysis failed",
      false,
    ],
    [
      "outcomes pending behind a published catalog",
      {
        analyzed: 1,
        provisional: 1,
        nextAnalysisAt: NOW + 27 * 60_000,
        taxonomies: [catalog(1)],
      },
      "provisional",
      "Outcomes are still coming",
      true,
    ],
    [
      "outcomes pending, but no catalog yet: the themes are the bigger story",
      { analyzed: 1, provisional: 1, taxonomies: [catalog(0)] },
      "grouping",
      "Grouping sessions into themes",
      false,
    ],
    [
      "analyzed, themes still coming",
      { analyzed: 1 },
      "grouping",
      "Grouping sessions into themes",
      false,
    ],
  ])("%s", (_name, overrides, kind, title, offersAnalyzeNow) => {
    const status = analysisStatus(summary(overrides), NOW, {
      formatTime: clock,
    });
    expect(status).toMatchObject({ kind, title });
    expect(status?.action === "analyze_now").toBe(offersAnalyzeNow);
  });

  it("says when the next pass is due, or that it is about to start", () => {
    expect(
      analysisStatus(
        summary({ owed: 1, pending: 1, nextAnalysisAt: NOW + 2 * 60_000 }),
        NOW,
        { formatTime: clock },
      )?.body,
    ).toBe("Analysis starts around T+2m, once no new messages arrive.");
    expect(
      analysisStatus(
        summary({ owed: 1, pending: 1, nextAnalysisAt: NOW - 1 }),
        NOW,
      )?.body,
    ).toBe("Analysis is about to start.");
    expect(
      analysisStatus(
        summary({ deferred: 1, deferredUntil: NOW + 60 * 60_000 }),
        NOW,
        { formatTime: clock },
      )?.body,
    ).toBe("Analysis resumes at T+60m.");
    expect(
      analysisStatus(
        summary({
          analyzed: 1,
          provisional: 1,
          nextAnalysisAt: NOW + 27 * 60_000,
          taxonomies: [catalog(1)],
        }),
        NOW,
        { formatTime: clock },
      )?.body,
    ).toBe("Outcomes fill in around T+27m, 30 minutes after the last message.");
  });

  it("reads an older backend's pending sessions as in flight, as before", () => {
    // No `owed` field: every pending session is counted as queued.
    expect(analysisStatus(summary({ pending: 2 }), NOW)).toMatchObject({
      kind: "analyzing",
      title: "Analyzing 2 sessions…",
    });
  });

  it("names a failure a reader can act on in plain words", () => {
    expect(
      analysisStatus(
        summary({ failed: 1, failures: { spend_cap_exceeded: 1 } }),
        NOW,
      )?.body,
    ).toBe("The workspace reached its AI spend limit.");
  });

  it("has nothing to say without a summary", () => {
    expect(analysisStatus(undefined, NOW)).toBeNull();
    expect(analysisStatus(null, NOW)).toBeNull();
  });
});

describe("themesNote", () => {
  it("labels a draft catalog with the sessions it still needs", () => {
    expect(
      themesNote(
        summary({ themes: { reason: "draft", sessionsUntilStable: 1 } }),
      ),
    ).toBe("Early themes. They settle after 1 more session.");
    expect(
      themesNote(
        summary({ themes: { reason: "draft", sessionsUntilStable: 0 } }),
      ),
    ).toBe("Early themes. They settle as more sessions arrive.");
  });

  it("stays silent for a stable catalog or an older backend", () => {
    expect(
      themesNote(summary({ themes: { reason: null, sessionsUntilStable: 0 } })),
    ).toBeNull();
    expect(
      themesNote(
        summary({ themes: { reason: "needs_review", sessionsUntilStable: 0 } }),
      ),
    ).toBeNull();
    expect(themesNote(summary())).toBeNull();
  });
});

/**
 * #5188: a wave refused at launch drew as 100% "Not analyzed", or as work in
 * flight while its zero-message sessions sat inside the idle window.
 */
describe("sessions that never ran", () => {
  it("says so when no session ran, ahead of analyzing and waiting", () => {
    const status = analysisStatus(
      summary({ total: 3, notRun: 3, owed: 3, pending: 3 }),
      NOW,
    );
    expect(status).toMatchObject({
      kind: "notRun",
      title: "These sessions didn't run",
    });
    expect(status?.action).toBeUndefined();
  });

  it("leaves the usual reading alone when some sessions ran", () => {
    expect(
      analysisStatus(summary({ total: 3, notRun: 1, running: 2 }), NOW)?.kind,
    ).toBe("analyzing");
  });

  it("says there is nothing to read when every transcript was empty", () => {
    // A backend without `notRun` reads the same refused wave this way.
    expect(
      analysisStatus(
        summary({
          total: 2,
          skipped: 2,
          skips: { empty_transcript: 2 },
        }),
        NOW,
      ),
    ).toMatchObject({ kind: "noTranscripts", title: "Nothing to analyze" });
  });

  it("names why when the same sessions are also skipped as empty", () => {
    // A current backend reports both for a refused wave once analysis has
    // read the empty transcripts; "didn't run" is the reason, so it wins.
    expect(
      analysisStatus(
        summary({
          total: 2,
          notRun: 2,
          skipped: 2,
          skips: { empty_transcript: 2 },
        }),
        NOW,
      )?.kind,
    ).toBe("notRun");
  });
});

describe("notRunNote", () => {
  it("counts the sessions that didn't run beside a drawn flow", () => {
    expect(notRunNote(summary({ total: 15, notRun: 8 }))).toBe(
      "8 sessions didn't run, so they have nothing to analyze.",
    );
    expect(notRunNote(summary({ total: 15, notRun: 1 }))).toBe(
      "1 session didn't run, so it has nothing to analyze.",
    );
  });

  it("stays silent when every session ran, or none did", () => {
    expect(notRunNote(summary({ total: 3, notRun: 0 }))).toBeNull();
    expect(notRunNote(summary({ total: 3 }))).toBeNull();
    // None ran: the status panel says it, not a note under a diagram.
    expect(notRunNote(summary({ total: 3, notRun: 3 }))).toBeNull();
    expect(notRunNote(null)).toBeNull();
  });
});
