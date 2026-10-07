/**
 * The Muse directory-readiness result model.
 *
 * WHAT THIS IS. A local preflight against Meta's published connector
 * guidelines for Muse. Meta reviews every submission by hand — a risk
 * assessment, a per-tool review, and end-to-end QA (§6) — so nothing here
 * predicts an approval. What it can do is find, before a submitter files,
 * the things that guidelines state outright and a wire probe or the
 * submitter's own declarations can settle.
 *
 * WHAT MUSE DOES NOT SPECIFY, and why that shapes the lanes. Muse adds no MCP
 * extension: no `_meta` keys, no UI templates, no manifest. Its guidelines
 * are about BEHAVIOUR — classify every tool as Read, Write or Sensitive write;
 * never hide a payment behind a read; finish the task; don't double-charge.
 * Most of that is either declared by the submitter (and graded as such) or
 * observable only by exercising the tools against a test account, which a
 * passive readiness run must not do. So there are few wire checks, a larger
 * declared lane, and an experience-insights lane of heuristics that can never
 * fail anything.
 *
 * The algebra — what a finding is, how a lane decides, how coverage is
 * tallied — is the shared `directory-readiness` one; only Muse's lanes,
 * citations and engine version live here.
 *
 * Pure data. Safe from the browser entry.
 */

import {
  isDispositiveDirectoryFinding,
  rollUpLaneStatus as rollUpDirectoryLaneStatus,
  type DirectoryLaneCoverage,
  type DirectoryLaneStatus,
  type DirectoryReadinessFinding,
  type DirectoryReadinessLaneResult,
} from "../directory-readiness/types.js";

import type { MuseClassificationRow } from "./classification.js";
import type { MusePolicySourceRef } from "./manifest.js";

export {
  decideLaneStatus,
  enforceCapabilityGate,
  summarizeLaneCoverage,
} from "../directory-readiness/types.js";

/**
 * Stamped onto every finding. Bumped when a check's SEMANTICS change, not
 * when the SDK version does, so two grades of one target under one policy
 * snapshot stay comparable.
 */
export const MUSE_READINESS_ENGINE_VERSION = "1";

/**
 * The four lanes. Each answers a different question and fails for different
 * reasons, so they are never collapsed into one verdict.
 */
export const MUSE_READINESS_LANES = [
  /** Can Muse reach the endpoint at all, over an encrypted connection? */
  "runtime-compatibility",
  /** What the server's own tool listing settles against §3–§4. */
  "tool-policy",
  /** The §5 submission: overview, contacts, docs, credentials, test account, classifications. */
  "submission-artifacts",
  /** Heuristics over names and descriptions. Never a blocker. */
  "experience-insights",
] as const;

export type MuseReadinessLane = (typeof MUSE_READINESS_LANES)[number];

/**
 * A capability the RUNNER may or may not have. No Muse check needs one today
 * — every check is a static read or a plain request — but the gate is applied
 * anyway, so a future check that declares one cannot forget to be gated.
 */
export const MUSE_RUNNER_CAPABILITIES = [
  /** Can resolve arbitrary hostnames. */
  "dns",
] as const;

export type MuseRunnerCapability = (typeof MUSE_RUNNER_CAPABILITIES)[number];

/** One graded statement about the target. */
export type MuseReadinessFinding = DirectoryReadinessFinding<
  MuseReadinessLane,
  MusePolicySourceRef,
  MuseRunnerCapability
>;

export type MuseLaneCoverage = DirectoryLaneCoverage<MuseReadinessLane>;

export type MuseReadinessLaneResult =
  DirectoryReadinessLaneResult<MuseReadinessLane>;

export type MuseLaneStatus = DirectoryLaneStatus;

/**
 * The two questions a submitter asks, graded from one set of findings.
 *
 *   - `technical-preflight` — is the server itself fit to submit? Wire
 *     evidence only, so a run with no submission profile can answer it.
 *   - `submission-ready` — would the whole §5 submission pass the stated
 *     requirements? Needs the profile; without one it is `incomplete`, which
 *     is the truth, not a limitation to paper over.
 */
export const MUSE_READINESS_STAGES = [
  "technical-preflight",
  "submission-ready",
] as const;

export type MuseReadinessStage = (typeof MUSE_READINESS_STAGES)[number];

export const MUSE_STAGE_LANES: Readonly<
  Record<MuseReadinessStage, readonly MuseReadinessLane[]>
> = Object.freeze({
  "technical-preflight": ["runtime-compatibility", "tool-policy"],
  "submission-ready": [
    "runtime-compatibility",
    "tool-policy",
    "submission-artifacts",
  ],
});

/** How the target was reached. */
export interface MuseReadinessRunContext {
  target: string;
  capabilities: MuseRunnerCapability[];
  /** Suite results consumed as evidence, by kind. */
  evidenceSources: string[];
}

export interface MuseReadinessResult {
  /** The `submission-ready` rollup — the one verdict a surface leads with. */
  status: MuseLaneStatus;
  /** The `technical-preflight` rollup, answerable without a profile. */
  technicalStatus: MuseLaneStatus;
  /** Human-readable rollup of `status`, naming what is missing when incomplete. */
  summary: string;
  context: MuseReadinessRunContext;
  lanes: MuseReadinessLaneResult[];
  findings: MuseReadinessFinding[];
  /**
   * The suggested Read / Write / Sensitive-write class of every listed tool —
   * the table §5.6 asks submitters to put in their documentation until the
   * portal takes it directly. Empty when no complete listing was captured.
   * A SUGGESTION: Meta classifies each tool itself during review (§3.2).
   */
  classificationSheet: MuseClassificationRow[];
  /** Snapshot date of the policy corpus this run graded against (ISO date). */
  policySnapshotDate: string;
  engineVersion: string;
  startedAt: string;
  durationMs: number;
}

/** Roll one stage's lanes up. `not-ready` dominates `incomplete` dominates `ready`. */
export function rollUpMuseStage(
  lanes: readonly MuseReadinessLaneResult[],
  stage: MuseReadinessStage
): MuseLaneStatus {
  return rollUpDirectoryLaneStatus(lanes, MUSE_STAGE_LANES[stage]);
}

/** Whether a finding can DECIDE a lane. */
export function isDispositiveMuseFinding(
  finding: Pick<MuseReadinessFinding, "class">
): boolean {
  return isDispositiveDirectoryFinding(finding);
}
