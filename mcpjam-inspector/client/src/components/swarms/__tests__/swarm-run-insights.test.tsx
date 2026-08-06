import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SwarmFinding,
  SwarmWaveDiscoveryFinding,
  SwarmWaveInsightCandidate,
  SwarmWaveInsights,
  SwarmWaveInsightsDto,
  SwarmWaveSignalCandidate,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import {
  SwarmRunInsights,
  signalFingerprint,
  signalSentence,
} from "../swarm-run-insights";

/**
 * Swarm run insights — ONE list over two lanes.
 *
 * The property this suite exists to protect: a signal and its generated
 * explanation render as a SINGLE row. They were previously two stacked
 * sections, and the model dutifully restated each signal in its own words —
 * the same finding twice, at twice the height. Here the deterministic sentence
 * is the headline and the model contributes cause + fix behind the expand.
 */

const { state } = vi.hoisted(() => ({
  state: {
    signals: undefined as SwarmWaveSignals | null | undefined,
    dto: undefined as SwarmWaveInsightsDto | null | undefined,
    findings: [] as SwarmFinding[],
    requestMock: vi.fn(),
    cancelMock: vi.fn(),
    dismissMock: vi.fn(),
    undismissMock: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string) => {
    if (name.includes("getWaveSignals")) return state.signals;
    if (name.includes("listSwarmFindings")) return state.findings;
    return state.dto;
  },
  useMutation: (name: string) => {
    if (name.includes("requestWaveInsights")) return state.requestMock;
    if (name.includes("cancelWaveInsights")) return state.cancelMock;
    if (name.includes("undismissFinding")) return state.undismissMock;
    if (name.includes("dismissFinding")) return state.dismissMock;
    return vi.fn();
  },
}));

const FINGERPRINT = "no_tools_used:journey:j-1";

function signal(
  overrides: Partial<SwarmWaveSignalCandidate> = {},
): SwarmWaveSignalCandidate {
  return {
    detector: "no_tools_used",
    subjectKind: "journey",
    subjectId: "j-1",
    subjectLabel: "Restore diagram from checkpoint",
    affectedSessions: 2,
    sliceTotal: 2,
    exemplarSessionIds: ["s-1"],
    contrastSessionIds: [],
    severityScore: 3,
    ...overrides,
  };
}

function signals(overrides: Partial<SwarmWaveSignals> = {}): SwarmWaveSignals {
  return {
    candidates: [signal()],
    sessionCount: 20,
    unanalyzedSessionCount: 0,
    judgeCoverage: { graded: 0, total: 20 },
    truncated: false,
    lowConfidence: false,
    terminal: true,
    ...overrides,
  };
}

function insightCandidate(
  overrides: Partial<SwarmWaveInsightCandidate> = {},
): SwarmWaveInsightCandidate {
  return {
    fingerprint: FINGERPRINT,
    detector: "no_tools_used",
    subjectKind: "journey",
    subjectId: "j-1",
    subjectLabel: "Restore diagram from checkpoint",
    affectedSessions: 2,
    sliceTotal: 2,
    evidenceSessionIds: ["s-1"],
    contrastSessionIds: [],
    evidenceTruncated: false,
    rootCause:
      "The restore tool is advertised but its description omits the checkpoint id argument.",
    recommendation: "Document the checkpoint id parameter in the tool schema.",
    confidence: "high",
    ...overrides,
  };
}

function insights(
  overrides: Partial<SwarmWaveInsights> = {},
): SwarmWaveInsights {
  return {
    summary: "Agents answered with advice instead of calling the restore tool.",
    generatedAt: 1_000,
    modelUsed: "openai/gpt-5.4-mini",
    providerKey: "gateway",
    judgeCoverage: { graded: 0, total: 20 },
    sessionCount: 20,
    unanalyzedSessionCount: 0,
    truncated: false,
    lowConfidence: false,
    candidates: [insightCandidate()],
    unnarratedCandidates: [],
    ...overrides,
  };
}

function completed(
  over: Partial<SwarmWaveInsights> = {},
): SwarmWaveInsightsDto {
  return {
    status: "completed",
    insights: insights(over),
    discovery: null,
    errorCode: null,
    errorMessage: null,
    updatedAt: 1,
  };
}

function finding(overrides: Partial<SwarmFinding> = {}): SwarmFinding {
  return {
    findingId: "f-1",
    fingerprint: FINGERPRINT,
    dimension: "no_tools_used",
    subjectKind: "journey",
    subjectId: "j-1",
    subjectLabel: "Restore diagram from checkpoint",
    status: "recurring",
    firstSeenAt: 1,
    lastSeenAt: 2,
    lastSeenGroupId: "run-1",
    occurrenceCount: 3,
    resolvedAt: null,
    dismissedAt: null,
    updatedAt: 2,
    ...overrides,
  };
}

function renderInsights() {
  const onOpenSession = vi.fn();
  render(
    <SwarmRunInsights
      projectId="proj-1"
      swarmRunGroupId="run-1"
      onOpenSession={onOpenSession}
    />,
  );
  return onOpenSession;
}

beforeEach(() => {
  state.signals = signals();
  state.dto = null;
  state.findings = [];
  state.requestMock = vi.fn().mockResolvedValue(undefined);
  state.cancelMock = vi.fn().mockResolvedValue(undefined);
  state.dismissMock = vi.fn().mockResolvedValue(undefined);
  state.undismissMock = vi.fn().mockResolvedValue(undefined);
});

describe("one row per problem", () => {
  it("renders the deterministic sentence ONCE, not beside a model restatement", () => {
    state.dto = completed();
    renderInsights();
    expect(screen.getAllByTestId("swarm-run-insight")).toHaveLength(1);
    expect(screen.getByTestId("swarm-run-insight-headline")).toHaveTextContent(
      /never called a tool/i,
    );
    // The model's contribution lives behind the expand, never as a second
    // headline saying the same thing.
    expect(
      screen.queryByTestId("swarm-run-insight-detail"),
    ).not.toBeInTheDocument();
  });

  it("shows signals immediately, before any generation exists", () => {
    // The deterministic lane must never wait on the model — a run with no
    // insights row yet is still fully readable.
    state.dto = null;
    renderInsights();
    expect(screen.getByTestId("swarm-run-insight-headline")).toHaveTextContent(
      /never called a tool/i,
    );
  });

  it("enriches the matching row with why and fix on expand", () => {
    state.dto = completed();
    renderInsights();
    fireEvent.click(screen.getByTestId("swarm-run-insight-headline"));
    const detail = screen.getByTestId("swarm-run-insight-detail");
    expect(detail).toHaveTextContent(/Why:/);
    expect(detail).toHaveTextContent(/omits the checkpoint id/);
    expect(detail).toHaveTextContent(/Fix:/);
  });

  it("joins signal to insight by the backend fingerprint scheme", () => {
    expect(signalFingerprint(signal())).toBe(FINGERPRINT);
    // Drift from the backend scheme shows up as rows that never enrich.
    state.dto = completed({
      candidates: [insightCandidate({ fingerprint: "mismatched" })],
    });
    renderInsights();
    fireEvent.click(screen.getByTestId("swarm-run-insight-headline"));
    expect(
      screen.getByTestId("swarm-run-insight-detail"),
    ).not.toHaveTextContent(/Why:/);
  });

  it("collapses to the top three, expandable to all", () => {
    state.signals = signals({
      candidates: [
        signal({ subjectId: "a" }),
        signal({ subjectId: "b" }),
        signal({ subjectId: "c" }),
        signal({ subjectId: "d" }),
      ],
    });
    renderInsights();
    expect(screen.getAllByTestId("swarm-run-insight")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("swarm-run-insights-toggle"));
    expect(screen.getAllByTestId("swarm-run-insight")).toHaveLength(4);
  });

  it("opens evidence and contrast sessions from the expanded row", () => {
    state.signals = signals({
      candidates: [signal({ contrastSessionIds: ["s-9"] })],
    });
    const onOpenSession = renderInsights();
    fireEvent.click(screen.getByTestId("swarm-run-insight-headline"));
    const links = screen.getAllByTestId("swarm-run-insight-session-link");
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]!);
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
  });
});

describe("summary and caveats", () => {
  it("leads with the summary and demotes caveats to the footer", () => {
    state.dto = completed();
    renderInsights();
    expect(screen.getByTestId("swarm-run-insights-summary")).toHaveTextContent(
      /answered with advice instead of calling the restore tool/i,
    );
    // Coverage is a footnote, not a preamble — a reader scanning for what to
    // fix should not have to read past a disclaimer to reach it.
    expect(screen.getByText(/no judge verdicts/i)).toBeInTheDocument();
  });

  it("reports partial-data caveats compactly rather than as prose", () => {
    state.signals = signals({ lowConfidence: true, truncated: true });
    state.dto = completed({
      unnarratedCandidates: [
        {
          fingerprint: "x:y:z",
          detector: "latency_outlier",
          subjectLabel: "Cursor",
          affectedSessions: 3,
          sliceTotal: 9,
        },
      ],
    });
    renderInsights();
    expect(screen.getByText(/still analyzing/i)).toBeInTheDocument();
    expect(screen.getByText(/newest sessions only/i)).toBeInTheDocument();
    expect(screen.getByText(/1 more not explained/i)).toBeInTheDocument();
  });

  it("waits for the run to finish", () => {
    state.signals = signals({ terminal: false });
    renderInsights();
    expect(
      screen.getByTestId("swarm-run-insights-pending-run"),
    ).toHaveTextContent(/when the run finishes/i);
    expect(screen.queryByTestId("swarm-run-insight")).not.toBeInTheDocument();
  });

  it("renders nothing while signals load", () => {
    state.signals = undefined;
    renderInsights();
    expect(screen.queryByTestId("swarm-run-insights")).not.toBeInTheDocument();
  });

  it("reports a clean run", () => {
    state.signals = signals({ candidates: [] });
    renderInsights();
    expect(screen.getByTestId("swarm-run-insights-empty")).toHaveTextContent(
      /no anomalies detected across 20 sessions/i,
    );
  });
});

describe("generation lifecycle", () => {
  it("auto-requests once for a finished run with no insights row", async () => {
    state.dto = null;
    renderInsights();
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));
  });

  it("does not request while the run is still going", async () => {
    state.signals = signals({ terminal: false });
    state.dto = null;
    renderInsights();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.requestMock).not.toHaveBeenCalled();
  });

  it("keeps signals readable when generation fails", () => {
    state.dto = {
      status: "failed",
      insights: null,
      discovery: null,
      errorCode: "spend_cap_exceeded",
      errorMessage: "Spending cap reached — insights were not generated.",
      updatedAt: 1,
    };
    renderInsights();
    expect(screen.getByTestId("swarm-run-insights-error")).toHaveTextContent(
      /spending cap/i,
    );
    // The deterministic rows survive a failed generation.
    expect(screen.getByTestId("swarm-run-insight")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("swarm-run-insights-retry"));
    expect(state.requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("SHOWS an entitlement rejection rather than hiding", async () => {
    // Convex prefixes "Server Error" onto thrown mutation errors, so a billing
    // rejection would be misread as unavailability without an explicit branch.
    state.dto = null;
    state.requestMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Server Error: Limit "insightsPerDay" reached on the free plan.',
        ),
      );
    renderInsights();
    await waitFor(() =>
      expect(screen.getByTestId("swarm-run-insights-error")).toHaveTextContent(
        /daily insights limit/i,
      ),
    );
  });
});

describe("registry lifecycle", () => {
  it("chips a recurring finding with its occurrence count", () => {
    state.dto = completed();
    state.findings = [finding()];
    renderInsights();
    expect(screen.getByTestId("swarm-run-insight-status")).toHaveTextContent(
      "Recurring ×3",
    );
  });

  it("dismisses optimistically and reverts when the write fails", async () => {
    state.dto = completed();
    state.findings = [finding()];
    state.dismissMock = vi.fn().mockRejectedValue(new Error("nope"));
    renderInsights();

    fireEvent.click(screen.getByTestId("swarm-run-insight-dismiss"));
    expect(screen.getByTestId("swarm-run-insight")).toHaveAttribute(
      "data-dismissed",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByTestId("swarm-run-insight")).toHaveAttribute(
        "data-dismissed",
        "false",
      ),
    );
  });
});

describe("Lane B discovery", () => {
  const observation: SwarmWaveDiscoveryFinding = {
    kind: "observation",
    slug: "opaque_error_payload",
    title: "search_flights returns an opaque error string",
    detail: "Three sessions guessed the date format instead of being told.",
    sessionIds: ["s-1"],
    confidence: "medium",
  };

  const withDiscovery = (
    findings: SwarmWaveDiscoveryFinding[],
  ): SwarmWaveInsightsDto => ({
    ...completed(),
    discovery: {
      generatedAt: 2_000,
      modelUsed: "anthropic/claude-sonnet-5",
      providerKey: "gateway",
      sampledSessionIds: ["s-1", "s-2", "s-3"],
      findings,
    },
  });

  it("stays collapsed behind a labelled toggle — weaker evidence, quieter", () => {
    state.dto = withDiscovery([observation]);
    renderInsights();
    expect(screen.getByTestId("swarm-run-discovery-toggle")).toHaveTextContent(
      /not measured by any check/i,
    );
    expect(
      screen.queryByTestId("swarm-run-discovery-finding"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("swarm-run-discovery-toggle"));
    expect(screen.getByTestId("swarm-run-discovery-finding")).toHaveTextContent(
      /opaque error string/i,
    );
  });

  it("shows a suggested check as a copyable predicate", () => {
    state.dto = withDiscovery([
      {
        ...observation,
        kind: "suggested_check",
        suggestedCheck: {
          type: "toolCalledAtLeastOnce",
          toolName: "search_flights",
        },
      },
    ]);
    renderInsights();
    fireEvent.click(screen.getByTestId("swarm-run-discovery-toggle"));
    expect(screen.getByTestId("swarm-run-discovery-check")).toHaveTextContent(
      "toolCalledAtLeastOnce(search_flights)",
    );
  });

  it("hides against a backend without Lane B", () => {
    state.dto = completed();
    renderInsights();
    expect(screen.queryByTestId("swarm-run-discovery")).not.toBeInTheDocument();
  });
});

describe("signalSentence", () => {
  it("phrases the missing-capability signal around the invented name", () => {
    expect(
      signalSentence(
        signal({
          detector: "hallucinated_tool",
          subjectLabel: "cancel_booking",
          affectedSessions: 1,
        }),
      ),
    ).toBe('Agents invented a tool named "cancel_booking" in 1 session');
  });

  it("phrases relative detectors against the rest of the run", () => {
    expect(
      signalSentence(
        signal({
          detector: "token_outlier",
          subjectLabel: "Reconcile payouts",
          metric: 10_000,
          waveMetric: 2_000,
        }),
      ),
    ).toContain("5.0×");
  });

  it("never divides by a missing comparison", () => {
    expect(
      signalSentence(
        signal({
          detector: "latency_outlier",
          subjectLabel: "Cursor",
          metric: 30_000,
          waveMetric: undefined,
        }),
      ),
    ).toContain("well above");
  });
});

describe("rail density", () => {
  it("clamps a long summary behind a toggle so the rows stay in view", () => {
    // The rail is ~40% of the width; an unclamped paragraph pushed the
    // problem rows out of the viewport and cut itself off mid-word.
    state.dto = completed({ summary: "x".repeat(200) });
    renderInsights();
    fireEvent.click(screen.getByTestId("swarm-run-insights-summary-toggle"));
    expect(
      screen.getByTestId("swarm-run-insights-summary-toggle"),
    ).toHaveTextContent("Less");
  });

  it("leaves a short summary unclamped", () => {
    state.dto = completed({ summary: "Fix the restore tool description." });
    renderInsights();
    expect(
      screen.queryByTestId("swarm-run-insights-summary-toggle"),
    ).not.toBeInTheDocument();
  });
});
