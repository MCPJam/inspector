import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConformanceScore } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";

const { mockSubmitScoreRun } = vi.hoisted(() => ({
  mockSubmitScoreRun: vi.fn(),
}));

vi.mock("@/lib/apis/score-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/score-api")>();
  return {
    ...actual,
    submitScoreRun: (...args: unknown[]) => mockSubmitScoreRun(...args),
  };
});

import { useScoreRunPersistence } from "../use-score-run-persistence";
import type { ScoreRunnerPhase } from "../score-runner-view-model";

type ConformanceRun = Parameters<typeof useScoreRunPersistence>[0]["run"];

const SERVER_URL = "https://mcp.acme.com/mcp";

const SCORE = {
  score: 84,
  outcome: "passed",
  applicable: 10,
  passed: 8,
  failed: 1,
  couldNotRun: 1,
  notApplicable: 0,
  advisories: [],
} as unknown as ConformanceScore;

function makeServer(name = "score-acme", url: string | null = SERVER_URL) {
  return {
    name,
    config: (url ? { url } : {}) as ServerWithName["config"],
    lastConnectionTime: new Date(0),
    connectionStatus: "disconnected",
    retryCount: 0,
  } satisfies ServerWithName;
}

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pooledScore: SCORE,
    protocolScore: SCORE,
    appsScore: undefined,
    tasksScore: undefined,
    oauthScore: undefined,
    protocol: { status: "done", result: { profile: {} } },
    apps: { status: "idle" },
    tasks: { status: "idle" },
    oauth: { status: "idle" },
    ...overrides,
  } as unknown as ConformanceRun;
}

interface HarnessProps {
  phase: ScoreRunnerPhase;
  server: ServerWithName | null;
  run: ConformanceRun;
}

function renderPersistence(props: HarnessProps) {
  const setPhase = vi.fn();
  const setError = vi.fn();
  const setResultToken = vi.fn();

  const view = renderHook(
    (current: HarnessProps) =>
      useScoreRunPersistence({
        phase: current.phase,
        setPhase,
        server: current.server,
        run: current.run,
        setError,
        setResultToken,
      }),
    { initialProps: props },
  );

  return { ...view, setPhase, setError, setResultToken };
}

/** Let the persist promise chain settle inside act(). */
const flush = () => act(async () => undefined);

beforeEach(() => {
  mockSubmitScoreRun.mockReset().mockResolvedValue({ token: "tok_1" });
});

describe("useScoreRunPersistence", () => {
  it("saves a completed run and exposes its token", async () => {
    const { setPhase, setResultToken, setError } = renderPersistence({
      phase: "run-complete",
      server: makeServer(),
      run: makeRun(),
    });
    await flush();

    expect(mockSubmitScoreRun).toHaveBeenCalledOnce();
    expect(mockSubmitScoreRun.mock.calls[0][0]).toMatchObject({
      serverUrl: SERVER_URL,
      summary: expect.objectContaining({ score: 84 }),
      suiteSummaries: [expect.objectContaining({ suiteId: "protocol" })],
    });
    expect(setPhase.mock.calls.map(([value]) => value)).toEqual([
      "saving",
      "done",
    ]);
    expect(setResultToken).toHaveBeenCalledWith("tok_1");
    expect(setError).not.toHaveBeenCalled();
  });

  it("reports a rejected save and still finishes the run", async () => {
    mockSubmitScoreRun.mockRejectedValue(new Error("Storage unavailable"));
    const { setPhase, setError, setResultToken } = renderPersistence({
      phase: "run-complete",
      server: makeServer(),
      run: makeRun(),
    });
    await flush();

    expect(setError).toHaveBeenCalledWith(
      "Scan finished, but the shareable link could not be saved: Storage unavailable",
    );
    expect(setResultToken).not.toHaveBeenCalled();
    expect(setPhase).toHaveBeenLastCalledWith("done");
  });

  it("finishes without saving when the server carries no URL", async () => {
    const { setPhase } = renderPersistence({
      phase: "run-complete",
      server: makeServer("score-acme", null),
      run: makeRun(),
    });
    await flush();

    expect(mockSubmitScoreRun).not.toHaveBeenCalled();
    expect(setPhase).toHaveBeenCalledExactlyOnceWith("done");
  });

  it("finishes without saving when no pooled score was produced", async () => {
    const { setPhase } = renderPersistence({
      phase: "run-complete",
      server: makeServer(),
      run: makeRun({ pooledScore: undefined }),
    });
    await flush();

    expect(mockSubmitScoreRun).not.toHaveBeenCalled();
    expect(setPhase).toHaveBeenCalledExactlyOnceWith("done");
  });

  it("ignores phases before the run completes", async () => {
    const { setPhase } = renderPersistence({
      phase: "running",
      server: makeServer(),
      run: makeRun(),
    });
    await flush();

    expect(mockSubmitScoreRun).not.toHaveBeenCalled();
    expect(setPhase).not.toHaveBeenCalled();
  });

  it("saves a given server once, and again only after a reset", async () => {
    const props: HarnessProps = {
      phase: "run-complete",
      server: makeServer(),
      run: makeRun(),
    };
    const { rerender, result } = renderPersistence(props);
    await flush();
    rerender({ ...props, server: makeServer() });
    await flush();

    expect(mockSubmitScoreRun).toHaveBeenCalledOnce();

    act(() => result.current());
    rerender({ ...props, server: makeServer() });
    await flush();

    expect(mockSubmitScoreRun).toHaveBeenCalledTimes(2);
  });

  it("resaves once when a deferred OAuth suite settles after the run", async () => {
    const props: HarnessProps = {
      phase: "run-complete",
      server: makeServer(),
      run: makeRun(),
    };
    const { rerender } = renderPersistence(props);
    await flush();
    expect(mockSubmitScoreRun).toHaveBeenCalledOnce();

    const settled = makeRun({
      oauthScore: SCORE,
      oauth: { status: "done", result: { profile: {} } },
    });
    rerender({ ...props, phase: "done", run: settled });
    await flush();

    expect(mockSubmitScoreRun).toHaveBeenCalledTimes(2);
    expect(mockSubmitScoreRun.mock.calls[1][0].suiteSummaries).toEqual([
      expect.objectContaining({ suiteId: "protocol" }),
      expect.objectContaining({ suiteId: "oauth" }),
    ]);

    rerender({ ...props, phase: "done", run: makeRun({ ...settled }) });
    await flush();

    expect(mockSubmitScoreRun).toHaveBeenCalledTimes(2);
  });

  it("does not resave while the OAuth suite is still unsettled", async () => {
    const props: HarnessProps = {
      phase: "done",
      server: makeServer(),
      run: makeRun({ oauth: { status: "running" }, oauthScore: undefined }),
    };
    renderPersistence(props);
    await flush();

    expect(mockSubmitScoreRun).not.toHaveBeenCalled();
  });
});
