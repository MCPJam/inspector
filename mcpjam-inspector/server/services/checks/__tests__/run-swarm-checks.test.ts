import { describe, expect, it, vi, beforeEach } from "vitest";

const claimSwarmChecksMock = vi.hoisted(() => vi.fn());
const completeSwarmChecksMock = vi.hoisted(() => vi.fn());
const failSwarmChecksMock = vi.hoisted(() => vi.fn());

vi.mock("../../swarm-agent.js", () => ({
  claimSwarmChecks: claimSwarmChecksMock,
  completeSwarmChecks: completeSwarmChecksMock,
  failSwarmChecks: failSwarmChecksMock,
}));

import { runSwarmChecks } from "../run-swarm-checks";
import type { Predicate } from "@/shared/eval-matching";

type Criterion = { id: string; label?: string; predicate: Predicate };

const ARGS = {
  convexHttpUrl: "https://backend.test",
  bearer: "tok",
  projectId: "proj_1",
  runId: "run_1",
  chatSessionId: "sess-ext-1",
};

const CRITERIA: Criterion[] = [
  {
    id: "crit-search",
    label: "Searched",
    predicate: { type: "toolCalledAtLeastOnce" as const, toolName: "search" },
  },
  {
    id: "crit-quick",
    predicate: { type: "turnCountUnder" as const, turns: 3 },
  },
];

function claimResult(
  messages: Array<Record<string, unknown>> | null,
  criteria: Criterion[] = CRITERIA,
) {
  return {
    claimed: true as const,
    generation: 1,
    checkDocId: "check_1",
    sessionDocId: "session_1",
    criteria,
    envelope: messages === null ? null : { messages },
  };
}

describe("runSwarmChecks", () => {
  beforeEach(() => {
    claimSwarmChecksMock.mockReset();
    completeSwarmChecksMock.mockReset().mockResolvedValue(undefined);
    failSwarmChecksMock.mockReset().mockResolvedValue(undefined);
  });

  it("evaluates the pinned criteria and correlates verdicts back by criterionId", async () => {
    claimSwarmChecksMock.mockResolvedValue(
      claimResult([
        { role: "user", content: "help" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolName: "search", input: { q: "refund" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]),
    );

    const outcome = await runSwarmChecks(ARGS);

    expect(outcome.status).toBe("completed");
    const [, , payload] = completeSwarmChecksMock.mock.calls[0];
    expect(payload.criterionResults).toEqual([
      expect.objectContaining({ criterionId: "crit-search", passed: true }),
      // One user turn, budget 3 ⇒ passes strictly under.
      expect.objectContaining({ criterionId: "crit-quick", passed: true }),
    ]);
    // The generation from the claim is echoed back so a stale grade no-ops
    // server-side.
    expect(payload.generation).toBe(1);
    expect(payload.checkDocId).toBe("check_1");
  });

  it("fails a criterion whose predicate is not satisfied — a normal COMPLETED verdict", async () => {
    claimSwarmChecksMock.mockResolvedValue(
      claimResult([
        { role: "user", content: "one" },
        { role: "user", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
    );

    const outcome = await runSwarmChecks(ARGS);

    expect(outcome.status).toBe("completed");
    expect(failSwarmChecksMock).not.toHaveBeenCalled();
    const [, , payload] = completeSwarmChecksMock.mock.calls[0];
    // Never called `search`, and used exactly 3 turns against a strict `< 3`.
    expect(payload.criterionResults.map((r: any) => r.passed)).toEqual([
      false,
      false,
    ]);
    // Reasons carry the evidence; the compact session stamp will not.
    expect(payload.criterionResults[1].reason).toContain("3");
  });

  it("CLAIMS before it evaluates, so a crash mid-grade leaves a visible pending", async () => {
    const order: string[] = [];
    claimSwarmChecksMock.mockImplementation(async () => {
      order.push("claim");
      return claimResult([{ role: "user", content: "hi" }]);
    });
    completeSwarmChecksMock.mockImplementation(async () => {
      order.push("complete");
    });

    await runSwarmChecks(ARGS);

    expect(order).toEqual(["claim", "complete"]);
  });

  it("skips entirely when the run carries no rubric — nothing is stamped", async () => {
    claimSwarmChecksMock.mockResolvedValue(null);

    const outcome = await runSwarmChecks(ARGS);

    expect(outcome).toEqual({ status: "skipped", reason: "no_rubric" });
    expect(completeSwarmChecksMock).not.toHaveBeenCalled();
    expect(failSwarmChecksMock).not.toHaveBeenCalled();
  });

  it("reports a FAILED grade when the envelope has no readable messages", async () => {
    claimSwarmChecksMock.mockResolvedValue(claimResult(null));

    const outcome = await runSwarmChecks(ARGS);

    expect(outcome).toEqual({
      status: "failed",
      error: "transcript envelope unreadable",
    });
    expect(failSwarmChecksMock).toHaveBeenCalledTimes(1);
    expect(completeSwarmChecksMock).not.toHaveBeenCalled();
  });

  it("swallows a secondary failure while reporting the primary one", async () => {
    claimSwarmChecksMock.mockResolvedValue(claimResult(null));
    failSwarmChecksMock.mockRejectedValue(new Error("network down"));

    // The claim's `pending` stamp is the honest fallback; masking the real
    // cause with a transport error would help nobody.
    await expect(runSwarmChecks(ARGS)).resolves.toEqual({
      status: "failed",
      error: "transcript envelope unreadable",
    });
  });

  it("propagates a CLAIM failure — nothing was stamped, so there is no half-state", async () => {
    claimSwarmChecksMock.mockRejectedValue(new Error("403 forbidden"));

    await expect(runSwarmChecks(ARGS)).rejects.toThrow("403 forbidden");
    expect(completeSwarmChecksMock).not.toHaveBeenCalled();
    expect(failSwarmChecksMock).not.toHaveBeenCalled();
  });

  it("fails tokenBudgetUnder closed — swarm envelopes carry no token accounting", async () => {
    claimSwarmChecksMock.mockResolvedValue(
      claimResult([{ role: "user", content: "hi" }], [
        {
          id: "crit-tokens",
          predicate: { type: "tokenBudgetUnder" as const, tokens: 1_000_000 },
        },
      ]),
    );

    await runSwarmChecks(ARGS);

    const [, , payload] = completeSwarmChecksMock.mock.calls[0];
    expect(payload.criterionResults[0]).toMatchObject({
      criterionId: "crit-tokens",
      passed: false,
    });
    expect(payload.criterionResults[0].reason).toContain("unavailable");
  });

  it("treats a `{ ok: false }` COMPLETE as a failure, not a persisted verdict", async () => {
    // The route answers 200 with `{ ok: false }` on a rejected payload. If the
    // wrapper swallowed that, the runner would report `completed` while the
    // check row sat `pending` forever.
    claimSwarmChecksMock.mockResolvedValue(
      claimResult([{ role: "user", content: "hi" }]),
    );
    completeSwarmChecksMock.mockRejectedValue(
      new Error("Invalid response from backend completeSwarmChecks: rejected"),
    );

    await expect(runSwarmChecks(ARGS)).rejects.toThrow(/completeSwarmChecks/);
  });

  it("grades an EMPTY-transcript session rather than skipping it", async () => {
    // A failed attempt that never produced a turn is still a graded session:
    // "no tool errors" holds trivially and "called search" does not, and both
    // are facts worth having.
    claimSwarmChecksMock.mockResolvedValue(claimResult([]));

    const outcome = await runSwarmChecks(ARGS);

    expect(outcome.status).toBe("completed");
    const [, , payload] = completeSwarmChecksMock.mock.calls[0];
    expect(payload.criterionResults).toHaveLength(2);
    expect(payload.criterionResults[0].passed).toBe(false);
    // Zero user turns is a real reading, not absence, so `< 3` passes.
    expect(payload.criterionResults[1].passed).toBe(true);
  });
});
