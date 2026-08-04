/**
 * "How hard to push" presets for the New swarm create flow.
 *
 * Each preset is the full set of knobs one swarm launch needs: how many
 * personas to generate, how many journeys each gets, and the per-journey run
 * config those journeys are created with. Kept as data (and out of the
 * component) because the session arithmetic is the number the user is shown
 * BEFORE spending anything, and it has to stay honest as environments are
 * added — see {@link estimateSwarmSessions}.
 *
 * Bounds these values must respect (backend validators, not style choices):
 *   personaCount    1..12  (`MAX_PERSONA_COUNT`, persona slate)
 *   journeyCount    1..5   (`MAX_JOURNEY_COUNT`, journey slate)
 *   sessionsPerTarget 1..5   (`journeys:createJourney`)
 *   maxTurns        1..20  (`journeys:createJourney`)
 */

export type SwarmPushIntensity = "quick" | "standard" | "launch";

export type SwarmIntensityPreset = {
  value: SwarmPushIntensity;
  label: string;
  personaCount: number;
  journeyCount: number;
  /** Written onto every created journey's `config`. */
  sessionsPerTarget: number;
  maxTurns: number;
  /** Rough wall-clock for one environment, for the option's detail line. */
  eta: string;
};

export const SWARM_INTENSITY_PRESETS: Record<
  SwarmPushIntensity,
  SwarmIntensityPreset
> = {
  quick: {
    value: "quick",
    label: "Quick look",
    personaCount: 3,
    journeyCount: 5,
    sessionsPerTarget: 1,
    maxTurns: 6,
    eta: "~1 min",
  },
  standard: {
    value: "standard",
    label: "Standard",
    personaCount: 6,
    journeyCount: 3,
    sessionsPerTarget: 2,
    maxTurns: 8,
    eta: "~4 min",
  },
  launch: {
    value: "launch",
    label: "Launch gate",
    personaCount: 12,
    journeyCount: 5,
    sessionsPerTarget: 2,
    maxTurns: 10,
    eta: "~15 min",
  },
};

export const SWARM_INTENSITY_ORDER: SwarmPushIntensity[] = [
  "quick",
  "standard",
  "launch",
];

export const DEFAULT_SWARM_INTENSITY: SwarmPushIntensity = "quick";

/**
 * Sessions one launch of this preset produces.
 *
 * Environments MULTIPLY: an env-based journey fans out one target per
 * environment, and each target runs `sessionsPerTarget` sessions. Quoting the
 * single-environment number for a two-environment swarm would understate the
 * spend by half, so the count is computed from the current selection rather
 * than baked into the preset's copy.
 */
export function estimateSwarmSessions(
  preset: SwarmIntensityPreset,
  environmentCount: number
): number {
  return (
    preset.personaCount *
    preset.journeyCount *
    preset.sessionsPerTarget *
    Math.max(1, environmentCount)
  );
}

/** Journeys one launch of this preset creates (personas × journeys each). */
export function estimateSwarmJourneys(preset: SwarmIntensityPreset): number {
  return preset.personaCount * preset.journeyCount;
}
