/**
 * The hosted claim loop for MCPJam's steps: claim, the lease (heartbeat,
 * spend, release), a lost lease that stops the step, the drain, and an
 * inert loop where there is no service credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ tracked: [] as string[] }));
vi.mock("../lifecycle/drain.js", () => ({
  serverDrain: {
    track: (kind: string, work: Promise<unknown>) => {
      hoisted.tracked.push(kind);
      return work;
    },
  },
}));

import { executeClaimedStep, startClimbWorker, type ClaimedClimbStep } from "../climb-worker";
import type { StepLease, StepResult } from "../climbs/picker-step";

const CLAIM: ClaimedClimbStep = {
  climbId: "climb1",
  generation: 4,
  projectId: "proj1",
  pickerModel: "anthropic/claude-haiku-4.5",
  heartbeatIntervalMs: 20_000,
  resumeRound: null,
  organizationId: "org1",
  actAs: { userId: "u1", externalId: "user_ext_1", email: "a@b.test" },
};

type Call = { path: string; body: Record<string, any> };
function service(answers: Record<string, { status?: number; body?: Record<string, unknown> }> = {}) {
  const calls: Call[] = [];
  const post = vi.fn(async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    const answer = answers[path] ?? { body: { ok: true } };
    return { status: answer.status ?? 200, body: answer.body ?? { ok: true } };
  });
  return { post, calls };
}

beforeEach(() => {
  hoisted.tracked.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a claimed step", () => {
  it("acts as the person who started the climb, and releases the round it submitted", async () => {
    const { post, calls } = service();
    const getBearer = vi.fn(async () => "delegated");
    const run = vi.fn(async (_claim, _lease, bearer: () => Promise<string>): Promise<StepResult> => {
      expect(await bearer()).toBe("delegated");
      return { kind: "done", submittedRound: 3 };
    });
    await executeClaimedStep(CLAIM, { post, run, getBearer });
    expect(getBearer).toHaveBeenCalledWith("user_ext_1", "org1");
    expect(calls).toEqual([{ path: "release", body: { climbId: "climb1", generation: 4, submittedRound: 3 } }]);
  });

  it("releases a turn that submitted nothing with no round, which the backend retries once", async () => {
    const { post, calls } = service();
    await executeClaimedStep(CLAIM, { post, run: async () => ({ kind: "done" }) });
    expect(calls).toEqual([{ path: "release", body: { climbId: "climb1", generation: 4 } }]);
  });

  it("renews the lease by heartbeat, and answers a lost one as an answer, not an error", async () => {
    const { post, calls } = service({ heartbeat: { status: 409, body: { ok: false, error: "lease_lost" } } });
    let lease!: StepLease;
    await executeClaimedStep(CLAIM, { post, run: async (_c, l) => ((lease = l), { kind: "lost" }), getBearer: async () => "t" });
    expect(await lease.renew()).toEqual({ leaseOk: false, stop: false });
    expect(calls).toEqual([{ path: "heartbeat", body: { climbId: "climb1", generation: 4 } }]);
  });

  it("reads the heartbeat's stop as the climb having been stopped", async () => {
    const { post } = service({ heartbeat: { body: { ok: true, leaseOk: true, stop: true } } });
    let lease!: StepLease;
    await executeClaimedStep(CLAIM, { post, run: async (_c, l) => ((lease = l), { kind: "stopped" }), getBearer: async () => "t" });
    expect(await lease.renew()).toEqual({ leaseOk: true, stop: true });
  });

  it("reports the turn's spend under the generation it holds", async () => {
    const { post, calls } = service();
    let lease!: StepLease;
    await executeClaimedStep(CLAIM, { post, run: async (_c, l) => ((lease = l), { kind: "lost" }), getBearer: async () => "t" });
    await lease.spend({ estimatedCostUsd: 0.04, tokens: 1500 });
    expect(calls).toEqual([{ path: "spend", body: { climbId: "climb1", generation: 4, estimatedCostUsd: 0.04, tokens: 1500 } }]);
  });

  it("refuses a spend the backend refused, so the step says it was not reported", async () => {
    const { post } = service({ spend: { status: 409, body: { ok: false, error: "lease_lost" } } });
    let lease!: StepLease;
    await executeClaimedStep(CLAIM, { post, run: async (_c, l) => ((lease = l), { kind: "lost" }), getBearer: async () => "t" });
    await expect(lease.spend({ estimatedCostUsd: 0, tokens: 1 })).rejects.toThrow(/spend was refused \(409\): lease_lost/);
  });

  it.each([["lost"], ["stopped"]] as const)("writes nothing when the step ended %s", async (kind) => {
    const { post, calls } = service();
    await executeClaimedStep(CLAIM, { post, run: async () => ({ kind }) });
    expect(calls).toEqual([]);
  });

  it("leaves a step that threw to the backend's sweep, and never throws itself", async () => {
    const { post, calls } = service();
    await expect(executeClaimedStep(CLAIM, { post, run: async () => Promise.reject(new Error("model down")) })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does not throw when the release is refused: the lease lapses by itself", async () => {
    const { post } = service({ release: { status: 409, body: { ok: false, error: "lease_lost" } } });
    await expect(executeClaimedStep(CLAIM, { post, run: async () => ({ kind: "done", submittedRound: 1 }) })).resolves.toBeUndefined();
  });

  it("does not run a step it cannot act for, when the claim names no organization", async () => {
    const { post, calls } = service();
    const run = vi.fn();
    await executeClaimedStep({ ...CLAIM, organizationId: undefined }, { post, run });
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("the claim loop", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("is inert with no service credential: it claims nothing and stops at once", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handle = startClimbWorker();
    await wait(20);
    await handle.stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("claims over the service route with the credential, and runs the step under the drain", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
    const seen: Array<{ url: string; token: string | null; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, token: new Headers(init.headers).get("x-inspector-service-token"), body: JSON.parse(String(init.body)) });
        return Response.json({ ok: true, claimed: false, retryAfterMs: 60_000 });
      }),
    );
    const handle = startClimbWorker({ claimedBy: "replica-1" });
    await wait(20);
    await handle.stop();
    expect(seen[0]).toEqual({ url: "https://convex.test/internal/v1/climbs/steps/claim", token: "service-token-for-tests", body: { claimedBy: "replica-1" } });
  });

  it("registers a claimed step with the drain as a claimed job, and claims again when it ends", async () => {
    const claims = [{ kind: "claimed" as const, claim: CLAIM }, { kind: "empty" as const, retryAfterMs: 60_000 }];
    const claim = vi.fn(async () => claims.shift()!);
    const execute = vi.fn(async () => {});
    const handle = startClimbWorker({ post: service().post, claim, execute, pollJitterMs: 1 });
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    await handle.stop();
    expect(execute).toHaveBeenCalledWith(CLAIM);
    expect(hoisted.tracked).toEqual(["claimed_job"]);
  });

  it("backs off when the backend has the routes off, and when a claim fails, without ending", async () => {
    const claim = vi.fn().mockResolvedValueOnce({ kind: "disabled" }).mockRejectedValue(new Error("down"));
    const handle = startClimbWorker({ post: service().post, claim, execute: vi.fn(), pollJitterMs: 1 });
    await wait(30);
    await handle.stop();
    // One poll answered "disabled" and then waited a minute: the loop did not hammer.
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("reads a claim's answer into the step, resume marker included, and a 404 as the routes being off", async () => {
    const answers = [
      { status: 200, body: { ok: true, claimed: true, climbId: "climb1", generation: 5, attempt: 1, maxAttempts: 3, heartbeatIntervalMs: 20000, projectId: "proj1", organizationId: "org1", pickerModel: "m/x", actAs: { userId: "u", externalId: "ext" }, resumeRound: { roundNumber: 2, unitKey: "round:2", idempotencyKey: "k", serverId: "s_mock" } } },
      { status: 404, body: null },
    ];
    const post = vi.fn(async () => answers.shift() ?? { status: 404, body: null });
    const execute = vi.fn(async () => {});
    const handle = startClimbWorker({ post, execute, pollJitterMs: 1 });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await handle.stop();
    expect(execute.mock.calls[0]![0]).toMatchObject({
      climbId: "climb1",
      generation: 5,
      pickerModel: "m/x",
      organizationId: "org1",
      actAs: { externalId: "ext" },
      resumeRound: { roundNumber: 2, idempotencyKey: "k", serverId: "s_mock" },
    });
  });

  it("stops polling at once on stop, even while it waits", async () => {
    const claim = vi.fn(async () => ({ kind: "empty" as const, retryAfterMs: 3_600_000 }));
    const handle = startClimbWorker({ post: service().post, claim, execute: vi.fn(), pollJitterMs: 1 });
    await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    const started = Date.now();
    await handle.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
