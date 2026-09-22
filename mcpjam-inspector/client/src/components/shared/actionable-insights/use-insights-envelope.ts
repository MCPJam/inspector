/**
 * One subscription helper for the common insights envelope, across all three
 * surfaces.
 *
 * The surface union is what keeps the panel surface-agnostic: callers name
 * what they are (an eval run, a journey run, a scenario) and get the same
 * envelope back. `"skip"` until the ids are known, per the client's standing
 * convention — a query fired with a placeholder id is a wasted round trip and,
 * on an authorization-scoped read, a spurious refusal.
 */
import { useQuery } from "convex/react";
import {
  INSIGHTS_ENVELOPE_QUERIES,
  type InsightsEnvelope,
} from "@/lib/insights-envelope-api";

export type InsightsEnvelopeSurface =
  | { kind: "eval_run"; suiteRunId: string | null | undefined }
  | {
      kind: "journey_run";
      projectId: string | null | undefined;
      runId: string | null | undefined;
    }
  | { kind: "scenario"; scenarioId: string | null | undefined };

function queryFor(surface: InsightsEnvelopeSurface): {
  name: string;
  args: Record<string, string> | "skip";
} {
  switch (surface.kind) {
    case "eval_run":
      return {
        name: INSIGHTS_ENVELOPE_QUERIES.evalRun,
        args: surface.suiteRunId ? { suiteRunId: surface.suiteRunId } : "skip",
      };
    case "journey_run":
      return {
        name: INSIGHTS_ENVELOPE_QUERIES.journeyRun,
        args:
          surface.projectId && surface.runId
            ? { projectId: surface.projectId, runId: surface.runId }
            : "skip",
      };
    case "scenario":
      return {
        name: INSIGHTS_ENVELOPE_QUERIES.scenario,
        args: surface.scenarioId ? { scenarioId: surface.scenarioId } : "skip",
      };
  }
}

/**
 * `undefined` while loading (or skipped), `null` when the backend has no
 * envelope for this resource — the panel renders nothing for both, so a
 * surface deployed against an older backend degrades silently instead of
 * erroring.
 */
export function useInsightsEnvelope(
  surface: InsightsEnvelopeSurface,
): InsightsEnvelope | null | undefined {
  const { name, args } = queryFor(surface);
  return useQuery(name as never, args as never) as
    | InsightsEnvelope
    | null
    | undefined;
}
