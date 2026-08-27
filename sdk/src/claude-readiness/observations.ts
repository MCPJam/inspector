/**
 * The Claude experience-observation catalogue.
 *
 * The Anthropic twin of `openai-readiness/observations`, and deliberately a
 * SEPARATE catalogue rather than a shared one with two lane maps. The two
 * directories review for different things — Anthropic's criteria dwell on
 * connector trust and what a user is consenting to, OpenAI's on tool selection
 * and listing copy — and a shared ID list would let a check cite the wrong
 * publisher's review criteria while typechecking perfectly.
 *
 * The invariants are the shared ones and hold identically here: the model
 * selects from a frozen list, contributes prose and a confidence and nothing
 * else, and every finding it produces lands in `experience-insights` as
 * `heuristic` or `manual-review` — a lane no rollup consults for a verdict.
 *
 * Pure data. No transport, no provider SDK.
 */

import {
  mapObservationsToFindings,
  parseDirectoryObservationEnvelope,
  type DirectoryObservationCatalog,
  type DirectoryObservationEnvelope,
  type DirectoryObservationMapping,
  type DirectoryObservationParseResult,
  type DirectoryObservationSchema,
  type DirectoryObservationState,
} from "../directory-readiness/observations.js";
import type { DirectoryCheckStamp } from "../directory-readiness/helpers.js";
import { claudePolicySource, type ClaudePolicySourceRef } from "./manifest.js";
import {
  CLAUDE_READINESS_ENGINE_VERSION,
  type ClaudeReadinessFinding,
  type ClaudeReadinessLane,
  type ClaudeRunnerCapability,
} from "./types.js";

export const CLAUDE_OBSERVATION_KINDS = ["experience"] as const;

export type ClaudeObservationKind = (typeof CLAUDE_OBSERVATION_KINDS)[number];

/** See the OpenAI twin: an envelope stamped otherwise is refused, not adapted. */
export const CLAUDE_OBSERVATION_SCHEMA_VERSION = "1";

/** Every observation ID the Claude pass may return. */
export const CLAUDE_OBSERVATION_IDS = [
  "claude.experience.tool-descriptions-uninformative",
  "claude.experience.tool-overlap",
  "claude.experience.connector-purpose-unclear",
  "claude.experience.consent-scope-unclear",
  "claude.experience.listing-copy-placeholder",
  "claude.experience.destructive-tool-underexplained",
  "claude.experience.app-copy-mismatched",
] as const;

export type ClaudeObservationId = (typeof CLAUDE_OBSERVATION_IDS)[number];

export const CLAUDE_OBSERVATION_SCHEMA: DirectoryObservationSchema<
  ClaudeObservationKind,
  ClaudeObservationId
> = Object.freeze({
  readinessKind: "claude-directory-readiness",
  observationKinds: CLAUDE_OBSERVATION_KINDS,
  knownIds: CLAUDE_OBSERVATION_IDS,
  schemaVersion: CLAUDE_OBSERVATION_SCHEMA_VERSION,
});

export type ClaudeExperienceObservations = DirectoryObservationEnvelope<
  ClaudeObservationKind,
  ClaudeObservationId
>;

export type ClaudeObservationState = DirectoryObservationState<
  ClaudeObservationKind,
  ClaudeObservationId
>;

const MAPPINGS: readonly DirectoryObservationMapping<
  ClaudeReadinessLane,
  ClaudePolicySourceRef,
  ClaudeObservationId
>[] = [
  {
    id: "claude.experience.tool-descriptions-uninformative",
    title: "Tool descriptions may not tell Claude when to use the tool",
    lane: "experience-insights",
    class: "heuristic",
    source: claudePolicySource("review-criteria", "§Tool quality"),
    remediation:
      "Describe when a tool should be reached for, not only what it does; Claude picks tools from these sentences.",
  },
  {
    id: "claude.experience.tool-overlap",
    title: "Two or more tools may cover the same job",
    lane: "experience-insights",
    class: "heuristic",
    source: claudePolicySource("review-criteria", "§Tool quality"),
    remediation:
      "Overlapping tools make selection ambiguous; consider merging them or sharpening what separates them.",
  },
  {
    id: "claude.experience.connector-purpose-unclear",
    title: "What this connector is for may not be clear from its surface",
    lane: "experience-insights",
    class: "manual-review",
    source: claudePolicySource("review-criteria", "§Usefulness"),
    remediation:
      "A reviewer should be able to say what the connector is for from the listing and the tool names alone.",
  },
  {
    id: "claude.experience.consent-scope-unclear",
    title: "It may not be clear to a user what they are authorizing",
    lane: "experience-insights",
    class: "manual-review",
    source: claudePolicySource("authentication", "§Consent"),
    remediation:
      "State which account is connected and what scope it grants, in the copy the user sees at consent time.",
  },
  {
    id: "claude.experience.listing-copy-placeholder",
    title: "Listing copy may still contain placeholder text",
    lane: "experience-insights",
    class: "manual-review",
    source: claudePolicySource("submission", "§Listing"),
    remediation:
      "Review the listing fields for template text before submitting; reviewers reject placeholder copy.",
  },
  {
    id: "claude.experience.destructive-tool-underexplained",
    title: "A destructive tool may not explain its consequences",
    lane: "experience-insights",
    class: "manual-review",
    source: claudePolicySource("review-criteria", "§Safety"),
    remediation:
      "Say plainly in the description what a destructive tool changes and whether it can be undone.",
  },
  {
    id: "claude.experience.app-copy-mismatched",
    title: "An app's rendered copy may not match what its tool returns",
    lane: "experience-insights",
    class: "heuristic",
    source: claudePolicySource("mcp-apps/design-guidelines", "§Content"),
    remediation:
      "A widget that says something different from the tool's text response leaves the model and the user disagreeing.",
  },
];

export const CLAUDE_OBSERVATION_CATALOG: DirectoryObservationCatalog<
  ClaudeReadinessLane,
  ClaudePolicySourceRef,
  ClaudeObservationId
> = Object.freeze({
  experienceLane: "experience-insights",
  engineVersion: CLAUDE_READINESS_ENGINE_VERSION,
  mappings: MAPPINGS,
});

/** Validate raw provider output as this publisher's envelope, or say why not. */
export function parseClaudeExperienceObservations(
  value: unknown,
): DirectoryObservationParseResult<ClaudeObservationKind, ClaudeObservationId> {
  return parseDirectoryObservationEnvelope(value, CLAUDE_OBSERVATION_SCHEMA);
}

/** Turn a validated envelope into experience-lane findings. */
export function mapClaudeObservationsToFindings(
  envelope: ClaudeExperienceObservations | undefined,
  stamp: DirectoryCheckStamp,
): ClaudeReadinessFinding[] {
  return mapObservationsToFindings<
    ClaudeReadinessLane,
    ClaudePolicySourceRef,
    ClaudeRunnerCapability,
    ClaudeObservationId
  >(envelope, CLAUDE_OBSERVATION_CATALOG, stamp);
}
