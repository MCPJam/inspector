import { describe, expect, it } from "vitest";
import { AGENT_OP_REGISTRY, EXCLUDED_FROM_AGENT } from "../agent-op-registry.js";

const entry = (name: string) => AGENT_OP_REGISTRY.find((candidate) => candidate.operation.name === name);

describe("the headless agent and climbs", () => {
  it("proposes a climb and a round for a person to approve, and says what they spend", () => {
    const start = entry("start_climb");
    expect(start?.tier).toBe("gated");
    if (start?.tier !== "gated") return;
    expect(start.proposal.confirmSeverity).toBe("spend");
    expect(start.proposal.describe({ suite: "Smoke", server: "docs", roundLimit: 3, creditLimit: 400 })).toBe(
      "Start a climb of docs on suite Smoke: two baseline runs in each environment, then up to 3 rounds and 400 credits",
    );
    expect(start.proposal.target?.({ suite: "Smoke" })).toEqual({ type: "eval_suite", selector: "Smoke" });

    const round = entry("submit_climb_round");
    expect(round?.tier).toBe("gated");
    if (round?.tier !== "gated") return;
    expect(round.proposal.describe({ climb: "c1", server: "docs (mock)" })).toContain("docs (mock) as the next round of climb c1");
  });

  it("proposes resuming a paused climb, as a spend", () => {
    const resume = entry("continue_climb");
    expect(resume?.tier).toBe("gated");
    if (resume?.tier !== "gated") return;
    expect(resume.proposal.confirmSeverity).toBe("spend");
    expect(resume.proposal.describe({ climb: "c1" })).toContain("Continue climb c1: MCPJam picks the next change");
  });

  it("reads and overrules directly, and never stops a climb for a person", () => {
    for (const name of ["get_climb", "list_climbs", "get_climb_round", "update_climb", "set_climb_round_decision"]) {
      expect(entry(name)?.tier, name).toBe("direct");
    }
    expect(entry("stop_climb")).toBeUndefined();
    expect(EXCLUDED_FROM_AGENT.stop_climb).toMatch(/cancels the round in flight/);
  });
});
