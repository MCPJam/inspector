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

/** What a persona starts at, and what a goal carrying no config is read as. */
export const DEFAULT_SWARM_ITERATIONS =
  SWARM_INTENSITY_PRESETS[DEFAULT_SWARM_INTENSITY].sessionsPerTarget;

/** Journeys one launch of this preset creates (personas × journeys each). */
export function estimateSwarmJourneys(preset: SwarmIntensityPreset): number {
  return preset.personaCount * preset.journeyCount;
}

/**
 * Conversations the launch on Confirm actually produces.
 *
 * Iterations are per PERSONA, not per swarm: the generator hands every
 * persona the same number of goals, but the user edits that slate before
 * launching, so one persona can end up carrying three goals and its
 * neighbour five. A single swarm-wide multiplicand cannot describe that.
 *
 * Environments multiply the whole thing — an env-based journey creates one
 * target per environment — which is why they are applied once here rather
 * than shown on each persona: the per-persona subtotals are per environment.
 *
 * A REUSED goal is priced at its own stored sessions. Launch deliberately
 * does not rewrite a shared journey's config, so quoting a counter for it
 * would both misreport the spend and move the quote every time a control is
 * touched, for work that control does not size. `null` is the one case where
 * the default answers: a row carrying no config gives nothing better.
 */
export function estimateLaunchSessions({
  personas,
  reusedSessionsPerTarget,
  environmentCount,
}: {
  /** One entry per newly authored persona: its goals and its own iterations. */
  personas: readonly { goalCount: number; iterations: number }[];
  /** One entry per reused goal: its own stored sessions, or `null`. */
  reusedSessionsPerTarget: readonly (number | null)[];
  environmentCount: number;
}): number {
  const authored = personas.reduce(
    (sum, persona) => sum + persona.goalCount * persona.iterations,
    0,
  );
  const reused = reusedSessionsPerTarget.reduce<number>(
    (sum, sessions) => sum + (sessions ?? DEFAULT_SWARM_ITERATIONS),
    0,
  );
  return (authored + reused) * Math.max(1, environmentCount);
}

/**
 * Where the iterations control starts for a REUSED persona.
 *
 * Its goals each carry their owner's own saved `sessionsPerTarget`, so there
 * is a value worth showing only when they agree. Goals that disagree — or any
 * goal with nothing saved — have no single truth to display, and picking one
 * of them would misreport the others. The default starts the control instead,
 * and whatever the user sets applies to all of that persona's goals for this
 * run.
 *
 * Clamped, because a value saved before the current bounds must not seed a
 * control whose every value the backend would then reject.
 */
export function reusedIterationsSeed(
  stored: readonly (number | null | undefined)[],
): number {
  const first = stored[0];
  if (first == null || stored.some((value) => value !== first)) {
    return DEFAULT_SWARM_ITERATIONS;
  }
  return Math.min(MAX_SWARM_ITERATIONS, Math.max(MIN_SWARM_ITERATIONS, first));
}
