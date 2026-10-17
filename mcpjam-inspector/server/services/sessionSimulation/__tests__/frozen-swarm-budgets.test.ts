import { describe, expect, it } from "vitest";
import { readFrozenSwarmBudgets } from "../frozen-swarm-budgets.js";

const FROZEN = {
  turnTimeoutMs: 6 * 60_000,
  unitTimeoutMs: 20 * 60_000,
  runTimeoutMs: 2 * 60 * 60_000,
  turnRetries: 2,
  sources: {
    turnTimeoutMs: "default",
    unitTimeoutMs: "authored",
    runTimeoutMs: "default",
    turnRetries: "default",
  },
};

describe("readFrozenSwarmBudgets", () => {
  it("reads budgets the backend froze into the snapshot", () => {
    expect(readFrozenSwarmBudgets({ executionBudgets: FROZEN })).toEqual({
      ok: true,
      budgets: FROZEN,
    });
  });

  it("reports none for a snapshot from a backend that froze none", () => {
    expect(readFrozenSwarmBudgets({ hosts: [] })).toEqual({ ok: true });
    expect(readFrozenSwarmBudgets({ executionBudgets: undefined })).toEqual({
      ok: true,
    });
  });

  it.each([
    ["a zero clock from a misconfigured org ceiling", { unitTimeoutMs: 0 }],
    ["a fractional clock", { runTimeoutMs: 1.5 }],
    ["a clock this runner does not know", { sessionGapMs: 1_000 }],
    ["a missing clock", { turnTimeoutMs: undefined }],
  ])("refuses %s rather than defaulting it", (_label, change) => {
    const result = readFrozenSwarmBudgets({
      executionBudgets: { ...FROZEN, ...change },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a value that is not an object", () => {
    expect(readFrozenSwarmBudgets({ executionBudgets: null }).ok).toBe(false);
    expect(readFrozenSwarmBudgets({ executionBudgets: "2h" }).ok).toBe(false);
  });
});
