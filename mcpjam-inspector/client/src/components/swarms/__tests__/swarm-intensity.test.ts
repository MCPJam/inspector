/**
 * The launch quote is the only number the user sees before spending anything,
 * and the iterations it multiplies are written onto every journey the swarm
 * creates. Two things must hold: the quote matches the arithmetic the launch
 * actually performs, and every knob stays inside the backend validators (which
 * reject, not clamp).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SWARM_ITERATIONS,
  MIN_SWARM_ITERATIONS,
  SWARM_INTENSITY_PRESETS,
  estimateLaunchSessions,
  estimateSwarmJourneys,
} from "../swarm-intensity";

describe("swarm intensity presets", () => {
  it("counts journeys as personas × journeys each", () => {
    expect(estimateSwarmJourneys(SWARM_INTENSITY_PRESETS.launch)).toBe(60);
  });

  it("stays inside every backend validator bound", () => {
    for (const preset of Object.values(SWARM_INTENSITY_PRESETS)) {
      // MAX_PERSONA_COUNT / MAX_JOURNEY_COUNT on the generation routes,
      // sessionsPerTarget + maxTurns on journeys:createJourney.
      expect(preset.personaCount).toBeGreaterThanOrEqual(1);
      expect(preset.personaCount).toBeLessThanOrEqual(12);
      expect(preset.journeyCount).toBeGreaterThanOrEqual(1);
      expect(preset.journeyCount).toBeLessThanOrEqual(5);
      expect(preset.maxTurns).toBeGreaterThanOrEqual(1);
      expect(preset.maxTurns).toBeLessThanOrEqual(20);
    }
  });

  it("seeds the iterations control from inside its own range", () => {
    // The preset's sessionsPerTarget lands in the control on Confirm. A seed
    // outside the control's bounds would render a value the user cannot
    // return to after touching the counter.
    for (const preset of Object.values(SWARM_INTENSITY_PRESETS)) {
      expect(preset.sessionsPerTarget).toBeGreaterThanOrEqual(
        MIN_SWARM_ITERATIONS,
      );
      expect(preset.sessionsPerTarget).toBeLessThanOrEqual(
        MAX_SWARM_ITERATIONS,
      );
    }
  });

  it("keeps the control inside what journeys:createJourney accepts", () => {
    expect(MIN_SWARM_ITERATIONS).toBeGreaterThanOrEqual(1);
    expect(MAX_SWARM_ITERATIONS).toBeLessThanOrEqual(5);
  });
});

/**
 * The control sizes the journeys this swarm CREATES. Launch deliberately does
 * not rewrite a shared journey's config, so the quote has to be built the same
 * way — otherwise moving the counter silently re-prices work it does not size.
 */
describe("estimateLaunchSessions", () => {
  it("multiplies goals, iterations and environments", () => {
    expect(
      estimateLaunchSessions({
        iterations: 2,
        newJourneyCount: 20,
        reusedSessionsPerTarget: [],
        environmentCount: 3,
      }),
    ).toBe(120);
  });

  it("treats no environment as one — the quote is never zero", () => {
    expect(
      estimateLaunchSessions({
        iterations: 1,
        newJourneyCount: 2,
        reusedSessionsPerTarget: [],
        environmentCount: 0,
      }),
    ).toBe(2);
  });

  it("prices reused journeys at their own sessions, not the counter's", () => {
    expect(
      estimateLaunchSessions({
        iterations: 2,
        newJourneyCount: 0,
        reusedSessionsPerTarget: [4, 1],
        environmentCount: 1,
      }),
    ).toBe(5);
  });

  it("holds a reused journey's sessions steady across a counter change", () => {
    const quoteAt = (iterations: number) =>
      estimateLaunchSessions({
        iterations,
        newJourneyCount: 0,
        reusedSessionsPerTarget: [4],
        environmentCount: 2,
      });
    expect(quoteAt(1)).toBe(8);
    expect(quoteAt(5)).toBe(8);
  });

  it("still seeds rows that carry no config of their own", () => {
    expect(
      estimateLaunchSessions({
        iterations: 2,
        newJourneyCount: 0,
        reusedSessionsPerTarget: [null],
        environmentCount: 1,
      }),
    ).toBe(2);
  });

  it("sizes newly authored journeys by the counter, and fans both out", () => {
    expect(
      estimateLaunchSessions({
        iterations: 2,
        newJourneyCount: 3,
        reusedSessionsPerTarget: [5],
        environmentCount: 2,
      }),
    ).toBe(22);
  });
});
