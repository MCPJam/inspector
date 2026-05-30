import { describe, it, expect } from "vitest";
import {
  TOOL_RATING_SEVERITY,
  WORKFLOW_EFFICIENCY_SEVERITY,
} from "../ai-triage-helpers";

// Pins the client copy of the serverQuality severity weights to the backend
// source of truth (mcpjam-backend/convex/lib/serverQualityScore.ts). The two
// repos can't share code, so this test is the only guard against drift: if it
// fails, the copies diverged — make them match on BOTH sides (and re-check the
// harness compositeScore baseline, which depends on these weights).
describe("serverQuality severity weights (synced with backend)", () => {
  it("tool rating weights", () => {
    expect(TOOL_RATING_SEVERITY).toEqual({
      poor: 3,
      needs_improvement: 2,
      good: 0,
    });
  });

  it("workflow efficiency weights", () => {
    expect(WORKFLOW_EFFICIENCY_SEVERITY).toEqual({
      excessive: 3,
      inefficient: 2,
      acceptable: 1,
      optimal: 0,
    });
  });
});
