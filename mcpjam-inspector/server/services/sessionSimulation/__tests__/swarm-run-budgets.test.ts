import { describe, expect, it } from "vitest";
import {
  platformExecutionBudgetCeilings,
  platformExecutionBudgetDefaults,
  type ResolvedExecutionBudgets,
} from "@mcpjam/sdk/contract";
import { swarmRunBudgets } from "../swarm-run-budgets.js";

const DEFAULTS = platformExecutionBudgetDefaults("swarms");

const FROZEN: ResolvedExecutionBudgets = {
  turnTimeoutMs: DEFAULTS.turnTimeoutMs,
  unitTimeoutMs: DEFAULTS.unitTimeoutMs,
  runTimeoutMs: DEFAULTS.runTimeoutMs,
  turnRetries: DEFAULTS.turnRetries,
  sources: {
    turnTimeoutMs: "default",
    unitTimeoutMs: "default",
    runTimeoutMs: "default",
    turnRetries: "default",
  },
};

describe("swarmRunBudgets", () => {
  it("runs frozen budgets as frozen, however many sessions run locally", () => {
    // 30 local sessions would size a default run clock to 15 units. The
    // backend sized this one when it froze it, so it is not sized again.
    expect(swarmRunBudgets(FROZEN, 30)).toEqual(FROZEN);
  });

  it("sizes the default run clock for local sessions, two at a time", () => {
    expect(swarmRunBudgets(undefined, 0).runTimeoutMs).toBe(
      DEFAULTS.runTimeoutMs,
    );
    expect(swarmRunBudgets(undefined, 15).runTimeoutMs).toBe(
      8 * DEFAULTS.unitTimeoutMs,
    );
  });

  it("never sizes the default run clock past the platform ceiling", () => {
    expect(swarmRunBudgets(undefined, 1_000).runTimeoutMs).toBe(
      platformExecutionBudgetCeilings("swarms").runTimeoutMs,
    );
  });
});
