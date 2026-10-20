/**
 * Production checks worker — how a claim response is read, the start gate,
 * and the evaluation of one claim. The poll loop itself is tested in
 * `workers/__tests__/claim-loop.test.ts`.
 *
 * The evaluation tests drive `executeClaimedCheck` against a mocked service
 * fetch and assert what lands on /complete and /fail — the wire is the
 * contract, and reason strings are the evidence the panel renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../shared/telemetry-catalog.generated.json";
import {
  claimNextForTests,
  executeClaimedCheck,
  startProductionChecksWorker,
  type ClaimedProductionCheck,
} from "../production-checks-worker";
import { logger } from "../../utils/logger";

const BASE_CLAIM: ClaimedProductionCheck = {
  triggerId: "trig-1",
  sessionDocId: "session-1",
  checkDocId: "check-1",
  generation: 1,
  criteria: [
    {
      id: "crit-quick",
      predicate: { type: "turnCountUnder" as const, turns: 3 },
    },
    {
      id: "crit-tokens",
      predicate: { type: "tokenBudgetUnder" as const, tokens: 500 },
    },
  ],
  usage: { inputTokens: 120, outputTokens: 80 },
  envelope: {
    messages: [
      { role: "user", content: "help" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  },
};

function mockServiceFetch() {
  const calls: Array<{ path: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      calls.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body),
      });
      return {
        status: 200,
        json: async () => ({ ok: true, applied: true }),
      } as Response;
    }),
  );
  return calls;
}

describe("executeClaimedCheck", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("grades the claim and reports id-keyed verdicts to /complete", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck(BASE_CLAIM);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/production-checks/complete");
    const body = calls[0].body;
    expect(body.checkDocId).toBe("check-1");
    expect(body.generation).toBe(1);
    // 1 user turn < 3 passes; 200 tokens < 500 passes — usage was measured,
    // not failed closed, because the claim carried the session totals.
    expect(body.criterionResults).toEqual([
      expect.objectContaining({ criterionId: "crit-quick", passed: true }),
      expect.objectContaining({ criterionId: "crit-tokens", passed: true }),
    ]);
  });

  it("fails tokenBudgetUnder closed when the claim carries no usage", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({ ...BASE_CLAIM, usage: null });

    const body = calls[0].body;
    expect(body.criterionResults[1]).toMatchObject({
      criterionId: "crit-tokens",
      passed: false,
    });
    expect(body.criterionResults[1].reason).toContain("unavailable");
  });

  it("reports an unreadable envelope to /fail, never /complete", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({ ...BASE_CLAIM, envelope: null });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/production-checks/fail");
    expect(calls[0].body.error).toBe("transcript envelope unreadable");
  });

  it("an only-advisory failure stays green (complete, passed: true)", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({
      ...BASE_CLAIM,
      criteria: [
        {
          id: "crit-advisory",
          predicate: {
            type: "responseContains" as const,
            needle: "this text is absent",
            role: "advisory",
            severity: "warn",
          },
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/production-checks/complete");
    expect(calls[0].body.passed).toBe(true);
    // The advisory row still travels, and still says it did not pass — what
    // it must NOT carry is the check policy. `criterionResultValidator` on the
    // backend is a closed `v.object`, so an extra key fails argument
    // validation, the completion 500s, the row stays `running`, and recovery
    // re-claims it into the same 500 forever. The advisory reduction is
    // carried by `passed` above, which is the field the verdict reads.
    expect(calls[0].body.criterionResults[0]).toMatchObject({
      criterionId: "crit-advisory",
      passed: false,
    });
    expect(Object.keys(calls[0].body.criterionResults[0]).sort()).toEqual([
      "criterionId",
      "passed",
      "reason",
    ]);
  });

  it("grades an EMPTY transcript rather than skipping it", async () => {
    const calls = mockServiceFetch();
    await executeClaimedCheck({
      ...BASE_CLAIM,
      envelope: { messages: [] },
    });

    expect(calls[0].path).toBe("/internal/v1/production-checks/complete");
    // Zero user turns is a real reading — `< 3` passes.
    expect(calls[0].body.criterionResults[0]).toMatchObject({
      criterionId: "crit-quick",
      passed: true,
    });
  });
});

function stubClaimResponse(status: number, body: unknown) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("production-checks claim", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the worker's claimedBy and returns the claimed grade", async () => {
    const fetchMock = stubClaimResponse(200, {
      ok: true,
      claimed: true,
      ...BASE_CLAIM,
    });

    await expect(claimNextForTests("inspector-7")).resolves.toEqual(BASE_CLAIM);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://convex.test/internal/v1/production-checks/claim");
    expect(JSON.parse(init.body)).toEqual({ claimedBy: "inspector-7" });
  });

  it("reads an empty queue as nothing to do", async () => {
    stubClaimResponse(200, { ok: true, claimed: false });
    await expect(claimNextForTests("inspector-7")).resolves.toBeNull();
  });

  it("reads a consumed stale trigger as drained, so the loop re-polls soon", async () => {
    stubClaimResponse(200, { ok: true, claimed: false, retry: true });
    await expect(claimNextForTests("inspector-7")).resolves.toBe("drained");
  });

  it("reads a 404 as the feature being off backend-side", async () => {
    stubClaimResponse(404, { ok: false });
    await expect(claimNextForTests("inspector-7")).resolves.toBe("disabled");
  });

  it("throws on a failed or malformed claim so the loop backs off", async () => {
    stubClaimResponse(500, { ok: false });
    await expect(claimNextForTests("inspector-7")).rejects.toThrow(
      /claim failed \(500\)/,
    );
    stubClaimResponse(200, { ok: true, claimed: true, triggerId: "trig-1" });
    await expect(claimNextForTests("inspector-7")).rejects.toThrow(
      "claim returned a malformed payload",
    );
  });
});

describe("startProductionChecksWorker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays inert without the service-token env — the only gate there is", async () => {
    // No flag guards this worker, so a deployment that is not an
    // infrastructure peer must self-gate here or every local dev inspector
    // would start polling.
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    await startProductionChecksWorker().stop();

    // `fetch` alone cannot prove the gate: without credentials the transport
    // throws before `fetch` anyway. The loop logs "worker started"
    // synchronously, so its absence is what shows the gate held.
    expect(infoSpy).not.toHaveBeenCalledWith(
      "[production-checks] worker started",
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs its lines as literals the telemetry catalog keeps", () => {
    expect(catalog.messages).toEqual(
      expect.arrayContaining([
        "[production-checks] worker started",
        "[production-checks] poll failed",
        "[production-checks] worker stopped",
      ]),
    );
  });
});
