import { describe, expect, it } from "vitest";
import {
  beginCheckPlan,
  HttpCheckPlanSession,
  PlanProtocolError,
  PlanUnreachableError,
} from "../check-plan";

// The wire half of the loop. Three rules are the whole reason this file exists,
// and each of them is a way a check could otherwise go green (or go red on an
// innocent PR) when the backend said something else:
//
//   1. A 409 IS A HARD STOP. Never retried, never fallen back from.
//   2. UNREACHABLE IS UNREACHABLE. One replay where the idempotency key makes
//      it safe, then stop — never "assume continue".
//   3. AN UNKNOWN ACTION FAILS CLOSED to `complete`.

type Call = { path: string; body: any };

function recorder(
  script: Array<{ status: number; body: any } | (() => never)>
): { post: any; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const post = async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof step === "function") return step();
    return step;
  };
  return { post, calls };
}

const OK_ACTION = { status: 200, body: { ok: true, action: "continue_phase" } };

describe("beginCheckPlan", () => {
  it("mints a session from the returned planId", async () => {
    const r = recorder([{ status: 200, body: { ok: true, planId: "plan-9" } }]);
    const session = await beginCheckPlan(
      { triggerId: "t1", repoFullName: "acme/x", headSha: "abc" },
      r.post
    );
    expect(session.planId).toBe("plan-9");
    expect(r.calls[0].path).toBe("/internal/v1/github-checks/plan/begin");
    expect(r.calls[0].body).toEqual({
      triggerId: "t1",
      repoFullName: "acme/x",
      headSha: "abc",
    });
  });

  it("raises a PROTOCOL error on a 409 and does not retry", async () => {
    const r = recorder([
      { status: 409, body: { ok: false, error: "trigger_completed" } },
    ]);
    await expect(
      beginCheckPlan(
        { triggerId: "t1", repoFullName: "acme/x", headSha: "abc" },
        r.post
      )
    ).rejects.toBeInstanceOf(PlanProtocolError);
    expect(r.calls).toHaveLength(1);
  });

  it("raises an UNREACHABLE error on a 404 — the surface is off or undeployed", async () => {
    const r = recorder([{ status: 404, body: null }]);
    await expect(
      beginCheckPlan(
        { triggerId: "t1", repoFullName: "acme/x", headSha: "abc" },
        r.post
      )
    ).rejects.toBeInstanceOf(PlanUnreachableError);
  });

  it("replays ONCE on a transport failure, then gives up as unreachable", async () => {
    const r = recorder([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    await expect(
      beginCheckPlan(
        { triggerId: "t1", repoFullName: "acme/x", headSha: "abc" },
        r.post
      )
    ).rejects.toBeInstanceOf(PlanUnreachableError);
    expect(r.calls).toHaveLength(2);
  });
});

describe("HttpCheckPlanSession.attempt", () => {
  it("carries an explicit idempotency key, fresh per DISTINCT attempt", async () => {
    // No natural-key fallback: a natural key silently collapses two
    // legitimately distinct attempts, and the ambiguity only ever shows up as a
    // corrupted corpus row.
    const r = recorder([OK_ACTION]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await session.attempt({ phase: "provision", ok: true, durationMs: 5 });
    await session.attempt({ phase: "clone", ok: true, durationMs: 5 });
    const keys = r.calls.map((call) => call.body.idempotencyKey);
    expect(keys[0]).toBe("plan-1:ladder:provision:1");
    expect(keys[1]).toBe("plan-1:ladder:clone:2");
  });

  it("reuses the SAME key on a transport replay, so the backend replays its answer", async () => {
    const seen: Call[] = [];
    let calls = 0;
    const post = async (path: string, body: any) => {
      calls += 1;
      seen.push({ path, body });
      if (calls === 1) throw new Error("socket hang up");
      return OK_ACTION;
    };
    const session = new HttpCheckPlanSession("t1", "plan-1", post);
    const decision = await session.attempt({
      phase: "build",
      ok: false,
      failureKind: "build_failed",
      candidateId: "c1",
      durationMs: 10,
    });
    expect(decision.action).toBe("continue_phase");
    expect(seen).toHaveLength(2);
    expect(seen[0].body.idempotencyKey).toBe(seen[1].body.idempotencyKey);
  });

  it("never sends `evals_failed` — it is not in the union at all", async () => {
    // Compile-time in the type, restated here because it is the one failure
    // kind whose removal is a SECURITY property: a worker-asserted
    // `evals_failed` is a red verdict about somebody's PR with no run involved.
    const r = recorder([OK_ACTION]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await session.attempt({
      phase: "eval",
      ok: true,
      runId: "run-1",
      candidateId: "c1",
      durationMs: 0,
    });
    expect(r.calls[0].body.runId).toBe("run-1");
    expect(JSON.stringify(r.calls[0].body)).not.toContain("evals_failed");
  });

  it("recognizes run_conformance instead of failing closed", async () => {
    const r = recorder([
      { status: 200, body: { ok: true, action: "run_conformance" } },
    ]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    const decision = await session.attempt({
      phase: "eval",
      ok: true,
      runId: "run-1",
      candidateId: "c1",
      durationMs: 0,
    });
    expect(decision).toEqual({ action: "run_conformance" });
    expect(decision.unknownAction).toBeUndefined();
  });

  it("posts conformanceRunId on a successful conformance bind", async () => {
    const r = recorder([OK_ACTION]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await session.attempt({
      phase: "conformance",
      ok: true,
      conformanceRunId: "conf-1",
      candidateId: "c1",
      durationMs: 0,
    });
    expect(r.calls[0].body.conformanceRunId).toBe("conf-1");
  });

  it("fails CLOSED on an action it does not recognize", async () => {
    const r = recorder([
      { status: 200, body: { ok: true, action: "escalate_to_agent" } },
    ]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    const decision = await session.attempt({
      phase: "probe",
      ok: true,
      candidateId: "c1",
      durationMs: 1,
    });
    expect(decision).toEqual({
      action: "complete",
      reason: "unknown_action",
      unknownAction: true,
    });
  });

  it("fails CLOSED on a 200 with no action at all", async () => {
    const r = recorder([{ status: 200, body: { ok: true } }]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    const decision = await session.attempt({
      phase: "probe",
      ok: true,
      candidateId: "c1",
      durationMs: 1,
    });
    expect(decision.action).toBe("complete");
    expect(decision.unknownAction).toBe(true);
  });

  it("turns a 409 into a hard stop that names the reason, with no retry", async () => {
    const r = recorder([
      { status: 409, body: { ok: false, error: "candidate_out_of_order" } },
    ]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await expect(
      session.attempt({
        phase: "build",
        ok: true,
        candidateId: "c1",
        durationMs: 1,
      })
    ).rejects.toMatchObject({
      name: "PlanProtocolError",
      reason: "candidate_out_of_order",
    });
    expect(r.calls).toHaveLength(1);
  });

  it("carries WHERE it was when the backend went away, for the degraded marker", async () => {
    const r = recorder([{ status: 503, body: null }]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await expect(
      session.attempt({
        phase: "probe",
        ok: true,
        candidateId: "c2",
        durationMs: 1,
      })
    ).rejects.toMatchObject({
      name: "PlanUnreachableError",
      at: { phase: "probe", candidateId: "c2" },
    });
  });
});

describe("HttpCheckPlanSession.complete", () => {
  it("sends NO outcome — the backend derives it", async () => {
    const r = recorder([{ status: 200, body: { ok: true } }]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await session.complete({
      runId: "run-1",
      summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
    });
    expect(r.calls[0].path).toBe("/internal/v1/github-checks/complete");
    expect(r.calls[0].body).toEqual({
      triggerId: "t1",
      planId: "plan-1",
      runId: "run-1",
      summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
    });
    expect(r.calls[0].body).not.toHaveProperty("outcome");
  });

  it("retries WITHOUT the degraded marker when the marker itself is refused", async () => {
    // The marker rides inline, so the backend appends it as a real attempt — and
    // it can legitimately be refused when the call this run lost was in fact
    // committed. Losing one telemetry row beats leaving a claimed check with no
    // verdict until the heartbeat sweep times it out.
    let calls = 0;
    const bodies: any[] = [];
    const post = async (_path: string, body: any) => {
      calls += 1;
      bodies.push(body);
      return calls === 1
        ? { status: 409, body: { ok: false, error: "phase_out_of_order" } }
        : { status: 200, body: { ok: true } };
    };
    const session = new HttpCheckPlanSession("t1", "plan-1", post);
    await session.complete({
      terminalAttempt: {
        phase: "probe",
        ok: false,
        failureKind: "backend_unreachable",
        durationMs: 0,
        candidateId: "c1",
      },
    });
    expect(calls).toBe(2);
    expect(bodies[0].terminalAttempt).toMatchObject({
      failureKind: "backend_unreachable",
      candidateId: "c1",
    });
    expect(bodies[1]).not.toHaveProperty("terminalAttempt");
  });
});

describe("HttpCheckPlanSession.candidates", () => {
  it("returns the plan's candidates and stop policy", async () => {
    const r = recorder([
      {
        status: 200,
        body: {
          ok: true,
          candidates: [{ candidateId: "c1" }],
          stopPolicy: { maxCandidates: 3, wallClockMs: 1_200_000 },
        },
      },
    ]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    const issued = await session.candidates({
      evidenceDigest: "a".repeat(64),
      resolverVersion: "r2/1",
      localCandidates: [],
    });
    expect(issued.candidates).toHaveLength(1);
    expect(issued.stopPolicy).toEqual({
      maxCandidates: 3,
      wallClockMs: 1_200_000,
    });
    expect(r.calls[0].body.planId).toBe("plan-1");
  });

  it("hard-stops on a 409 (a re-plan the backend refuses)", async () => {
    const r = recorder([
      {
        status: 409,
        body: { ok: false, error: "plan_candidates_already_issued" },
      },
    ]);
    const session = new HttpCheckPlanSession("t1", "plan-1", r.post);
    await expect(
      session.candidates({
        evidenceDigest: "a".repeat(64),
        resolverVersion: "r2/1",
        localCandidates: [],
      })
    ).rejects.toBeInstanceOf(PlanProtocolError);
    expect(r.calls).toHaveLength(1);
  });
});
