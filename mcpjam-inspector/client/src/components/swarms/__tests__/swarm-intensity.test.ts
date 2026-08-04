/**
 * The intensity presets are the only place the create flow quotes a number
 * before the user spends anything, and they are also the values written onto
 * every journey. Two things must hold: the quoted session count matches the
 * arithmetic the launch actually performs, and every knob stays inside the
 * backend validators (which reject, not clamp).
 */
import { describe, expect, it } from "vitest";
import {
  SWARM_INTENSITY_ORDER,
  SWARM_INTENSITY_PRESETS,
  estimateSwarmJourneys,
  estimateSwarmSessions,
} from "../swarm-intensity";

describe("swarm intensity presets", () => {
  it("quotes the advertised session counts for a single environment", () => {
    expect(estimateSwarmSessions(SWARM_INTENSITY_PRESETS.quick, 1)).toBe(15);
    expect(estimateSwarmSessions(SWARM_INTENSITY_PRESETS.standard, 1)).toBe(36);
    expect(estimateSwarmSessions(SWARM_INTENSITY_PRESETS.launch, 1)).toBe(120);
  });

  it("treats no environment as one — the quote is never zero", () => {
    expect(estimateSwarmSessions(SWARM_INTENSITY_PRESETS.quick, 0)).toBe(15);
  });

  it("multiplies by environments, because each one is a separate target", () => {
    expect(estimateSwarmSessions(SWARM_INTENSITY_PRESETS.quick, 3)).toBe(45);
    expect(estimateSwarmSessions(SWARM_INTENSITY_PRESETS.standard, 2)).toBe(72);
  });

  it("counts journeys as personas × journeys each", () => {
    expect(estimateSwarmJourneys(SWARM_INTENSITY_PRESETS.launch)).toBe(60);
  });

  it("stays inside every backend validator bound", () => {
    for (const value of SWARM_INTENSITY_ORDER) {
      const preset = SWARM_INTENSITY_PRESETS[value];
      // MAX_PERSONA_COUNT / MAX_JOURNEY_COUNT on the generation routes,
      // sessionsPerTarget + maxTurns on journeys:createJourney.
      expect(preset.personaCount).toBeGreaterThanOrEqual(1);
      expect(preset.personaCount).toBeLessThanOrEqual(12);
      expect(preset.journeyCount).toBeGreaterThanOrEqual(1);
      expect(preset.journeyCount).toBeLessThanOrEqual(5);
      expect(preset.sessionsPerTarget).toBeGreaterThanOrEqual(1);
      expect(preset.sessionsPerTarget).toBeLessThanOrEqual(5);
      expect(preset.maxTurns).toBeGreaterThanOrEqual(1);
      expect(preset.maxTurns).toBeLessThanOrEqual(20);
    }
  });

  it("orders presets from cheapest to most expensive", () => {
    const sessions = SWARM_INTENSITY_ORDER.map((value) =>
      estimateSwarmSessions(SWARM_INTENSITY_PRESETS[value], 1)
    );
    expect(sessions).toEqual([...sessions].sort((a, b) => a - b));
  });
});
