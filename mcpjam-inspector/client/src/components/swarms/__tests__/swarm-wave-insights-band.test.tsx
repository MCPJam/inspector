import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SwarmFinding,
  SwarmWaveDiscoveryFinding,
  SwarmWaveInsightCandidate,
  SwarmWaveInsights,
  SwarmWaveInsightsDto,
} from "@/lib/swarm-api";
import { SwarmWaveInsightsBand } from "../swarm-wave-insights-band";

/**
 * Wave insights band — Lane A's surface.
 *
 * The behaviours worth pinning: it auto-requests exactly once and only for a
 * finished swarm, it self-hides rather than breaking the tab when the backend
 * lacks the feature, an entitlement rejection is SHOWN (not swallowed as
 * unavailability), and dismissal is optimistic but reverts on failure.
 */

const { state } = vi.hoisted(() => ({
  state: {
    dto: undefined as SwarmWaveInsightsDto | null | undefined,
    findings: [] as SwarmFinding[],
    requestMock: vi.fn(),
    cancelMock: vi.fn(),
    dismissMock: vi.fn(),
    undismissMock: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string) =>
    name.includes("listSwarmFindings") ? state.findings : state.dto,
  useMutation: (name: string) => {
    if (name.includes("requestWaveInsights")) return state.requestMock;
    if (name.includes("cancelWaveInsights")) return state.cancelMock;
    if (name.includes("undismissFinding")) return state.undismissMock;
    if (name.includes("dismissFinding")) return state.dismissMock;
    return vi.fn();
  },
}));

function candidate(
  overrides: Partial<SwarmWaveInsightCandidate> = {},
): SwarmWaveInsightCandidate {
  return {
    fingerprint: "tool_errors:tool:search_flights",
    detector: "tool_errors",
    subjectKind: "tool",
    subjectId: "search_flights",
    subjectLabel: "search_flights",
    affectedSessions: 4,
    sliceTotal: 9,
    evidenceSessionIds: ["s-1"],
    contrastSessionIds: ["s-9"],
    evidenceTruncated: false,
    claim: "search_flights fails on date-shaped arguments.",
    rootCause: "The description omits the epoch-only format.",
    recommendation: "Document the expected date format in the tool schema.",
    confidence: "high",
    ...overrides,
  };
}

function insights(
  overrides: Partial<SwarmWaveInsights> = {},
): SwarmWaveInsights {
  return {
    summary: "Tool reliability regressed against the previous swarm.",
    generatedAt: 1_000,
    modelUsed: "openai/gpt-5.4-mini",
    providerKey: "gateway",
    judgeCoverage: { graded: 4, total: 9 },
    sessionCount: 9,
    unanalyzedSessionCount: 0,
    truncated: false,
    lowConfidence: false,
    candidates: [candidate()],
    unnarratedCandidates: [],
    ...overrides,
  };
}

function finding(overrides: Partial<SwarmFinding> = {}): SwarmFinding {
  return {
    findingId: "f-1",
    fingerprint: "tool_errors:tool:search_flights",
    dimension: "tool_errors",
    subjectKind: "tool",
    subjectId: "search_flights",
    subjectLabel: "search_flights",
    status: "recurring",
    firstSeenAt: 1,
    lastSeenAt: 2,
    lastSeenGroupId: "wave-1",
    occurrenceCount: 3,
    resolvedAt: null,
    dismissedAt: null,
    updatedAt: 2,
    ...overrides,
  };
}

function renderBand(opts: { terminal?: boolean } = {}) {
  const onOpenSession = vi.fn();
  render(
    <SwarmWaveInsightsBand
      projectId="proj-1"
      swarmRunGroupId="wave-1"
      terminal={opts.terminal ?? true}
      onOpenSession={onOpenSession}
    />,
  );
  return onOpenSession;
}

beforeEach(() => {
  state.dto = undefined;
  state.findings = [];
  state.requestMock = vi.fn().mockResolvedValue(undefined);
  state.cancelMock = vi.fn().mockResolvedValue(undefined);
  state.dismissMock = vi.fn().mockResolvedValue(undefined);
  state.undismissMock = vi.fn().mockResolvedValue(undefined);
});

describe("auto-request", () => {
  it("fires once when a finished wave has no insights row yet", async () => {
    state.dto = null;
    renderBand();
    await waitFor(() => expect(state.requestMock).toHaveBeenCalledTimes(1));
    expect(state.requestMock.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1",
      swarmRunGroupId: "wave-1",
    });
  });

  it("does not fire while the swarm is still running", async () => {
    state.dto = null;
    renderBand({ terminal: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(state.requestMock).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("swarm-wave-insights-band"),
    ).not.toBeInTheDocument();
  });

  it("does not re-request when a row already exists", async () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    renderBand();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.requestMock).not.toHaveBeenCalled();
  });
});

describe("rendering", () => {
  it("shows the summary and claims, with detail behind the expand", () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    renderBand();
    expect(screen.getByTestId("swarm-wave-insights-summary")).toHaveTextContent(
      /regressed against the previous swarm/i,
    );
    expect(screen.getByTestId("swarm-wave-insight-claim")).toHaveTextContent(
      /date-shaped arguments/i,
    );
    expect(
      screen.queryByTestId("swarm-wave-insight-detail"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("swarm-wave-insight-claim"));
    const detail = screen.getByTestId("swarm-wave-insight-detail");
    expect(detail).toHaveTextContent(/Likely cause/);
    expect(detail).toHaveTextContent(/Document the expected date format/);
  });

  it("opens evidence and contrast sessions", () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    const onOpenSession = renderBand();
    fireEvent.click(screen.getByTestId("swarm-wave-insight-claim"));
    const links = screen.getAllByTestId("swarm-wave-insight-session-link");
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]!);
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
  });

  it("says so when the judge graded nothing", () => {
    state.dto = {
      status: "completed",
      insights: insights({ judgeCoverage: { graded: 0, total: 9 } }),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    renderBand();
    expect(screen.getByTestId("swarm-wave-insights-coverage")).toHaveTextContent(
      /not part of this analysis/i,
    );
  });

  it("reports signals it did not analyze rather than implying completeness", () => {
    state.dto = {
      status: "completed",
      insights: insights({
        unnarratedCandidates: [
          {
            fingerprint: "x:y:z",
            detector: "latency_outlier",
            subjectLabel: "Cursor",
            affectedSessions: 3,
            sliceTotal: 9,
          },
        ],
      }),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    renderBand();
    expect(
      screen.getByTestId("swarm-wave-insights-unnarrated"),
    ).toHaveTextContent(/1 more signal/i);
  });

  it("shows a pending state while generating", () => {
    state.dto = {
      status: "pending",
      insights: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    renderBand();
    expect(screen.getByTestId("swarm-wave-insights-pending")).toBeInTheDocument();
  });

  it("surfaces a spend-cap failure with a retry", () => {
    state.dto = {
      status: "failed",
      insights: null,
      errorCode: "spend_cap_exceeded",
      errorMessage: "Spending cap reached — insights were not generated.",
      updatedAt: 1,
    };
    renderBand();
    expect(screen.getByTestId("swarm-wave-insights-error")).toHaveTextContent(
      /spending cap/i,
    );
    fireEvent.click(screen.getByTestId("swarm-wave-insights-retry"));
    expect(state.requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });
});

describe("registry lifecycle + dismissal", () => {
  it("chips a recurring finding with its occurrence count", () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    state.findings = [finding()];
    renderBand();
    expect(screen.getByTestId("swarm-wave-insight-status")).toHaveTextContent(
      "Recurring ×3",
    );
  });

  it("marks a regressed finding distinctly", () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    state.findings = [finding({ status: "regressed" })];
    renderBand();
    expect(screen.getByTestId("swarm-wave-insight-status")).toHaveTextContent(
      /Regressed/,
    );
  });

  it("dismisses optimistically and reverts when the write fails", async () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    state.findings = [finding()];
    state.dismissMock = vi.fn().mockRejectedValue(new Error("nope"));
    renderBand();

    fireEvent.click(screen.getByTestId("swarm-wave-insight-dismiss"));
    expect(screen.getByTestId("swarm-wave-insight")).toHaveAttribute(
      "data-dismissed",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByTestId("swarm-wave-insight")).toHaveAttribute(
        "data-dismissed",
        "false",
      ),
    );
  });
});

describe("Lane B — discovery section", () => {
  const withDiscovery = (
    findings: SwarmWaveDiscoveryFinding[],
  ): SwarmWaveInsightsDto => ({
    status: "completed",
    insights: insights(),
    discovery: {
      generatedAt: 2_000,
      modelUsed: "anthropic/claude-sonnet-5",
      providerKey: "gateway",
      sampledSessionIds: ["s-1", "s-2", "s-3"],
      findings,
    },
    errorCode: null,
    errorMessage: null,
    updatedAt: 2,
  });

  const observation: SwarmWaveDiscoveryFinding = {
    kind: "observation",
    slug: "opaque_error_payload",
    title: "search_flights returns an opaque error string",
    detail: "Three sessions guessed the date format instead of being told.",
    sessionIds: ["s-1"],
    confidence: "medium",
  };

  it("renders findings under a visually separate heading", () => {
    state.dto = withDiscovery([observation]);
    renderBand();
    const section = screen.getByTestId("swarm-wave-discovery");
    expect(section).toHaveTextContent(/also noticed/i);
    // The sample size is stated — this evidence is weaker than Lane A's and
    // should not read as a measurement.
    expect(section).toHaveTextContent(/3 sampled sessions/i);
    expect(screen.getByTestId("swarm-wave-discovery-finding")).toHaveTextContent(
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
    renderBand();
    expect(screen.getByTestId("swarm-wave-discovery-check")).toHaveTextContent(
      "toolCalledAtLeastOnce(search_flights)",
    );
    expect(
      screen.getByTestId("swarm-wave-discovery-check-copy"),
    ).toBeInTheDocument();
  });

  it("opens the sessions a finding was drawn from", () => {
    state.dto = withDiscovery([observation]);
    const onOpenSession = renderBand();
    fireEvent.click(
      screen.getAllByTestId("swarm-wave-insight-session-link")[0]!,
    );
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
  });

  it("hides entirely against a backend without Lane B", () => {
    state.dto = {
      status: "completed",
      insights: insights(),
      errorCode: null,
      errorMessage: null,
      updatedAt: 1,
    };
    renderBand();
    expect(
      screen.queryByTestId("swarm-wave-discovery"),
    ).not.toBeInTheDocument();
  });

  it("hides when discovery ran but found nothing", () => {
    // An empty list is a real result — silence is valid, and rendering an
    // empty heading would imply the pass failed.
    state.dto = withDiscovery([]);
    renderBand();
    expect(
      screen.queryByTestId("swarm-wave-discovery"),
    ).not.toBeInTheDocument();
  });
});

describe("backend without the feature", () => {
  it("hides the band instead of breaking the tab", async () => {
    state.dto = null;
    state.requestMock = vi
      .fn()
      .mockRejectedValue(
        new Error("Could not find public function swarmWaveInsights:request"),
      );
    renderBand();
    await waitFor(() =>
      expect(
        screen.queryByTestId("swarm-wave-insights-band"),
      ).not.toBeInTheDocument(),
    );
  });

  it("SHOWS an entitlement rejection rather than hiding", async () => {
    // Convex prefixes "Server Error" onto thrown mutation errors, so a
    // billing rejection would be misread as unavailability without an
    // explicit branch — and the user would see nothing at all.
    state.dto = null;
    state.requestMock = vi
      .fn()
      .mockRejectedValue(
        new Error('Server Error: Limit "insightsPerDay" reached on the free plan.'),
      );
    renderBand();
    await waitFor(() =>
      expect(screen.getByTestId("swarm-wave-insights-error")).toHaveTextContent(
        /daily insights limit/i,
      ),
    );
  });
});
