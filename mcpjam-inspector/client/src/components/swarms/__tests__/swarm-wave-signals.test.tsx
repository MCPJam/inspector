import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SwarmWaveSignalCandidate,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import {
  SwarmWaveSignalsList,
  waveSignalSentence,
} from "../swarm-wave-signals";

/**
 * Wave Signals list — the deterministic lane's UI. The component's whole
 * contract is: phrase backend counts, never invent them, and degrade to
 * nothing (not to a broken section) whenever the data isn't there.
 */

const { queryState } = vi.hoisted(() => ({
  queryState: { value: undefined as SwarmWaveSignals | null | undefined },
}));

vi.mock("convex/react", () => ({
  useQuery: () => queryState.value,
}));

function candidate(
  overrides: Partial<SwarmWaveSignalCandidate> = {}
): SwarmWaveSignalCandidate {
  return {
    detector: "tool_errors",
    subjectKind: "tool",
    subjectId: "search_flights",
    subjectLabel: "search_flights",
    affectedSessions: 4,
    sliceTotal: 9,
    metric: 7,
    exemplarSessionIds: ["s-1", "s-2"],
    contrastSessionIds: ["s-9"],
    severityScore: 6,
    ...overrides,
  };
}

function signals(overrides: Partial<SwarmWaveSignals> = {}): SwarmWaveSignals {
  return {
    candidates: [candidate()],
    sessionCount: 9,
    unanalyzedSessionCount: 0,
    judgeCoverage: { graded: 0, total: 9 },
    truncated: false,
    lowConfidence: false,
    terminal: true,
    ...overrides,
  };
}

function renderList(onOpenSession = vi.fn()) {
  render(
    <SwarmWaveSignalsList
      projectId="proj-1"
      swarmRunGroupId="wave-1"
      onOpenSession={onOpenSession}
    />
  );
  return onOpenSession;
}

beforeEach(() => {
  queryState.value = undefined;
});

describe("SwarmWaveSignalsList", () => {
  it("renders nothing while loading and for an unknown wave", () => {
    queryState.value = undefined;
    renderList();
    expect(screen.queryByTestId("swarm-wave-signals")).not.toBeInTheDocument();

    queryState.value = null;
    renderList();
    expect(screen.queryByTestId("swarm-wave-signals")).not.toBeInTheDocument();
  });

  it("says signals are coming while the wave still runs", () => {
    queryState.value = signals({ terminal: false });
    renderList();
    expect(
      screen.getByTestId("swarm-wave-signals-pending")
    ).toHaveTextContent(/when the wave finishes/i);
    expect(screen.queryByTestId("swarm-wave-signal")).not.toBeInTheDocument();
  });

  it("shows the empty copy when the miner found nothing", () => {
    queryState.value = signals({ candidates: [] });
    renderList();
    expect(screen.getByTestId("swarm-wave-signals-empty")).toHaveTextContent(
      /no anomalies/i
    );
  });

  it("shows top candidates and expands to the full list", () => {
    queryState.value = signals({
      candidates: [
        candidate({ subjectId: "t1", subjectLabel: "t1" }),
        candidate({ subjectId: "t2", subjectLabel: "t2" }),
        candidate({ subjectId: "t3", subjectLabel: "t3" }),
        candidate({ subjectId: "t4", subjectLabel: "t4" }),
        candidate({ subjectId: "t5", subjectLabel: "t5" }),
      ],
    });
    renderList();
    expect(screen.getAllByTestId("swarm-wave-signal")).toHaveLength(3);

    fireEvent.click(screen.getByTestId("swarm-wave-signals-toggle"));
    expect(screen.getAllByTestId("swarm-wave-signal")).toHaveLength(5);
    expect(screen.getByTestId("swarm-wave-signals-toggle")).toHaveTextContent(
      /show fewer/i
    );
  });

  it("opens exemplar and contrast sessions through the callback", () => {
    queryState.value = signals();
    const onOpenSession = renderList();

    fireEvent.click(screen.getByTestId("swarm-wave-signal-row"));
    const links = screen.getAllByTestId("swarm-wave-signal-session-link");
    // 2 exemplars + 1 contrast, exemplars first.
    expect(links).toHaveLength(3);
    fireEvent.click(links[0]!);
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
    fireEvent.click(links[2]!);
    expect(onOpenSession).toHaveBeenCalledWith("s-9");
  });

  it("labels partial data instead of presenting it as complete", () => {
    queryState.value = signals({
      lowConfidence: true,
      truncated: true,
      unanalyzedSessionCount: 6,
    });
    renderList();
    expect(
      screen.getByTestId("swarm-wave-signals-low-confidence")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("swarm-wave-signals-truncated")
    ).toBeInTheDocument();
  });
});

describe("waveSignalSentence", () => {
  it("phrases the missing-capability signal around the invented name", () => {
    expect(
      waveSignalSentence(
        candidate({
          detector: "hallucinated_tool",
          subjectLabel: "cancel_booking",
          affectedSessions: 1,
        })
      )
    ).toBe('Agents invented a tool named "cancel_booking" in 1 session');
  });

  it("phrases relative detectors as a multiple of the rest of the wave", () => {
    expect(
      waveSignalSentence(
        candidate({
          detector: "token_outlier",
          subjectLabel: "Reconcile payouts",
          metric: 10_000,
          waveMetric: 2_000,
        })
      )
    ).toContain("5.0×");
  });

  it("never divides by a missing baseline", () => {
    expect(
      waveSignalSentence(
        candidate({
          detector: "latency_outlier",
          subjectLabel: "Cursor",
          metric: 30_000,
          waveMetric: undefined,
        })
      )
    ).toContain("well above");
  });
});
