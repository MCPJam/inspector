/**
 * The common actionable-insights envelope — client contract.
 *
 * ONE shape across Eval runs, Swarm waves, and User Testing windows, so the
 * three surfaces render through one component instead of three that drift.
 * Types are hand-mirrored from `convex/lib/insightsEnvelope.ts` and
 * `convex/lib/actionableFindingsValidators.ts` (two-repo norm); query names
 * live here for the same reason they do in `swarm-api.ts` — a backend rename
 * is chased through one file, not every component.
 *
 * The distinction the whole surface exists to preserve: a finding is only a
 * SERVER REPAIR TASK when the backend's promotion gate said so
 * (`actionTarget: "mcp_server"` AND `actionability: "ready"`). Everything
 * else names work somewhere else — the agent's prompt, the eval case, the
 * environment, or an investigation — and must never be rendered as
 * "fix your MCP server".
 */

export const INSIGHTS_ENVELOPE_QUERIES = {
  /** Eval run → serverQuality projected into the common envelope. */
  evalRun: "serverQuality:getEvalRunInsightsEnvelope",
  /** Journey run → resolved through its wave; carries `runHealth`. */
  journeyRun: "swarmWaveInsights:getJourneyRunInsightsEnvelope",
  /** Scenario → its latest frozen window. Workspace MEMBERS only. */
  scenario: "chatboxWindowInsights:getScenarioInsightsEnvelope",
} as const;

export type InsightsEnvelopeStatus =
  | "not_available"
  | "not_requested"
  | "pending"
  | "completed"
  | "failed";

export type InsightAttribution =
  | "unknown"
  | "server_contract"
  | "server_runtime"
  | "server_capability"
  | "agent_or_prompt"
  | "test_design"
  | "environment";

export type InsightActionTarget =
  | "investigate"
  | "mcp_server"
  | "agent_configuration"
  | "eval_case"
  | "environment";

export type InsightActionability = "informational" | "investigate" | "ready";

export type InsightFindingCategory =
  | "unknown"
  | "tool_contract"
  | "tool_runtime"
  | "capability_gap"
  | "workflow"
  | "agent_behavior"
  | "test_design"
  | "environment";

export type InsightTargetSurface =
  | "description"
  | "input_schema"
  | "output_schema"
  | "handler"
  | "server_instructions"
  | "capability";

export interface ActionableFindingEvidence {
  sessionId?: string;
  iterationId?: string;
  kind: "tool_error" | "transcript" | "feedback" | "judge" | "contrast";
  /** Already scrubbed and clipped by the producer. Still UNTRUSTED text —
   * it came from the server under test. Fence it before it reaches a model. */
  excerpt: string;
  toolName?: string;
  errorCode?: string;
}

export interface ActionableFinding {
  id: string;
  signalFingerprint: string;
  title: string;
  category: InsightFindingCategory;
  attribution: InsightAttribution;
  actionTarget: InsightActionTarget;
  actionability: InsightActionability;
  severity: "info" | "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  /** Deterministic — counts and identities, never model prose. Renders even
   * when everything model-authored is withheld. */
  observed: string;
  rootCause?: string;
  recommendation: string;
  acceptanceCriteria: string[];
  affected: { count: number; total: number; unit: "iterations" | "sessions" };
  patternSlug?: string;
  target?: {
    serverId: string;
    toolName?: string;
    surface: InsightTargetSurface;
    fieldPath?: string;
    snapshotHash: string;
    currentDefinition?: {
      description?: string;
      inputSchemaJson?: string;
      outputSchemaJson?: string;
      truncated: boolean;
    };
  };
  evidence: ActionableFindingEvidence[];
}

export interface InsightsEnvelope {
  schemaVersion: 1;
  scope:
    | { kind: "eval_run"; id: string }
    | { kind: "swarm_wave"; id: string; runId: string }
    | {
        kind: "user_testing_window";
        id: string;
        scenarioId: string;
        windowStartAt: number;
        windowEndAt: number;
      };
  status: InsightsEnvelopeStatus;
  reasonCode: string | null;
  retryable: boolean;
  error: { code: string; message: string } | null;
  generatedAt: number | null;
  updatedAt: number | null;
  summary: string | null;
  coverage: {
    unit: "iterations" | "sessions";
    analyzed: number;
    total: number;
    gradedCount?: number;
    feedbackCount?: number;
    truncated: boolean;
    lowConfidence: boolean;
  };
  findings: ActionableFinding[];
  /** Swarm only. Launch outcomes — never findings. */
  runHealth?: {
    targets: Array<{
      subjectKind: "environment" | "host";
      subjectId: string;
      subjectLabel: string;
      attempted: number;
      succeeded: number;
      failed: number;
      rateLimited: number;
    }>;
  };
  truncation: {
    truncated: boolean;
    omittedFindings: number;
    omittedEvidence: number;
    contractTruncated: boolean;
  };
}

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
