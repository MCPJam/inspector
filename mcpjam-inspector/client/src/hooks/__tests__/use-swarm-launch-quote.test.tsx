import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The create flow's launch quote: one-shot reads keyed on the plan, the newest
 * answer wins, and anything that is not a quote reads as an error (which the
 * flow shows and does not block on).
 */

const queryMock = vi.fn();
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: queryMock }),
}));

import {
  readSwarmLaunchQuote,
  useSwarmLaunchQuote,
  type SwarmQuotePlannedRun,
} from "../use-swarm-launch-quote";

const QUOTE = {
  sessions: 4,
  starterSessions: 2,
  creditSessions: 2,
  creditsRequiredP50: 9.2,
  creditsRequiredP90: 14,
  admitThreshold: 16,
  creditsAvailable: 30,
  maxAffordableSessions: 4,
  fits: true,
  resetsAt: null,
  priors: "measured",
  perRun: [],
  lines: [],
};

const RUNS: SwarmQuotePlannedRun[] = [
  { key: "new:a:g1", environmentIds: ["env-1"], sessionsPerTarget: 2 },
];

beforeEach(() => {
  queryMock.mockReset();
});

describe("readSwarmLaunchQuote", () => {
  it("keeps the fields the flow reads", () => {
    expect(readSwarmLaunchQuote(QUOTE)).toEqual({
      sessions: 4,
      starterSessions: 2,
      creditSessions: 2,
      creditsRequiredP50: 9.2,
      creditsRequiredP90: 14,
      admitThreshold: 16,
      creditsAvailable: 30,
      maxAffordableSessions: 4,
      fits: true,
      resetsAt: null,
    });
  });

  it("is no quote when a field is missing or not a count", () => {
    expect(readSwarmLaunchQuote(undefined)).toBeNull();
    expect(readSwarmLaunchQuote({ ...QUOTE, fits: "yes" })).toBeNull();
    expect(readSwarmLaunchQuote({ ...QUOTE, sessions: -1 })).toBeNull();
    expect(
      readSwarmLaunchQuote({ effectiveModelId: "m", modelSource: "host" }),
    ).toBeNull();
  });
});

describe("useSwarmLaunchQuote", () => {
  it("fetches nothing without a plan or a project", () => {
    renderHook(() =>
      useSwarmLaunchQuote({ projectId: "proj-1", plannedRuns: null }),
    );
    renderHook(() =>
      useSwarmLaunchQuote({ projectId: null, plannedRuns: RUNS }),
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("quotes the plan and re-quotes only when it changes", async () => {
    queryMock.mockResolvedValue(QUOTE);
    const { result, rerender } = renderHook(
      ({ runs }) =>
        useSwarmLaunchQuote({ projectId: "proj-1", plannedRuns: runs }),
      { initialProps: { runs: RUNS } },
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(queryMock).toHaveBeenCalledWith("journeyRuns:quoteSwarmLaunch", {
      projectId: "proj-1",
      plannedRuns: RUNS,
    });
    // A new array with the same plan is the same plan.
    rerender({ runs: RUNS.map((run) => ({ ...run })) });
    expect(queryMock).toHaveBeenCalledTimes(1);
    rerender({ runs: [{ ...RUNS[0]!, sessionsPerTarget: 3 }] });
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
  });

  it("never paints an older plan's answer over a newer one", async () => {
    let answerFirst!: (value: unknown) => void;
    queryMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (answerFirst = resolve)),
      )
      .mockResolvedValueOnce({ ...QUOTE, fits: false });
    const { result, rerender } = renderHook(
      ({ runs }) =>
        useSwarmLaunchQuote({ projectId: "proj-1", plannedRuns: runs }),
      { initialProps: { runs: RUNS } },
    );
    rerender({ runs: [{ ...RUNS[0]!, sessionsPerTarget: 3 }] });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    answerFirst(QUOTE);
    await Promise.resolve();
    expect(result.current.state).toMatchObject({
      status: "ready",
      quote: { fits: false },
    });
  });

  it("reports a failed quote as an error, not as a quote", async () => {
    queryMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useSwarmLaunchQuote({ projectId: "proj-1", plannedRuns: RUNS }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("error"));
  });
});
