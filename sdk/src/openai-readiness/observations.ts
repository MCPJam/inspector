/**
 * The OpenAI experience-observation catalogue.
 *
 * WHAT A MODEL IS ALLOWED TO SAY ABOUT AN OPENAI SUBMISSION, exhaustively.
 * Every ID below is a question the deterministic checks provably cannot
 * answer — whether copy reads like a product or like a placeholder, whether
 * two tools overlap, whether a description tells the model when to reach for a
 * tool — paired with the finding it becomes.
 *
 * THE CATALOGUE IS THE SECURITY BOUNDARY. The provider returns IDs from this
 * list and prose to go with them; it cannot introduce an ID, so it cannot
 * introduce a rule. Everything that decides what a reader sees — the lane, the
 * class, the citation, the title — is here, in code, under review, and out of
 * the model's reach. A model that hallucinated `openai.tools.annotations` as a
 * violation would be refused at parse time, because that ID is not in this
 * list; and even an ID that IS in this list can only ever become a
 * `heuristic`/`manual-review` finding in `experience-insights`.
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
import { openaiPolicySource, type OpenAIPolicySourceRef } from "./manifest.js";
import {
  OPENAI_READINESS_ENGINE_VERSION,
  type OpenAIReadinessFinding,
  type OpenAIReadinessLane,
  type OpenAIRunnerCapability,
} from "./types.js";

/**
 * The observation passes defined for this publisher.
 *
 * One today. Named as a union rather than a bare string so adding a second
 * pass — a package-copy read, say — is a typed change that the backend broker,
 * the run record and this catalogue all have to agree on at once.
 */
export const OPENAI_OBSERVATION_KINDS = ["experience"] as const;

export type OpenAIObservationKind = (typeof OPENAI_OBSERVATION_KINDS)[number];

/**
 * The catalogue revision.
 *
 * Bumped whenever an ID is added, removed or changes meaning. An envelope
 * stamped with any other value is refused rather than best-efforted: the
 * version is what says which catalogue the producer was working from, and
 * grading a v2 envelope against a v1 catalogue would attribute the mismatch to
 * the model.
 */
export const OPENAI_OBSERVATION_SCHEMA_VERSION = "1";

/** Every observation ID the OpenAI pass may return. */
export const OPENAI_OBSERVATION_IDS = [
  "openai.experience.tool-descriptions-uninformative",
  "openai.experience.tool-overlap",
  "openai.experience.naming-inconsistent",
  "openai.experience.listing-copy-placeholder",
  "openai.experience.listing-copy-overpromises",
  "openai.experience.skill-overlap",
  "openai.experience.destructive-tool-underexplained",
  "openai.experience.auth-story-unclear",
] as const;

export type OpenAIObservationId = (typeof OPENAI_OBSERVATION_IDS)[number];

export const OPENAI_OBSERVATION_SCHEMA: DirectoryObservationSchema<
  OpenAIObservationKind,
  OpenAIObservationId
> = Object.freeze({
  readinessKind: "openai-directory-readiness",
  observationKinds: OPENAI_OBSERVATION_KINDS,
  knownIds: OPENAI_OBSERVATION_IDS,
  schemaVersion: OPENAI_OBSERVATION_SCHEMA_VERSION,
});

export type OpenAIExperienceObservations = DirectoryObservationEnvelope<
  OpenAIObservationKind,
  OpenAIObservationId
>;

export type OpenAIObservationState = DirectoryObservationState<
  OpenAIObservationKind,
  OpenAIObservationId
>;

const MAPPINGS: readonly DirectoryObservationMapping<
  OpenAIReadinessLane,
  OpenAIPolicySourceRef,
  OpenAIObservationId
>[] = [
  {
    id: "openai.experience.tool-descriptions-uninformative",
    title: "Tool descriptions may not tell the model when to use the tool",
    lane: "experience-insights",
    class: "heuristic",
    source: openaiPolicySource(
      "guides/optimize-metadata",
      "§Tool descriptions",
    ),
    remediation:
      "Describe when a tool should be reached for, not only what it does; the model picks tools from these sentences.",
  },
  {
    id: "openai.experience.tool-overlap",
    title: "Two or more tools may cover the same job",
    lane: "experience-insights",
    class: "heuristic",
    source: openaiPolicySource("plan/tools", "§Naming"),
    remediation:
      "Overlapping tools make selection ambiguous; consider merging them or sharpening the descriptions that separate them.",
  },
  {
    id: "openai.experience.naming-inconsistent",
    title: "Tool names may not follow one convention",
    lane: "experience-insights",
    class: "heuristic",
    source: openaiPolicySource("plan/tools", "§Naming"),
    remediation:
      "Pick one naming convention across the whole surface; mixed conventions read as two servers merged.",
  },
  {
    id: "openai.experience.listing-copy-placeholder",
    title: "Listing copy may still contain placeholder text",
    lane: "experience-insights",
    class: "manual-review",
    source: openaiPolicySource("app-guidelines", "§Listing quality"),
    remediation:
      "Review the listing fields for template text before submitting; reviewers reject placeholder copy.",
  },
  {
    id: "openai.experience.listing-copy-overpromises",
    title: "Listing copy may claim capabilities the tools do not implement",
    lane: "experience-insights",
    class: "manual-review",
    source: openaiPolicySource("app-guidelines", "§Listing quality"),
    remediation:
      "Check that every capability the listing advertises is reachable through a tool this server actually exposes.",
  },
  {
    id: "openai.experience.skill-overlap",
    title: "Two or more skills may describe the same task",
    lane: "experience-insights",
    class: "heuristic",
    source: openaiPolicySource("app-guidelines", "§Listing quality"),
    remediation:
      "Skills that overlap compete for the same trigger; separate their scopes or fold them together.",
  },
  {
    id: "openai.experience.destructive-tool-underexplained",
    title: "A destructive tool may not explain its consequences",
    lane: "experience-insights",
    class: "manual-review",
    source: openaiPolicySource("app-guidelines", "§Predictable side effects"),
    remediation:
      "Say plainly in the description what a destructive tool changes and whether it can be undone.",
  },
  {
    id: "openai.experience.auth-story-unclear",
    title: "It may not be clear to a user what they are authorizing",
    lane: "experience-insights",
    class: "manual-review",
    source: openaiPolicySource("build/auth", "§Consent"),
    remediation:
      "State which account is connected and what scope it grants, in the copy the user sees at consent time.",
  },
];

export const OPENAI_OBSERVATION_CATALOG: DirectoryObservationCatalog<
  OpenAIReadinessLane,
  OpenAIPolicySourceRef,
  OpenAIObservationId
> = Object.freeze({
  experienceLane: "experience-insights",
  engineVersion: OPENAI_READINESS_ENGINE_VERSION,
  mappings: MAPPINGS,
});

/** Validate raw provider output as this publisher's envelope, or say why not. */
export function parseOpenAIExperienceObservations(
  value: unknown,
): DirectoryObservationParseResult<OpenAIObservationKind, OpenAIObservationId> {
  return parseDirectoryObservationEnvelope(value, OPENAI_OBSERVATION_SCHEMA);
}

/**
 * Turn a validated envelope into experience-lane findings.
 *
 * Bound to this publisher's catalogue so no caller can pass a different one —
 * the catalogue is the boundary, and a boundary a caller supplies is not one.
 */
export function mapOpenAIObservationsToFindings(
  envelope: OpenAIExperienceObservations | undefined,
  stamp: DirectoryCheckStamp,
): OpenAIReadinessFinding[] {
  return mapObservationsToFindings<
    OpenAIReadinessLane,
    OpenAIPolicySourceRef,
    OpenAIRunnerCapability,
    OpenAIObservationId
  >(envelope, OPENAI_OBSERVATION_CATALOG, stamp);
}
