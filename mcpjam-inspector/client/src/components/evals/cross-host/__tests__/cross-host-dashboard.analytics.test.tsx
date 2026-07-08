import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../../types";
import { CrossHostDashboard } from "../cross-host-dashboard";

const captureMock = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

vi.mock("@/lib/PosthogUtils", () => ({
  standardEventProps: (location: string) => ({ location }),
}));

function makeSuite(
  attachments: Array<{ namedHostId: string; hostName: string | null }> = [],
): EvalSuite {
  return {
    _id: "s1",
    createdBy: "u1",
    name: "Suite",
    description: "",
    configRevision: "r1",
    environment: { servers: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostAttachments: attachments.map((a) => ({
      namedHostId: a.namedHostId,
      hostName: a.hostName,
      enabledOptionalServerIds: [],
      resolvedServerNames: [],
    })),
  };
}

function makeCase(id: string): EvalCase {
  return {
    _id: id,
    testSuiteId: "s1",
    createdBy: "u1",
    title: id,
    query: "q",
    models: [{ model: "m", provider: "p" }],
    runs: 1,
    expectedToolCalls: [],
  };
}

function makeRun(id: string, namedHostId?: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "s1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "r1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: Date.now(),
    ...(namedHostId ? { namedHostId } : {}),
  } as EvalSuiteRun;
}

function makeIteration(
  id: string,
  suiteRunId: string,
  testCaseId: string,
): EvalIteration {
  const now = Date.now();
  return {
    _id: id,
    suiteRunId,
    testCaseId,
    createdBy: "u1",
    createdAt: now,
    updatedAt: now + 5000,
    startedAt: now,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 0,
  } as EvalIteration;
}

function makeRunWithTime(
  id: string,
  namedHostId: string,
  createdAt: number,
): EvalSuiteRun {
  return {
    ...makeRun(id, namedHostId),
    createdAt,
    completedAt: createdAt + 1000,
  } as EvalSuiteRun;
}

describe("CrossHostDashboard analytics", () => {
  beforeEach(() => {
    captureMock.mockClear();
  });

  it("fires evals_cross_host_viewed once on mount", () => {
    const suite = makeSuite([
      { namedHostId: "h1", hostName: "Claude" },
      { namedHostId: "h2", hostName: "Cursor" },
    ]);
    render(
      <CrossHostDashboard
        suite={suite}
        cases={[]}
        runs={[]}
        allIterations={[]}
      />,
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
    const [eventName, payload] = captureMock.mock.calls[0];
    expect(eventName).toBe("evals_cross_host_viewed");
    expect(payload).toMatchObject({
      location: "cross_host_dashboard",
      suite_id: "s1",
      host_count: 2,
      case_count: 0,
      has_historical_host: false,
      has_data: false,
      has_host_attachments: true,
    });
  });

  it("does not re-fire on re-render with the same suite", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const { rerender } = render(
      <CrossHostDashboard
        suite={suite}
        cases={[]}
        runs={[]}
        allIterations={[]}
      />,
    );
    rerender(
      <CrossHostDashboard
        suite={suite}
        cases={[makeCase("c1")]}
        runs={[]}
        allIterations={[]}
      />,
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires when navigating to a different suite", () => {
    const suiteA = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const suiteB: EvalSuite = { ...suiteA, _id: "s2", name: "Suite B" };
    const { rerender } = render(
      <CrossHostDashboard
        suite={suiteA}
        cases={[]}
        runs={[]}
        allIterations={[]}
      />,
    );
    rerender(
      <CrossHostDashboard
        suite={suiteB}
        cases={[]}
        runs={[]}
        allIterations={[]}
      />,
    );
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(captureMock.mock.calls[0][1].suite_id).toBe("s1");
    expect(captureMock.mock.calls[1][1].suite_id).toBe("s2");
  });

  it("flags has_data=true and counts cases when iterations exist", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1"), makeCase("c2")];
    const run = makeRun("r1", "h1");
    const iter = makeIteration("i1", "r1", "c1");
    render(
      <CrossHostDashboard
        suite={suite}
        cases={cases}
        runs={[run]}
        allIterations={[iter]}
      />,
    );
    const payload = captureMock.mock.calls[0][1];
    expect(payload.has_data).toBe(true);
    expect(payload.case_count).toBe(2);
    expect(payload.host_count).toBe(1);
  });

  it("flags has_historical_host=true when runs reference a detached host", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const legacyRun = makeRun("r2", "h_old");
    const iter = makeIteration("i1", "r2", "c1");
    render(
      <CrossHostDashboard
        suite={suite}
        cases={cases}
        runs={[legacyRun]}
        allIterations={[iter]}
      />,
    );
    const payload = captureMock.mock.calls[0][1];
    expect(payload.has_historical_host).toBe(true);
    expect(payload.host_count).toBe(2);
  });

  it("flags has_host_attachments=false on empty-attachment suites", () => {
    const suite = makeSuite([]);
    render(
      <CrossHostDashboard
        suite={suite}
        cases={[]}
        runs={[]}
        allIterations={[]}
      />,
    );
    const payload = captureMock.mock.calls[0][1];
    expect(payload.has_host_attachments).toBe(false);
    expect(payload.host_count).toBe(0);
  });

  it("renders cell trend UI when cellTrends is enabled and history exists", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const run1 = makeRunWithTime("r1", "h1", 1000);
    const run2 = makeRunWithTime("r2", "h1", 2000);
    const iter1 = makeIteration("i1", "r1", "c1");
    const iter2 = makeIteration("i2", "r2", "c1");
    const { container } = render(
      <CrossHostDashboard
        suite={suite}
        cases={cases}
        runs={[run1, run2]}
        allIterations={[iter1, iter2]}
        cellTrends
        expanded
      />,
    );
    expect(container.querySelector('[data-testid="cell-metric-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="metric-sparkline-latency"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="metric-sparkline-tokens"]')).not.toBeNull();
  });

  it("does not render cell trend UI when cellTrends is disabled", () => {
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    const cases = [makeCase("c1")];
    const run1 = makeRunWithTime("r1", "h1", 1000);
    const run2 = makeRunWithTime("r2", "h1", 2000);
    const iter1 = makeIteration("i1", "r1", "c1");
    const iter2 = makeIteration("i2", "r2", "c1");
    const { container } = render(
      <CrossHostDashboard
        suite={suite}
        cases={cases}
        runs={[run1, run2]}
        allIterations={[iter1, iter2]}
        expanded
      />,
    );
    expect(container.querySelector('[data-testid="cell-metric-strip"]')).toBeNull();
  });

  it("does not throw when posthog.capture throws", () => {
    captureMock.mockImplementationOnce(() => {
      throw new Error("posthog offline");
    });
    const suite = makeSuite([{ namedHostId: "h1", hostName: "Claude" }]);
    expect(() =>
      render(
        <CrossHostDashboard
          suite={suite}
          cases={[]}
          runs={[]}
          allIterations={[]}
        />,
      ),
    ).not.toThrow();
  });
});
