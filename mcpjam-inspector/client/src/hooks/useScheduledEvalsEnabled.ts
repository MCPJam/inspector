import { useFeatureFlagEnabled } from "posthog-js/react";

export const SCHEDULED_EVALS_FEATURE_FLAG = "scheduled-evals-enabled";

/**
 * Schedule — scheduled suite runs: the Triggers tab's "Scheduled runs" row
 * (interval picker, environment pin, Resume) and the Monitoring rail item a
 * scheduled suite earns.
 *
 * Its OWN flag, split out of `synthetic-monitors`. That flag still gates the
 * synthetic-monitor scorer kinds and the widget-probe half of Monitoring —
 * separately shipped surfaces — so sharing it meant Schedule could not go dark
 * without taking them with it. Schedule has not been thoroughly tested, and
 * this flag starts OFF for everyone so that stays true on the screen.
 *
 * VISIBILITY ONLY, and not the whole story: the write path answers to
 * `MCPJAM_SCHEDULED_EVALS_WRITE_ENABLED` on the server (which refuses an
 * ENABLE from every agent-facing writer — SDK, MCP tool, CLI, proposal
 * execution), and a schedule already enabled keeps firing until the worker is
 * stopped or the schedule is disabled. Hiding the row stops nothing that is
 * already running.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (fail-closed) here, like every sibling flag hook. Every consumer is a
 * visibility gate rather than a route guard, so the boolean is the one to
 * reach for; {@link useScheduledEvalsEnabledState} exists for the tri-state a
 * route guard would need, and mirrors `useEvaluateEnabledState`.
 */
export function useScheduledEvalsEnabled(): boolean {
  return useFeatureFlagEnabled(SCHEDULED_EVALS_FEATURE_FLAG) === true;
}

/** Tri-state variant: `undefined` while PostHog flags are still loading. */
export function useScheduledEvalsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(SCHEDULED_EVALS_FEATURE_FLAG);
}
