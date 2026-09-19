import { describe, expect, it } from "vitest";
import {
  createJourneyOperation,
  updateJourneyOperation,
  createSwarmOperation,
  updateSwarmOperation,
} from "../../src/platform/operations.js";
describe("setupWrites operation schemas", () => {
  it.each([true, false, undefined])(
    "keeps opt-in semantics for setupWrites=%s",
    (setupWrites) => {
      const config = {
        sessionsPerTarget: 1,
        maxTurns: 6,
        ...(setupWrites === undefined ? {} : { setupWrites }),
      };
      const journey = createJourneyOperation.inputSchema.parse({
        project: "p",
        persona: "a",
        goal: "g",
        ...config,
      });
      const swarm = createSwarmOperation.inputSchema.parse({
        project: "p",
        name: "s",
        ...config,
      });
      expect(journey.setupWrites).toBe(setupWrites);
      expect(swarm.setupWrites).toBe(setupWrites);
    }
  );
  it("accepts explicit false on update schemas", () => {
    expect(
      updateJourneyOperation.inputSchema.parse({
        journey: "j",
        setupWrites: false,
      }).setupWrites
    ).toBe(false);
    expect(
      updateSwarmOperation.inputSchema.parse({ swarm: "s", setupWrites: false })
        .setupWrites
    ).toBe(false);
  });
});
