/**
 * The launch quote is the only number the user sees before spending anything,
 * and the iterations it multiplies are written onto every journey the swarm
 * creates. Two things must hold: the quote matches the arithmetic the launch
 * actually performs, and every knob stays inside the backend validators (which
 * reject, not clamp).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWARM_ITERATIONS,
  MAX_SWARM_ITERATIONS,
  MIN_SWARM_ITERATIONS,
  reusedIterationsSeed,
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
 * The counter sizes the journeys this swarm CREATES, per persona. Launch does
 * not rewrite a shared journey's config, so the quote has to be built the same
 * way — otherwise moving one persona's counter silently re-prices work it does
 * not size.
 */
describe("estimateLaunchSessions", () => {
  it("multiplies each persona's own goals by its own iterations", () => {
    // The reason the counter moved onto the cards: the generator hands every
    // persona the same goals, but the user edits that slate, so there is no
    // single "goals per persona" left to multiply by.
    expect(
      estimateLaunchSessions({
        personas: [
          { goalCount: 5, iterations: 2 },
          { goalCount: 3, iterations: 1 },
        ],
        reusedSessionsPerTarget: [],
        environmentCount: 1,
      })
    ).toBe(13);
  });

  it("leaves the other personas alone when one counter moves", () => {
    const quoteFirstAt = (iterations: number) =>
      estimateLaunchSessions({
        personas: [
          { goalCount: 5, iterations },
          { goalCount: 3, iterations: 1 },
        ],
        reusedSessionsPerTarget: [],
        environmentCount: 1,
      });
    expect(quoteFirstAt(2) - quoteFirstAt(1)).toBe(5);
  });

  it("applies environments once, to the whole slate", () => {
    expect(
      estimateLaunchSessions({
        personas: [
          { goalCount: 5, iterations: 2 },
          { goalCount: 3, iterations: 1 },
        ],
        reusedSessionsPerTarget: [],
        environmentCount: 3,
      })
    ).toBe(39);
  });

  it("treats no environment as one — the quote is never zero", () => {
    expect(
      estimateLaunchSessions({
        personas: [{ goalCount: 2, iterations: 1 }],
        reusedSessionsPerTarget: [],
        environmentCount: 0,
      })
    ).toBe(2);
  });

  it("prices reused goals at their own sessions, not a counter's", () => {
    expect(
      estimateLaunchSessions({
        personas: [],
        reusedSessionsPerTarget: [4, 1],
        environmentCount: 1,
      })
    ).toBe(5);
  });

  it("holds reused sessions steady while an authored counter moves", () => {
    const quoteAt = (iterations: number) =>
      estimateLaunchSessions({
        personas: [{ goalCount: 1, iterations }],
        reusedSessionsPerTarget: [4],
        environmentCount: 2,
      });
    expect(quoteAt(1)).toBe(10);
    expect(quoteAt(3)).toBe(14);
  });

  it("reads a row carrying no config at the default", () => {
    expect(
      estimateLaunchSessions({
        personas: [],
        reusedSessionsPerTarget: [null],
        environmentCount: 1,
      })
    ).toBe(DEFAULT_SWARM_ITERATIONS);
  });

  it("adds authored and reused, then fans both out", () => {
    expect(
      estimateLaunchSessions({
        personas: [{ goalCount: 3, iterations: 2 }],
        reusedSessionsPerTarget: [5],
        environmentCount: 2,
      })
    ).toBe(22);
  });
});

describe("reusedIterationsSeed", () => {
  /**
   * A reused persona's goals each carry their owner's saved sessions, so the
   * control that now sets one number for the whole persona has to start
   * somewhere. Agreeing goals seed their own value; disagreeing ones have no
   * single truth to show, so the default is the honest starting point.
   */
  it("seeds from the saved value when every goal agrees", () => {
    expect(reusedIterationsSeed([3, 3, 3])).toBe(3);
  });

  it("falls back to the default when goals disagree", () => {
    expect(reusedIterationsSeed([5, 1])).toBe(DEFAULT_SWARM_ITERATIONS);
  });

  it("treats an unsaved goal as the default rather than guessing", () => {
    expect(reusedIterationsSeed([null, null])).toBe(DEFAULT_SWARM_ITERATIONS);
    expect(reusedIterationsSeed([3, null])).toBe(DEFAULT_SWARM_ITERATIONS);
  });

  it("stays inside the bounds the backend enforces", () => {
    expect(reusedIterationsSeed([99])).toBe(MAX_SWARM_ITERATIONS);
    expect(reusedIterationsSeed([0])).toBe(MIN_SWARM_ITERATIONS);
  });

  it("defaults an empty goal list", () => {
    expect(reusedIterationsSeed([])).toBe(DEFAULT_SWARM_ITERATIONS);
  });
});
