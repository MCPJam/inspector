/**
 * The eval findings view: one problem per recorded observation, with the
 * explanations and options the backend checked against it.
 *
 * Mirrors `EvalFindingsView` in mcpjam-backend `convex/lib/evalFindingsView.ts`.
 * The backend does every join; a client renders this shape alone and never
 * mixes it with `currentFindings`. Lives here because `types.ts` is past the
 * file budget; `types.ts` re-exports it.
 */
import type { PlatformActionableFinding } from "./types.js";

/** Wire version this SDK understands. */
export const PLATFORM_EVAL_FINDINGS_VIEW_VERSION = 1;

/**
 * - `fix`: the evidence shows a defect in a named server surface.
 * - `experiment`: worth trying; the cause is not proven.
 * - `investigation`: a question to answer before changing anything.
 */
export type PlatformFindingOptionKind = "fix" | "experiment" | "investigation";

export type PlatformFindingOption = {
  id: string;
  kind: PlatformFindingOptionKind;
  /** `analysis`: checked by the trace analysis. `policy`: deterministic
   * guidance from recorded facts alone, with no model call. */
  source: "analysis" | "policy";
  /** The exact iterations this option applies to. */
  iterationIds: string[];
  mechanismId?: string;
  change: string;
  rationale: string;
  surface?: NonNullable<PlatformActionableFinding["target"]>["surface"];
  target?: { serverId: string; toolName?: string };
  effort: "small" | "medium" | "large" | "unknown";
  compatibilityRisk: "low" | "medium" | "high" | "unknown";
  hypothesis?: string;
  supportsIf?: string;
  weakensIf?: string;
  verification: string;
  citations: string[];
};

export type PlatformFindingExplanation = {
  id: string;
  title: string;
  rootCause: string | null;
  attribution: string;
  iterationIds: string[];
  citations: string[];
};

export type PlatformFindingObservationOutcome = {
  state:
    | "explained"
    | "addressed"
    | "no_proposal"
    | "rejected"
    | "withheld"
    | "not_reached";
  reason?: string;
};

export type PlatformFindingProblem = {
  id: string;
  title: string;
  observed: string;
  category: PlatformActionableFinding["category"];
  severity: PlatformActionableFinding["severity"];
  affected: PlatformActionableFinding["affected"];
  iterationIds: string[];
  evidence: PlatformActionableFinding["evidence"];
  explanations: PlatformFindingExplanation[];
  coverage: {
    observed: number;
    /** Members a checked explanation covers. */
    explained: number;
    /** Members an analysis-checked option covers, explained or not. */
    addressed: number;
    /** Members with neither. */
    unresolved: number;
    unresolvedIterationIds: string[];
  };
  /** Recommended first; at most three. */
  options: PlatformFindingOption[];
  recommendedOptionId: string | null;
  recommendationReason: string | null;
  outcome: PlatformFindingObservationOutcome | null;
};

export type PlatformEvalFindingsViewStatus =
  | "deterministic"
  | "pending"
  | "failed"
  | "ready"
  | "stale"
  | "historical_unlinked";

export type PlatformEvalFindingsView = {
  /** Compare with `PLATFORM_EVAL_FINDINGS_VIEW_VERSION` before reading the
   * rest; a newer backend may send a version this SDK does not know. */
  version: number;
  status: PlatformEvalFindingsViewStatus;
  /** The MCP server improvement skill version the policy options follow. */
  policyVersion: string;
  /** The skill version the published analysis ran under, when linked. */
  analysisSkillVersion: string | null;
  problems: PlatformFindingProblem[];
  /** Analysis written before links existed, shown without coverage claims. */
  unlinkedExplanations: Array<{
    id: string;
    title: string;
    rootCause: string | null;
  }>;
};
