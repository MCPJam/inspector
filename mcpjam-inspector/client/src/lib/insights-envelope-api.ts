/**
 * The common actionable-insights envelope — client contract.
 *
 * ONE shape across Eval runs, Swarm waves, and User Testing windows, so the
 * three surfaces render through one component instead of three that drift.
 *
 * The shapes are now ALIASES of `@mcpjam/sdk/platform`'s published types, not
 * a third hand-maintained copy. The backend/SDK boundary is unavoidable (a
 * Convex function cannot import the SDK), but the client's copy was avoidable
 * and is gone: a field added to the SDK reaches every component here without
 * anyone remembering to re-type it. The names below are unchanged, so no call
 * site moved.
 *
 * Query names live here for the same reason they do in `swarm-api.ts` — a
 * backend rename is chased through one file, not every component.
 *
 * The distinction the whole surface exists to preserve: a finding is only a
 * SERVER REPAIR TASK when the backend's promotion gate said so
 * (`actionTarget: "mcp_server"` AND `actionability: "ready"`). Everything
 * else names work somewhere else — the agent's prompt, the eval case, the
 * environment, or an investigation — and must never be rendered as
 * "fix your MCP server".
 */

export type {
  PlatformSwarmJourneyFinding as SwarmJourneyFinding,
  PlatformSwarmJourneyFindings as SwarmJourneyFindings,
} from "@mcpjam/sdk/platform";
import type {
  PlatformActionableFinding,
  PlatformActionableFindingEvidence,
  PlatformInsightActionTarget,
  PlatformInsightActionability,
  PlatformInsightAttribution,
  PlatformInsightsEnvelope,
  PlatformInsightsFindingProvenance,
  PlatformInsightsObservationCoverage,
  PlatformInsightsObservationState,
  PlatformInsightsStatus,
  PlatformUnifiedFindings,
} from "@mcpjam/sdk/platform";

export type InsightsEnvelopeStatus = PlatformInsightsStatus;
export type InsightAttribution = PlatformInsightAttribution;
export type InsightActionTarget = PlatformInsightActionTarget;
export type InsightActionability = PlatformInsightActionability;
export type InsightFindingCategory = PlatformActionableFinding["category"];
export type InsightTargetSurface = NonNullable<
  PlatformActionableFinding["target"]
>["surface"];
export type ActionableFindingEvidence = PlatformActionableFindingEvidence;
export type ActionableFinding = PlatformActionableFinding;
export type InsightsEnvelope = PlatformInsightsEnvelope;

// ── findings (additive; absent on a backend that predates them) ─────────────

export type InsightsObservationState = PlatformInsightsObservationState;
export type InsightsObservationCoverage = PlatformInsightsObservationCoverage;
export type InsightsFindingProvenance = PlatformInsightsFindingProvenance;
export type UnifiedFindings = PlatformUnifiedFindings;

export const INSIGHTS_ENVELOPE_QUERIES = {
  /** Eval run → serverQuality projected into the common envelope. */
  evalRun: "serverQuality:getEvalRunInsightsEnvelope",
  /** Journey run → resolved through its wave; carries `runHealth`. */
  journeyRun: "swarmWaveInsights:getJourneyRunInsightsEnvelope",
  /** Scenario → its latest frozen window. Workspace MEMBERS only. */
  scenario: "scenarioWindowInsights:getScenarioInsightsEnvelope",
} as const;

/** The one predicate that authorizes a server-fix affordance. Exported so
 * every call site asks the same question — a component that checks only
 * `actionTarget === "mcp_server"` would offer a fix prompt for an
 * unproven mechanism. */
export function isServerReady(finding: ActionableFinding): boolean {
  return (
    finding.actionTarget === "mcp_server" && finding.actionability === "ready"
  );
}

/**
 * Presentation order, per the plan: server fixes that are actionable, then
 * server issues needing investigation, then work that belongs to the agent,
 * the test, and finally informational rows. Stable within a bucket (the
 * backend already sorted by severity).
 */
const GROUP_RANK: Record<string, number> = {
  server_ready: 0,
  server_investigate: 1,
  agent_configuration: 2,
  eval_case: 3,
  // Investigations rank above environment/informational rows, matching the
  // section order below them. They disagreed before, so with more findings
  // than fit, environment rows survived the cut and still rendered last.
  investigate: 4,
  environment: 5,
};

export function findingGroup(finding: ActionableFinding): string {
  if (isServerReady(finding)) return "server_ready";
  if (finding.actionTarget === "mcp_server") return "server_investigate";
  if (finding.actionability === "informational") return "environment";
  return finding.actionTarget;
}

export function sortFindingsForDisplay(
  findings: readonly ActionableFinding[],
): ActionableFinding[] {
  return [...findings].sort(
    (a, b) =>
      (GROUP_RANK[findingGroup(a)] ?? 9) - (GROUP_RANK[findingGroup(b)] ?? 9),
  );
}

/**
 * The ONE selector that decides which findings a surface renders.
 *
 * `currentFindings ?? findings`, and nothing cleverer. The `??` is
 * load-bearing in both directions:
 *
 *  - a server that predates the experiment omits `currentFindings`, so the
 *    legacy generated array is what there is;
 *  - a server that HAS it and sends `[]` is saying "nothing here needs a
 *    change", and falling back to stale generated findings would turn a real
 *    clean answer into yesterday's complaints.
 *
 * Every call site asks through this function so that rule is stated once.
 */
export function selectCurrentFindings(
  envelope: Pick<InsightsEnvelope, "findings" | "currentFindings">,
): ActionableFinding[] {
  return envelope.currentFindings ?? envelope.findings;
}

/**
 * The findings payload, or `null` when the backend does not serve it.
 *
 * A client talking to a backend that predates findings must keep working and
 * must SAY the pairing is incomplete — never retry a missing function.
 */
export function unifiedFindingsOf(
  envelope: InsightsEnvelope | null | undefined,
): UnifiedFindings | null {
  const payload = envelope?.unifiedFindings;
  return payload?.capability === "unified_findings_v1" ? payload : null;
}
