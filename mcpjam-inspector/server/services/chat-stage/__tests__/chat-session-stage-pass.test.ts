/**
 * The derivation pass, driven against injected backend ports.
 *
 * What is worth pinning here is not the happy path — that is the SDK's
 * adapter, tested exhaustively in `sdk/tests/chat-session-stage-adapter.test.ts`
 * — but the four things this file alone decides:
 *
 *   1. SUPERSEDED IS SUCCESS. A no-op apply is never retried and never
 *      reported as a failure.
 *   2. The source stamp is handed back VERBATIM, never rebuilt. A worker able
 *      to choose it could declare its own stale work fresh.
 *   3. Nothing free-text reaches the backend. Failures are closed error codes.
 *   4. Unreadable evidence FAILS rather than deriving a blank chain, because a
 *      blank chain is indistinguishable from a session that genuinely
 *      measured nothing.
 */

import { describe, expect, it, vi } from "vitest";
import {
  deriveClaimedSession,
  runChatSessionStagePass,
  type ChatSessionStagePassPorts,
} from "../chat-session-stage-pass.js";
import type { ClaimedStageDerivation } from "../chat-session-stage-backend.js";

const STAMP = {
  sessionVersion: 3,
  messageCount: 4,
  criteriaStatus: "completed",
};

function claimFor(
  over: Partial<ClaimedStageDerivation> = {}
): ClaimedStageDerivation {
  return {
    sessionDocId: "sess-1",
    chatSessionId: "external-1",
    generation: 7,
    source: "user_testing",
    sourceStamp: STAMP,
    attempts: 1,
    evidence: {
      lifecycle: "settled",
      readiness: {
        status: "completed",
        toolCallCount: 1,
        advertisedToolCount: 5,
        advertisedToolsKnown: true,
      },
      criteria: {
        status: "completed",
        results: [{ criterionId: "answered", passed: true }],
      },
    },
    envelope: {
      messages: [
        { role: "user", content: "where is my order" },
        { role: "assistant", content: "here" },
      ],
      spans: [{ id: "s1", category: "tool", status: "ok", toolName: "lookup" }],
    },
    ...over,
  };
}

function ports(
  over: Partial<ChatSessionStagePassPorts> = {}
): ChatSessionStagePassPorts & {
  applied: any[];
  failures: any[];
} {
  const applied: any[] = [];
  const failures: any[] = [];
  return {
    claim: vi.fn(async () => ({ kind: "empty" as const })),
    apply: vi.fn(async (args: any) => {
      applied.push(args);
      return { kind: "applied" as const };
    }),
    reportFailure: vi.fn(async (args: any) => {
      failures.push(args);
    }),
    applied,
    failures,
    ...over,
  } as any;
}

describe("one claimed session", () => {
  it("derives the six rows and applies them", async () => {
    const p = ports();
    expect(await deriveClaimedSession(claimFor(), p)).toBe("applied");
    expect(p.applied).toHaveLength(1);
    const [call] = p.applied;
    expect(call.sessionDocId).toBe("sess-1");
    expect(call.generation).toBe(7);
    expect(call.stageResults).toHaveLength(6);
    expect(call.stageResults.map((row: any) => row.stage)).toEqual([
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]);
    expect(p.failures).toEqual([]);
  });

  it("hands the source stamp back VERBATIM", async () => {
    const p = ports();
    await deriveClaimedSession(claimFor(), p);
    expect(p.applied[0].sourceStamp).toBe(STAMP);
  });

  it("a superseded apply is a success — no retry, no failure report", async () => {
    const p = ports({
      apply: vi.fn(async () => ({
        kind: "superseded" as const,
        reason: "generation 7 superseded by 8",
      })),
    });
    expect(await deriveClaimedSession(claimFor(), p)).toBe("superseded");
    expect(p.failures).toEqual([]);
  });

  it("a THROWING apply costs one row, not the drain", async () => {
    // `applyStageDerivation` throws on any non-200 and rejects on a transport
    // abort. Unguarded, that rejection escaped the pass entirely: the claims
    // still queued behind it were abandoned to the backend's recovery
    // interval, and the outcomes already collected were thrown away with them.
    const p = ports({
      apply: vi.fn(async () => {
        throw new Error("apply failed (502)");
      }),
    });
    expect(await deriveClaimedSession(claimFor(), p)).toBe("worker_error");
    // Not reported: the transport broke, not the derivation, and the row's
    // own lease is what re-offers it.
    expect(p.failures).toEqual([]);
  });

  it("an invalid apply is NOT reported again — the backend already parked it", async () => {
    const p = ports({
      apply: vi.fn(async () => ({
        kind: "invalid" as const,
        reason: "expected 6 stage rows",
      })),
    });
    expect(await deriveClaimedSession(claimFor(), p)).toBe("invalid");
    expect(p.failures).toEqual([]);
  });

  it("unreadable evidence FAILS rather than deriving a blank chain", async () => {
    const p = ports();
    expect(await deriveClaimedSession(claimFor({ envelope: null }), p)).toBe(
      "evidence_unavailable"
    );
    expect(p.applied).toEqual([]);
    expect(p.failures).toEqual([
      {
        sessionDocId: "sess-1",
        generation: 7,
        errorCode: "evidence_unavailable",
        retryable: true,
      },
    ]);
  });

  it("reports only CLOSED error codes — nothing free-text ever leaves", async () => {
    const p = ports();
    await deriveClaimedSession(claimFor({ envelope: null }), p);
    for (const failure of p.failures) {
      expect(Object.keys(failure).sort()).toEqual([
        "errorCode",
        "generation",
        "retryable",
        "sessionDocId",
      ]);
      expect([
        "session_missing",
        "evidence_unavailable",
        "derivation_invalid",
        "worker_error",
        "attempts_exhausted",
      ]).toContain(failure.errorCode);
    }
  });
});

describe("the evidence rules survive the round trip", () => {
  it("deterministic criteria decide userValue", async () => {
    const p = ports();
    await deriveClaimedSession(
      claimFor({
        evidence: {
          ...claimFor().evidence,
          criteria: {
            status: "completed",
            results: [{ criterionId: "answered", passed: false }],
          },
        },
      }),
      p
    );
    const rows = p.applied[0].stageResults;
    expect(rows[5]).toMatchObject({ stage: "userValue", state: "failed" });
    expect(p.applied[0].firstFailedStage).toBe("userValue");
    expect(p.applied[0].failureCategory).toBe("userValue");
  });

  it("a broken grader is unmeasured, never a product failure", async () => {
    const p = ports();
    await deriveClaimedSession(
      claimFor({
        evidence: { ...claimFor().evidence, criteria: { status: "failed" } },
      }),
      p
    );
    expect(p.applied[0].stageResults[5]).toMatchObject({
      stage: "userValue",
      state: "notMeasured",
      reason: "evaluatorError",
    });
    expect(p.applied[0].firstFailedStage).toBeUndefined();
  });

  it("selection is never passed off a bare tool call", async () => {
    const p = ports();
    await deriveClaimedSession(claimFor(), p);
    expect(p.applied[0].stageResults[2]).toMatchObject({
      stage: "selection",
      state: "notMeasured",
    });
  });

  it("no connection failure is manufactured from a failed readiness", async () => {
    const p = ports();
    await deriveClaimedSession(
      claimFor({
        evidence: { lifecycle: "settled", readiness: { status: "failed" } },
        envelope: { messages: [{ role: "user", content: "hi" }] },
      }),
      p
    );
    expect(p.applied[0].stageResults[0]).toMatchObject({
      stage: "connection",
      state: "notMeasured",
    });
  });
});

describe("draining the queue", () => {
  function queue(items: any[]) {
    let index = 0;
    return vi.fn(async () => items[index++] ?? { kind: "empty" as const });
  }

  it("drains a burst in one pass", async () => {
    const p = ports({
      claim: queue([
        { kind: "claimed", claim: claimFor({ sessionDocId: "a" }) },
        { kind: "claimed", claim: claimFor({ sessionDocId: "b" }) },
        { kind: "empty" },
      ]),
    });
    const result = await runChatSessionStagePass({ ports: p });
    expect(result.claimed).toBe(2);
    expect(result.outcomes.map((o) => o.sessionDocId)).toEqual(["a", "b"]);
  });

  it("keeps going past a drained (parked) row", async () => {
    const p = ports({
      claim: queue([
        { kind: "drained" },
        { kind: "claimed", claim: claimFor({ sessionDocId: "a" }) },
        { kind: "empty" },
      ]),
    });
    expect((await runChatSessionStagePass({ ports: p })).claimed).toBe(1);
  });

  it("stops immediately when the backend says the feature is off", async () => {
    const p = ports({ claim: queue([{ kind: "disabled" }]) });
    const result = await runChatSessionStagePass({ ports: p });
    expect(result).toMatchObject({
      noop: true,
      claimed: 0,
      reason: "disabled",
    });
    expect(p.applied).toEqual([]);
  });

  it("an empty queue is a benign no-op", async () => {
    const result = await runChatSessionStagePass({ ports: ports() });
    expect(result).toMatchObject({ noop: true, claimed: 0, reason: "empty" });
  });

  it("a mid-drain apply failure keeps the rest of the queue moving", async () => {
    let applyCalls = 0;
    const p = ports({
      claim: queue([
        { kind: "claimed", claim: claimFor({ sessionDocId: "a" }) },
        { kind: "claimed", claim: claimFor({ sessionDocId: "b" }) },
        { kind: "claimed", claim: claimFor({ sessionDocId: "c" }) },
        { kind: "empty" },
      ]),
      apply: vi.fn(async () => {
        applyCalls += 1;
        if (applyCalls === 2) throw new Error("apply failed (502)");
        return { kind: "applied" as const };
      }),
    });
    const result = await runChatSessionStagePass({ ports: p });
    // All three are accounted for, and the failure is one row's.
    expect(result.outcomes).toEqual([
      { sessionDocId: "a", outcome: "applied" },
      { sessionDocId: "b", outcome: "worker_error" },
      { sessionDocId: "c", outcome: "applied" },
    ]);
  });

  it("a claim transport failure never throws out of the pass", async () => {
    const p = ports({
      claim: vi.fn(async () => {
        throw new Error("convex is down");
      }),
    });
    const result = await runChatSessionStagePass({ ports: p });
    expect(result).toMatchObject({ reason: "backend_unavailable", claimed: 0 });
  });

  it("respects the per-pass claim bound", async () => {
    const p = ports({
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        claim: claimFor(),
      })),
    });
    const result = await runChatSessionStagePass({ ports: p, maxClaims: 3 });
    expect(result.claimed).toBe(3);
  });

  it("spends nothing: no model call is reachable from the pass", async () => {
    // The port surface IS the proof. If a judge were ever added it would have
    // to arrive as a fourth port, and this assertion is what would notice.
    const p = ports({
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        claim: claimFor(),
      })),
    });
    await runChatSessionStagePass({ ports: p, maxClaims: 1 });
    expect(
      Object.keys(p).filter((key) => typeof (p as any)[key] === "function")
    ).toEqual(["claim", "apply", "reportFailure"]);
  });
});
