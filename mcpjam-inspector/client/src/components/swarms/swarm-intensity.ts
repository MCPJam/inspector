/**
 * "How hard to push" presets for the New swarm create flow.
 *
 * The preset sizes GENERATION — how many personas the Describe step asks for
 * and how many journeys each gets. It no longer sizes the launch: by Confirm
 * the slate exists, and the user sets iterations directly, because three
 * buttons that each resolve to one `sessionsPerTarget` could quote the same
 * conversation count as each other (BB-194).
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
  /** Seeds the iterations control, and written onto every created journey. */
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
    label: "Launch ready",
    personaCount: 12,
    journeyCount: 5,
    sessionsPerTarget: 2,
    maxTurns: 10,
    eta: "~15 min",
  },
};

export const DEFAULT_SWARM_INTENSITY: SwarmPushIntensity = "quick";

/** `journeys:createJourney` rejects a `sessionsPerTarget` outside this range. */
export const MIN_SWARM_ITERATIONS = 1;
export const MAX_SWARM_ITERATIONS = 5;

/** Journeys one launch of this preset creates (personas × journeys each). */
export function estimateSwarmJourneys(preset: SwarmIntensityPreset): number {
  return preset.personaCount * preset.journeyCount;
}

/**
 * Conversations the launch on Confirm actually produces.
 *
 * Three multiplicands, and only the middle one is the control:
 *   - goals, the flat unit a swarm fans out (personas hold them, but a persona
 *     can carry a different number of goals than its neighbour, so there is no
 *     single "goals per persona" to multiply by);
 *   - iterations, run per goal per environment;
 *   - environments, because an env-based journey creates one target each.
 *
 * A REUSED journey is priced at its own stored sessions. Launch deliberately
 * does not rewrite a shared journey's config, so quoting the iterations
 * control for it would both misreport the spend and move the quote every time
 * the control is touched, for work the control does not size. `null` is the
 * one case where the control does answer: a row carrying no config at all
 * gives nothing better to quote.
 */
export function estimateLaunchSessions({
  iterations,
  newJourneyCount,
  reusedSessionsPerTarget,
  environmentCount,
}: {
  /** Iterations per goal, as set on Confirm. Stamped onto new journeys. */
  iterations: number;
  /** Newly authored journeys — the ones the iterations count is stamped onto. */
  newJourneyCount: number;
  /** One entry per reused journey: its own stored sessions, or `null`. */
  reusedSessionsPerTarget: readonly (number | null)[];
  environmentCount: number;
}): number {
  const reused = reusedSessionsPerTarget.reduce<number>(
    (sum, sessions) => sum + (sessions ?? iterations),
    0,
  );
  return (
    (newJourneyCount * iterations + reused) * Math.max(1, environmentCount)
  );
}
