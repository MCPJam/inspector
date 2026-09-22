/**
 * The Claude directory-readiness result model.
 *
 * WHAT THIS IS NOT: a fifth scored MCP conformance suite. Anthropic's
 * connector-directory requirements are a PUBLISHER'S POLICY, not the MCP
 * specification, and the two answer different questions — "does this server
 * speak MCP correctly" versus "would Anthropic list it". Mixing them corrupts
 * both: a server can be flawless MCP and unlistable, or listed and sloppy. So
 * readiness reuses none of the suites' MUST/SHOULD vocabulary, carries no
 * conformance score, and is excluded from `pooledConformanceScore`. It
 * CONSUMES the protocol/oauth/apps/host-compat results as evidence rather than
 * re-running equivalent checks.
 *
 * WHAT IT IS: five independent lanes, each with its own semantics, plus
 * coverage reported separately from findings so an unevaluated requirement is
 * never mistaken for a satisfied one. `decideConformanceOutcome`'s rule —
 * "did not run" must never read as "conformed" — is the ancestor of the
 * `incomplete` status here.
 *
 * WHERE THE ALGEBRA LIVES. Everything below that is not specific to Anthropic
 * — what a finding is, how a lane decides, how coverage is tallied, how a
 * capability gate downgrades a verdict — now comes from
 * `../directory-readiness/`, which the OpenAI plugin-directory product shares.
 * The names, signatures and shapes exported here are UNCHANGED: this module is
 * the Anthropic-flavoured face of that algebra, and every alias below is
 * structurally identical to the interface it replaced, so no consumer and no
 * test had to move.
 *
 * Pure data: no MCP client, no transport, no Node built-ins. Safe from the
 * browser entry.
 */

import {
  DIRECTORY_EVIDENCE_PROVENANCE,
  DIRECTORY_FINDING_CLASSES,
  DIRECTORY_INTRUSIVENESS_LEVELS,
  isDispositiveDirectoryFinding,
  rollUpLaneStatus as rollUpDirectoryLaneStatus,
  type DirectoryCapabilityBadge,
  type DirectoryEvidenceProvenance,
  type DirectoryFindingClass,
  type DirectoryFindingStatus,
  type DirectoryIntrusiveness,
  type DirectoryLaneCoverage,
  type DirectoryLaneStatus,
  type DirectoryReadinessFinding,
  type DirectoryReadinessLaneResult,
} from "../directory-readiness/types.js";

import type { DirectoryObservationState } from "../directory-readiness/observations.js";
// TYPE-ONLY, and that is what makes it safe: `observations.ts` imports this
// module, so a value import would be a cycle. Erasing at compile time, the
// narrowing survives and the cycle does not exist at runtime. Without it the
// public result widens both parameters to `string` and a consumer cannot
// switch exhaustively over an observation id.
import type {
  ClaudeObservationId,
  ClaudeObservationKind,
} from "./observations.js";

import type { ClaudePolicySourceRef } from "./manifest.js";

export {
  decideLaneStatus,
  enforceCapabilityGate,
  summarizeLaneCoverage,
} from "../directory-readiness/types.js";

/**
 * The engine that produced a finding, stamped onto every one of them.
 *
 * Bumped when a check's SEMANTICS change, not when the SDK version does: two
 * grades of the same target under the same policy snapshot should be
 * comparable, and tying this to the package version would make every unrelated
 * release look like a re-audit.
 */
export const CLAUDE_READINESS_ENGINE_VERSION = "1";

/**
 * The five lanes. Each answers a different question and fails for different
 * reasons, so they are never collapsed into one verdict.
 */
export const CLAUDE_READINESS_LANES = [
  /** Will Claude be able to connect, authenticate, and render at all? */
  "runtime-compatibility",
  /** Deterministic submission/review requirements Anthropic states outright. */
  "directory-policy",
  /** Capability badges: lazy auth, enterprise-managed auth, auth strategy. */
  "optional-features",
  /** Listing fields, screenshots, attestations. Needs declared input. */
  "submission-artifacts",
  /** Heuristics, browser observations, LLM/manual review. Never a blocker. */
  "experience-insights",
] as const;

export type ClaudeReadinessLane = (typeof CLAUDE_READINESS_LANES)[number];

/**
 * What KIND of statement a finding is making. Deliberately not `MUST`/`SHOULD`
 * — those belong to the MCP spec, and reusing them here would let a policy
 * preference read as a protocol violation.
 *
 *   - `required` — Anthropic states it as a submission/review requirement.
 *     A violation means the connector will be rejected or delisted.
 *   - `runtime-blocker` — Claude cannot complete the flow at all. Distinct
 *     from `required` because it fails before policy is even reached: a broken
 *     first `authorization_servers` entry is not a paperwork problem.
 *   - `recommended` — stated guidance whose violation is not disqualifying.
 *   - `experimental-feature` — a capability badge, not a grade. Absence is
 *     never a defect.
 *   - `manual-review` — a human has to look. Quality, ownership, and
 *     credential validity cannot be decided from the wire.
 *   - `heuristic` — a signal, not a verdict. Belongs to experience-insights
 *     and may be confirmed by an LLM or a person; never fails a lane.
 */
export const CLAUDE_FINDING_CLASSES = DIRECTORY_FINDING_CLASSES;

export type ClaudeFindingClass = DirectoryFindingClass;

/**
 * The status of a lane whose findings are dispositive.
 *
 *   - `ready` — every applicable requirement was evaluated and satisfied.
 *   - `not-ready` — at least one applicable requirement was violated.
 *   - `incomplete` — nothing was violated, but something the lane needs was
 *     never evaluated. `missingInputs` says what the caller must supply.
 *
 * `incomplete` is load-bearing and self-describing: a wire-only run cannot see
 * a screenshot, and reporting `ready` for a lane it could not evaluate would
 * be the single most damaging thing this product could do.
 */
export type ClaudeLaneStatus = DirectoryLaneStatus;

/**
 * How a finding was established. A grade that cannot say where its evidence
 * came from is not auditable, and provenance is what stops a static lint from
 * being read as an observed runtime fact.
 *
 *   - `wire` — observed in an HTTP/MCP exchange this run performed.
 *   - `browser` — observed in a rendered widget/browser harness.
 *   - `static` — read out of a document, manifest, or schema without dialing.
 *   - `declared` — asserted by the submitter in a submission profile. Never
 *     independently verified by this run.
 *   - `manual` — recorded by a person.
 */
export const CLAUDE_EVIDENCE_PROVENANCE = DIRECTORY_EVIDENCE_PROVENANCE;

export type ClaudeEvidenceProvenance = DirectoryEvidenceProvenance;

/**
 * How much a check DOES to the target.
 *
 *   - `passive` — no request attributable to this check.
 *   - `read-only` — requests with no persistent effect on the target.
 *   - `side-effecting` — registers a client, spends a grant, mutates state.
 *     Only ever reached through the explicit intrusive opt-in.
 */
export const CLAUDE_INTRUSIVENESS_LEVELS = DIRECTORY_INTRUSIVENESS_LEVELS;

export type ClaudeIntrusiveness = DirectoryIntrusiveness;

/**
 * How the run authenticated. Recorded on the run so `incomplete` explains
 * itself: a headless run genuinely cannot complete an interactive consent
 * screen, and that is a property of the run, not a defect in the server.
 */
export type ClaudeReadinessAuthMode =
  | "headless"
  | "interactive"
  | "provided-token";

/**
 * A capability the RUNNER may or may not have. Surfaces differ — a CLI on a
 * laptop can resolve DNS and open a browser; a hosted node may refuse raw
 * origins; a Slack bot has neither — so two surfaces grading the same target
 * agree only on their SHARED capability subset. Asserting check-for-check
 * equality across surfaces would be asserting something false.
 */
export const CLAUDE_RUNNER_CAPABILITIES = [
  /** Can resolve arbitrary hostnames. */
  "dns",
  /** Can send requests with an arbitrary `Origin`, including a raw one. */
  "raw-origin",
  /** Can complete an interactive OAuth authorization. */
  "interactive-oauth",
  /** Can render a widget in a real browser engine. */
  "browser",
  /** Can render in WebKit specifically, which is what Claude's apps use. */
  "webkit-browser",
  /** Explicit opt-in to side-effecting probes is present AND configured. */
  "intrusive-probes",
] as const;

export type ClaudeRunnerCapability =
  (typeof CLAUDE_RUNNER_CAPABILITIES)[number];

/** A finding's verdict. `informational` carries no pass/fail meaning at all. */
export type ClaudeFindingStatus = DirectoryFindingStatus;

/**
 * One graded statement about the target.
 *
 * Every field below the verdict exists so the finding survives contact with
 * time: Anthropic's docs change, and a grade that cannot say WHICH revision it
 * was made against becomes silently wrong rather than visibly stale.
 */
export type ClaudeReadinessFinding = DirectoryReadinessFinding<
  ClaudeReadinessLane,
  ClaudePolicySourceRef,
  ClaudeRunnerCapability
>;

/**
 * What a lane managed to look at, reported SEPARATELY from what it found.
 *
 * A lane with zero violations and zero evaluated checks is not a pass, and the
 * only way to keep those apart is to publish the denominator.
 */
export type ClaudeLaneCoverage = DirectoryLaneCoverage<ClaudeReadinessLane>;

export type ClaudeReadinessLaneResult =
  DirectoryReadinessLaneResult<ClaudeReadinessLane>;

/**
 * A capability badge. Present in the optional-features lane only, and never a
 * defect when absent — that is the whole difference between a badge and a
 * requirement.
 */
export type ClaudeCapabilityBadge = DirectoryCapabilityBadge;

/** How the target was reached and what the runner could do while it was there. */
export interface ClaudeReadinessRunContext {
  target: string;
  authMode: ClaudeReadinessAuthMode;
  capabilities: ClaudeRunnerCapability[];
  /** Suite results consumed as evidence, by kind. */
  evidenceSources: string[];
}

export interface ClaudeReadinessResult {
  /**
   * The one dispositive status: the REQUIRED lanes' rollup
   * (runtime-compatibility + directory-policy). Optional features and
   * experience insights can never move it, by construction.
   */
  status: ClaudeLaneStatus;
  /** Human-readable rollup of `status`, naming what is missing when incomplete. */
  summary: string;
  context: ClaudeReadinessRunContext;
  lanes: ClaudeReadinessLaneResult[];
  findings: ClaudeReadinessFinding[];
  badges: ClaudeCapabilityBadge[];
  /**
   * The model-observation axis, ALWAYS present.
   *
   * Independent of {@link status} on purpose. A run whose required lanes
   * graded cleanly is `ready` even when the observation call was refused for
   * credit — a payment problem belongs to the account, not to the connector
   * under grading — and a run that could not afford to look must never render
   * as one that looked and found nothing. Optional in the TYPE only so
   * evidence gathered before this field existed still parses; the grader
   * always fills it, with `not-requested` when nobody asked.
   */
  llmObservations?: DirectoryObservationState<
    ClaudeObservationKind,
    ClaudeObservationId
  >;
  /** Snapshot date of the policy corpus this run graded against (ISO date). */
  policySnapshotDate: string;
  engineVersion: string;
  startedAt: string;
  durationMs: number;
}

/** Lanes whose status rolls up into {@link ClaudeReadinessResult.status}. */
export const CLAUDE_REQUIRED_LANES: readonly ClaudeReadinessLane[] = [
  "runtime-compatibility",
  "directory-policy",
];

/**
 * Roll the required lanes up.
 *
 * `not-ready` dominates `incomplete` dominates `ready`. The ordering is the
 * point: a run that found a violation AND could not evaluate something else is
 * `not-ready` — the violation is established, and softening it to `incomplete`
 * would let an unrelated coverage gap launder a real failure.
 *
 * Anthropic has exactly ONE required-lane set, so this keeps its single-argument
 * shape and closes over {@link CLAUDE_REQUIRED_LANES}. The shared rollup takes
 * the lane set as an argument because OpenAI's product grades two of them —
 * a technical preflight and a full submission-ready verdict — from one set of
 * findings.
 */
export function rollUpLaneStatus(
  lanes: ClaudeReadinessLaneResult[],
): ClaudeLaneStatus {
  return rollUpDirectoryLaneStatus(lanes, CLAUDE_REQUIRED_LANES);
}

/**
 * Whether a finding can DECIDE a lane.
 *
 * Exported because the report adapter needs the same answer: a finding that
 * decides a lane must render as a testcase, and one that does not must render
 * as an advisory. Two copies of this predicate could disagree, and then a
 * report would contradict the verdict it is reporting.
 */
export function isDispositiveClaudeFinding(
  finding: Pick<ClaudeReadinessFinding, "class">,
): boolean {
  return isDispositiveDirectoryFinding(finding);
}
