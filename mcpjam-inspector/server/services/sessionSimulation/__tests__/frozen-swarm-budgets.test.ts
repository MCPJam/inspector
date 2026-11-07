import { describe, expect, it } from "vitest";
import {
  readFrozenSwarmBudgets,
  UNREADABLE_SWARM_BUDGETS_MESSAGE,
  UNSUPPORTED_SWARM_BUDGETS_MESSAGE,
} from "../frozen-swarm-budgets.js";

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

// Only `executionBudgets` is read, so the rest of the snapshot is left out.
const launched = (fields: Record<string, unknown>) =>
  fields as Parameters<typeof readFrozenSwarmBudgets>[0];

describe("readFrozenSwarmBudgets", () => {
  it("reads budgets the backend froze into the snapshot", () => {
    expect(
      readFrozenSwarmBudgets(launched({ executionBudgets: FROZEN })),
    ).toEqual({ ok: true, budgets: FROZEN });
  });

  it("reports none for a snapshot from a backend that froze none", () => {
    expect(readFrozenSwarmBudgets(launched({ hosts: [] }))).toEqual({
      ok: true,
    });
    expect(
      readFrozenSwarmBudgets(launched({ executionBudgets: undefined })),
    ).toEqual({ ok: true });
  });

  it.each([
    ["a zero clock from a misconfigured org ceiling", { unitTimeoutMs: 0 }],
    ["a fractional clock", { runTimeoutMs: 1.5 }],
    ["a missing clock", { turnTimeoutMs: undefined }],
  ])("refuses %s and points at the org's limits", (_label, change) => {
    const result = readFrozenSwarmBudgets(
      launched({ executionBudgets: { ...FROZEN, ...change } }),
    );
    expect(result).toMatchObject({
      ok: false,
      message: UNREADABLE_SWARM_BUDGETS_MESSAGE,
    });
  });

  it.each([
    ["a clock this runner does not know", { sessionGapMs: 1_000 }],
    [
      "a provenance this runner does not know",
      { sources: { ...FROZEN.sources, runTimeoutMs: "ceiling" } },
    ],
  ])("refuses %s and asks for an update, not an admin", (_label, change) => {
    const result = readFrozenSwarmBudgets(
      launched({ executionBudgets: { ...FROZEN, ...change } }),
    );
    expect(result).toMatchObject({
      ok: false,
      message: UNSUPPORTED_SWARM_BUDGETS_MESSAGE,
    });
  });

  it("refuses a value that is not an object", () => {
    for (const executionBudgets of [null, "2h"]) {
      expect(
        readFrozenSwarmBudgets(launched({ executionBudgets })),
      ).toMatchObject({ ok: false, message: UNREADABLE_SWARM_BUDGETS_MESSAGE });
    }
  });
});
