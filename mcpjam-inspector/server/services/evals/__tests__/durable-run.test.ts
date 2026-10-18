import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimDurableRun } from "../durable-run.js";
import { createSuiteRunRecorder } from "../recorder.js";

/**
 * The Inspector end of durable hosted runs: the job lease, the dispatch
 * boundary before each trial.
 */

const JOB = {
  jobId: "job-1",
  runId: "run-1",
  suiteId: "suite-1",
  gen: 1,
  attempt: 1,
  organizationId: "org-1",
  externalId: "user_1",
  idempotencyKey: "launch-1",
  inputs: "{}",
  heartbeatMs: 10,
};

type Call = { path: string; body: any; grant: string | null };

function stubBackend(
  answer: (path: string, call: Call) => { status: number; body: any },
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.split("/eval-run-jobs/")[1];
      const headers = init.headers as Record<string, string>;
      const call = {
        path,
        body: JSON.parse(String(init.body)),
        grant: headers["x-mcpjam-eval-run-grant"] ?? null,
      };
      calls.push(call);
      const { status, body } = answer(path, call);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("durable run handle", () => {
  it("tells a run with no job apart from a job held elsewhere", async () => {
    stubBackend(() => ({
      status: 200,
      body: { ok: true, claimed: false, noJob: true },
    }));
    expect(await claimDurableRun("run-1")).toBe("no_job");
    stubBackend(() => ({ status: 200, body: { ok: true, claimed: false } }));
    expect(await claimDurableRun("run-1")).toBeNull();
  });

  it("presents the grant, rotates it on heartbeat, and dispatches with it", async () => {
    vi.useFakeTimers();
    const calls = stubBackend((path) => {
      if (path === "claim") {
        return {
          status: 200,
          body: { ok: true, claimed: true, job: JOB, grant: "g1" },
        };
      }
      if (path === "heartbeat") {
        return { status: 200, body: { ok: true, leaseOk: true, grant: "g2" } };
      }
      return { status: 200, body: { ok: true } };
    });
    const handle = await claimDurableRun("run-1");
    if (!handle || handle === "no_job") throw new Error("expected a handle");
    handle.startHeartbeat(() => {
      throw new Error("lease must hold");
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(await handle.dispatch("iter-1")).toBe("ok");
    await handle.complete();

    expect(calls.map((c) => [c.path, c.grant])).toEqual([
      ["claim", null],
      ["heartbeat", "g1"],
      ["dispatch", "g2"],
      ["complete", "g2"],
    ]);
    expect(calls[2].body).toEqual({ iterationId: "iter-1" });
  });

  it("reports a lost lease once and never completes the job afterwards", async () => {
    vi.useFakeTimers();
    const calls = stubBackend((path) =>
      path === "claim"
        ? {
            status: 200,
            body: { ok: true, claimed: true, job: JOB, grant: "g" },
          }
        : { status: 409, body: { ok: false, error: "lease_lost" } },
    );
    const handle = await claimDurableRun("run-1");
    if (!handle || handle === "no_job") throw new Error("expected a handle");
    const onLost = vi.fn();
    handle.startHeartbeat(onLost);
    await vi.advanceTimersByTimeAsync(50);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(await handle.dispatch("iter-1")).toBe("lease_lost");
    await handle.complete();
    expect(calls.filter((c) => c.path === "complete")).toEqual([]);
  });

  it("hands back the backend's dispatch refusal", async () => {
    stubBackend((path) =>
      path === "claim"
        ? {
            status: 200,
            body: { ok: true, claimed: true, job: JOB, grant: "g" },
          }
        : { status: 200, body: { ok: false, reason: "not_a_member" } },
    );
    const handle = await claimDurableRun("run-1");
    if (!handle || handle === "no_job") throw new Error("expected a handle");
    expect(await handle.dispatch("iter-1")).toBe("not_a_member");
  });
});

describe("dispatch gate in the recorder", () => {
  const convexClient = () => {
    const mutation = vi.fn(async () => ({}));
    return {
      mutation,
      query: vi.fn(async () => ({
        iterations: [
          { _id: "iter-1", testCaseId: "case-1", iterationNumber: 1 },
        ],
      })),
    };
  };

  it("never marks a refused trial running, and surfaces the refusal", async () => {
    const client = convexClient();
    const recorder = createSuiteRunRecorder({
      convexClient: client as any,
      suiteId: "suite-1",
      runId: "run-1",
    });
    const refusal = new Error("refused");
    recorder.setDispatchGate?.(async () => {
      throw refusal;
    });
    await expect(
      recorder.startIteration({
        testCaseId: "case-1",
        iterationNumber: 1,
      } as any),
    ).rejects.toBe(refusal);
    expect(client.mutation).not.toHaveBeenCalledWith(
      "testSuites:startTestIteration",
      expect.anything(),
    );
  });

  it("starts the trial once the gate clears it", async () => {
    const client = convexClient();
    const recorder = createSuiteRunRecorder({
      convexClient: client as any,
      suiteId: "suite-1",
      runId: "run-1",
    });
    const gate = vi.fn(async () => {});
    recorder.setDispatchGate?.(gate);
    expect(
      await recorder.startIteration({
        testCaseId: "case-1",
        iterationNumber: 1,
      } as any),
    ).toBe("iter-1");
    expect(gate).toHaveBeenCalledWith("iter-1");
    expect(client.mutation).toHaveBeenCalledWith(
      "testSuites:startTestIteration",
      { iterationId: "iter-1" },
    );
  });
});
