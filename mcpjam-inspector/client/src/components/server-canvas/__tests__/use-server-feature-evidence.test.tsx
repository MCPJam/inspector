import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  checksFromRun,
  deriveServerFeatureEvidence,
  useServerFeatureEvidence,
  type ServerFeatureEvidenceResponse,
} from "../use-server-feature-evidence";
import { useServerCanvasRefresh } from "../server-canvas-refresh";
import { CAPTURED_AT, CTX_A, CTX_B, storedEvidence } from "./fixtures";

const mockSoftQuery = vi.hoisted(() => vi.fn());
const mockAuthFetch = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (name: string, args: unknown) => mockSoftQuery(name, args),
}));
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function response(
  overrides: Partial<ServerFeatureEvidenceResponse> = {},
  stored = storedEvidence(),
): ServerFeatureEvidenceResponse {
  return {
    inspection: stored.inspection,
    probeResults: stored.probeResults,
    observations: stored.observations,
    latestConformanceRun: null,
    ...overrides,
  };
}

const FAILED_RUN = {
  runId: "run_9",
  createdAt: CAPTURED_AT + 5_000,
  completedAt: CAPTURED_AT + 9_000,
  status: "completed",
  protocolVersion: "2025-11-25",
  suites: [
    {
      suiteKind: "protocol",
      cases: [
        { id: "server-initialize", status: "failed" },
        { id: "tools-list", status: "pending" },
      ],
    },
    { suiteKind: "not-a-suite", cases: [{ id: "x", status: "failed" }] },
  ],
};

describe("checksFromRun", () => {
  it("maps the run's digest to check evidence at the run's finish time", () => {
    expect(checksFromRun(FAILED_RUN)).toEqual([
      {
        ref: "protocol:server-initialize",
        status: "failed",
        runId: "run_9",
        runAt: CAPTURED_AT + 9_000,
        protocolVersion: "2025-11-25",
      },
    ]);
    expect(checksFromRun(null)).toEqual([]);
  });

  it("prefers a suite's own protocol version and falls back to the start time", () => {
    const [check] = checksFromRun({
      ...FAILED_RUN,
      completedAt: null,
      suites: [
        {
          suiteKind: "protocol",
          protocolVersion: "2026-07-28",
          cases: [{ id: "server-initialize", status: "passed" }],
        },
      ],
    });
    expect(check).toMatchObject({
      runAt: FAILED_RUN.createdAt,
      protocolVersion: "2026-07-28",
    });
  });
});

describe("deriveServerFeatureEvidence", () => {
  it("evaluates the latest capture's context by default", () => {
    const derived = deriveServerFeatureEvidence(response(), { connected: true });
    expect(derived.selected.contextHash).toBe(CTX_A);
    expect(derived.selected.capturedAt).toBe(CAPTURED_AT);
    expect(derived.evaluation.assessments["tools.list"].state).toBe("supported");
    expect(derived.evaluation.assessments["tools.list"].sources[0]).toBe(
      "observed",
    );
  });

  it("evaluates another context without mixing in the first one's evidence", () => {
    const data = response({}, storedEvidence({ secondContext: true }));
    const derived = deriveServerFeatureEvidence(data, {
      connected: true,
      contextHash: CTX_B,
    });
    expect(derived.selected.contextHash).toBe(CTX_B);
    expect(derived.selected.contexts.map((option) => option.contextHash)).toEqual(
      [CTX_A, CTX_B],
    );
    expect(derived.selected.capturedAt).toBeUndefined();
    expect(derived.evaluation.assessments["tools.list"].state).not.toBe(
      "supported",
    );
  });

  it("puts the latest run's failed checks on their features", () => {
    const derived = deriveServerFeatureEvidence(
      response({ latestConformanceRun: FAILED_RUN }),
      { connected: true },
    );
    const assessment =
      derived.evaluation.assessments["server-info.name-version"];
    expect(assessment.state).toBe("check-failed");
    expect(assessment.evidence.find((e) => e.source === "checked")?.ref).toMatchObject({
      runId: "run_9",
    });
    expect(derived.latestRun).toEqual({
      runId: "run_9",
      at: CAPTURED_AT + 9_000,
      status: "completed",
    });
  });

  it("asks a never-connected server to connect", () => {
    const derived = deriveServerFeatureEvidence(
      { inspection: null, probeResults: [], observations: [], latestConformanceRun: null },
      { connected: false },
    );
    expect(derived.evaluation.assessments["tools.capability"]).toMatchObject({
      state: "not-checked",
      nextAction: "connect",
    });
  });

  it("treats a live connection without saved evidence as connected", () => {
    const derived = deriveServerFeatureEvidence(null, { connected: true });
    expect(derived.evaluation.assessments["tools.capability"].nextAction).not.toBe(
      "connect",
    );
  });

  it("moves its stamp when a new capture or attempt is saved", () => {
    const before = deriveServerFeatureEvidence(response(), { connected: true });
    const attempt = deriveServerFeatureEvidence(
      response(
        {},
        storedEvidence({
          latestAttempt: { status: "failed", at: CAPTURED_AT + 1, error: "timeout" },
        }),
      ),
      { connected: true },
    );
    expect(attempt.stamp).not.toBe(before.stamp);
    expect(deriveServerFeatureEvidence(response(), { connected: true }).stamp).toBe(
      before.stamp,
    );
  });

  it("keeps its stamp when the page shows another context or connection", () => {
    const data = response({}, storedEvidence({ secondContext: true }));
    const stamps = [
      { connected: true },
      { connected: true, contextHash: CTX_A },
      { connected: true, contextHash: CTX_B },
      { connected: false, contextHash: CTX_B },
    ].map((options) => deriveServerFeatureEvidence(data, options).stamp);
    expect(new Set(stamps).size).toBe(1);
  });

  it("moves its stamp for a probe failure in a context the page does not show", () => {
    const withContextB = (failures: unknown[]) =>
      response({
        probeResults: [
          { contextHash: CTX_B, probes: [], failures, updatedAt: CAPTURED_AT },
        ],
      });
    const shownA = { connected: true, contextHash: CTX_A };
    const before = deriveServerFeatureEvidence(withContextB([]), shownA);
    const after = deriveServerFeatureEvidence(
      withContextB([
        { probeId: "server-card", status: "failed", at: CAPTURED_AT + 1 },
      ]),
      shownA,
    );
    expect(after.selected.contextHash).toBe(CTX_A);
    expect(after.stamp).not.toBe(before.stamp);
  });
});

describe("Refresh with the evidence stamp", () => {
  beforeEach(() => {
    mockSoftQuery.mockReset();
    mockAuthFetch.mockReset();
  });

  it("keeps Refreshing while the reader picks another context", async () => {
    mockSoftQuery.mockReturnValue({
      data: response({}, storedEvidence({ secondContext: true })),
      error: undefined,
    });
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: "accepted" }),
    });
    const hook = renderHook(
      ({ contextHash }: { contextHash?: string }) => {
        const evidence = useServerFeatureEvidence("proj_1", "srv_1", {
          connected: true,
          contextHash,
        });
        return useServerCanvasRefresh({
          projectId: "proj_1",
          serverId: "srv_1",
          evidenceStamp: evidence.stamp,
          latestAttempt: evidence.selected.latestAttempt,
        });
      },
      { initialProps: {} },
    );
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    // Let the accepted reply settle so the refresh is waiting on the stamp.
    await act(async () => {});
    hook.rerender({ contextHash: CTX_B });
    expect(hook.result.current.state).toEqual({ status: "running" });
  });
});

describe("useServerFeatureEvidence", () => {
  beforeEach(() => mockSoftQuery.mockReset());

  it("reads serverFeatureEvidence:getForServer for the project server", () => {
    mockSoftQuery.mockReturnValue({ data: response(), error: undefined });
    const { result } = renderHook(() =>
      useServerFeatureEvidence("proj_1", "srv_1", { connected: true }),
    );
    expect(mockSoftQuery).toHaveBeenCalledWith(
      "serverFeatureEvidence:getForServer",
      { projectId: "proj_1", serverId: "srv_1" },
    );
    expect(result.current.status).toBe("ready");
    expect(result.current.selected.contextHash).toBe(CTX_A);
  });

  it("skips the read without ids and reports loading", () => {
    mockSoftQuery.mockReturnValue({ data: undefined, error: undefined });
    const { result } = renderHook(() =>
      useServerFeatureEvidence(null, "srv_1", { connected: false }),
    );
    expect(mockSoftQuery).toHaveBeenCalledWith(
      "serverFeatureEvidence:getForServer",
      "skip",
    );
    expect(result.current.status).toBe("loading");
  });

  it("reports a failed read instead of throwing", () => {
    const error = new Error("not deployed");
    mockSoftQuery.mockReturnValue({ data: undefined, error });
    const { result } = renderHook(() =>
      useServerFeatureEvidence("proj_1", "srv_1", { connected: true }),
    );
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(error);
  });
});
