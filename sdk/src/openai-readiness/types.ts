/**
 * The OpenAI plugin-directory readiness result model.
 *
 * WHAT THIS IS. A LOCAL PREFLIGHT that implements OpenAI's documented rules for
 * the ChatGPT/Codex plugin directory. The submission portal remains the
 * authoritative validator; nothing here predicts its verdict, and the product
 * would be dishonest if it claimed to. What it can do is find, before anyone
 * uploads anything, the problems that are decidable from the package, the wire
 * and a declared submission profile.
 *
 * WHAT IT IS NOT. A conformance suite. The MCP specification and OpenAI's
 * listing policy answer different questions — "does this server speak MCP
 * correctly" versus "would OpenAI list it" — so this carries no conformance
 * score, is excluded from `pooledConformanceScore`, and CONSUMES the
 * protocol/oauth/apps suite results as evidence rather than re-running them.
 *
 * THE THREE STRATA, kept visibly apart because collapsing them is what turns a
 * readiness report into noise:
 *
 *   - `runtime-blocker` — the protocol exchange fails; ChatGPT cannot use this
 *     at all, before policy is even reached.
 *   - `required` — OpenAI states it as a host or submission requirement.
 *   - `manual-review` / `heuristic` — a human has to look, or a signal worth
 *     surfacing. NEVER dispositive, however alarming it reads.
 *
 * Pure data: no MCP client, no transport, no Node built-ins. Safe from the
 * browser entry.
 */

import type {
  DirectoryCapabilityBadge,
  DirectoryLaneCoverage,
  DirectoryLaneStatus,
  DirectoryReadinessFinding,
  DirectoryReadinessLaneResult,
} from "../directory-readiness/types.js";

import type { DirectoryObservationState } from "../directory-readiness/observations.js";
// TYPE-ONLY: `observations.ts` imports this module, so a value import would be
// a cycle. The narrowing survives compilation and the cycle does not exist at
// runtime — without it the public result widens both parameters to `string`
// and a consumer cannot switch exhaustively over an observation id.
import type {
  OpenAIObservationId,
  OpenAIObservationKind,
} from "./observations.js";

import type { OpenAIPolicySourceRef } from "./manifest.js";

/**
 * The engine that produced a finding, stamped onto every one of them.
 *
 * Versioned INDEPENDENTLY of `CLAUDE_READINESS_ENGINE_VERSION`: the two check
 * inventories move for unrelated reasons, and a shared counter would make every
 * Anthropic change look like an OpenAI re-audit.
 */
export const OPENAI_READINESS_ENGINE_VERSION = "1";

/**
 * The seven lanes. Each answers a different question and fails for different
 * reasons, so they are never collapsed into one verdict.
 */
export const OPENAI_READINESS_LANES = [
  /** Can ChatGPT connect to, authenticate with, and render this server? */
  "runtime-compatibility",
  /** Deterministic stated requirements: guidelines, auth, annotations. */
  "directory-policy",
  /** The archive the portal validates, in the shapes that upload one. */
  "plugin-package",
  /** Draft-vs-published compatibility. Updates only; first submissions skip it. */
  "release-contract",
  /** Badges: imported skills, UI templates, CIMD, checkout specs. */
  "optional-features",
  /**
   * Listing form, tests, demo access, release notes, attestations, domain
   * verification, scan currency, geography. Conditional but DISPOSITIVE — see
   * the stage note below.
   */
  "submission-artifacts",
  /** Heuristics and manual review. Never a blocker. */
  "experience-insights",
] as const;

export type OpenAIReadinessLane = (typeof OPENAI_READINESS_LANES)[number];

/**
 * The four public submission shapes.
 *
 * A REQUIRED grading input, never inferred from which inputs a run happens to
 * hold. Inference reads the absence of a bundle as "MCP-only" and then reports
 * the package lane `not-applicable` for a submitter who simply forgot to attach
 * their ZIP — turning a missing input into a clean bill of health, which is the
 * exact failure `incomplete` exists to prevent. Naming the mode makes a missing
 * input a GAP (`not-evaluated`, with the input named) and a genuinely absent
 * surface a `not-applicable`.
 *
 *   - `skills-only` — a ZIP of skills, no server.
 *   - `mcp-only` — an endpoint, no ZIP.
 *   - `mcp-imported-skills` — an endpoint whose skills are read from the
 *     `io.modelcontextprotocol/skills` extension at scan time, no ZIP.
 *   - `mcp-uploaded-skills` — an endpoint plus a ZIP of skills.
 */
export const OPENAI_SUBMISSION_MODES = [
  "skills-only",
  "mcp-only",
  "mcp-imported-skills",
  "mcp-uploaded-skills",
] as const;

export type OpenAISubmissionMode = (typeof OPENAI_SUBMISSION_MODES)[number];

/** Inputs a caller can supply, named so a coverage gap says how to close it. */
export const OPENAI_READINESS_INPUTS = {
  serverUrl: "serverUrl",
  pluginBundle: "pluginBundle",
  submissionProfile: "submissionProfile",
  draftSnapshot: "draftSnapshot",
  publishedSnapshot: "publishedSnapshot",
  toolListing: "toolListing",
  importedSkills: "importedSkills",
} as const;

export type OpenAIReadinessInputName =
  (typeof OPENAI_READINESS_INPUTS)[keyof typeof OPENAI_READINESS_INPUTS];

/**
 * What each mode's submission actually CONTAINS.
 *
 * The applicability matrix is derived from this rather than written out per
 * lane, so a fifth mode is one entry here instead of seven booleans that can
 * disagree with each other.
 */
export const OPENAI_SUBMISSION_MODE_SHAPES: Readonly<
  Record<
    OpenAISubmissionMode,
    {
      hasMcpServer: boolean;
      hasUploadedPackage: boolean;
      hasImportedSkills: boolean;
      /** Inputs without which this mode cannot be graded. */
      requiredInputs: readonly OpenAIReadinessInputName[];
      summary: string;
    }
  >
> = Object.freeze({
  "skills-only": {
    hasMcpServer: false,
    hasUploadedPackage: true,
    hasImportedSkills: false,
    requiredInputs: [OPENAI_READINESS_INPUTS.pluginBundle],
    summary: "a skills package with no MCP server",
  },
  "mcp-only": {
    hasMcpServer: true,
    hasUploadedPackage: false,
    hasImportedSkills: false,
    requiredInputs: [OPENAI_READINESS_INPUTS.serverUrl],
    summary: "an MCP endpoint with no uploaded package",
  },
  "mcp-imported-skills": {
    hasMcpServer: true,
    hasUploadedPackage: false,
    hasImportedSkills: true,
    requiredInputs: [
      OPENAI_READINESS_INPUTS.serverUrl,
      OPENAI_READINESS_INPUTS.importedSkills,
    ],
    summary: "an MCP endpoint whose skills are imported at scan time",
  },
  "mcp-uploaded-skills": {
    hasMcpServer: true,
    hasUploadedPackage: true,
    hasImportedSkills: false,
    requiredInputs: [
      OPENAI_READINESS_INPUTS.serverUrl,
      OPENAI_READINESS_INPUTS.pluginBundle,
    ],
    summary: "an MCP endpoint plus an uploaded skills package",
  },
});

/**
 * Whether a lane can apply at all in this mode.
 *
 * `false` here means `not-applicable` — nothing was left unverified — and is
 * emphatically NOT `incomplete`. A skills-only submission has no endpoint to
 * grade, and reporting that as a coverage gap would send a submitter looking
 * for an input their submission shape does not have.
 */
export function isLaneApplicableInMode(
  lane: OpenAIReadinessLane,
  mode: OpenAISubmissionMode,
): boolean {
  const shape = OPENAI_SUBMISSION_MODE_SHAPES[mode];
  switch (lane) {
    case "runtime-compatibility":
      return shape.hasMcpServer;
    case "plugin-package":
      return shape.hasUploadedPackage;
    // The rest apply in every shape: a skills-only package still has listing
    // fields, still has attestations, and still has to satisfy the guidelines.
    default:
      return true;
  }
}

/**
 * The two staged rollups.
 *
 * WHY TWO. Submission artifacts — tests, attestations, release notes, domain
 * verification, scan currency — are DISPOSITIVE: a submission missing them is
 * not ready, and grading them as non-blocking suggestions would misrepresent
 * the directory. But a submitter running a quick technical check on their
 * server has supplied no submission profile, and failing that run on paperwork
 * they have not filled in yet would make the quick check useless.
 *
 * Two stages resolve it honestly instead of picking one and being wrong half
 * the time: a run with no profile is `ready` at `technical-preflight` and
 * `incomplete` at `submission-ready`, and both statements are true.
 *
 *   - `technical-preflight` — is the thing technically fit to submit?
 *   - `submission-ready` — is the submission complete? This is the headline.
 */
export const OPENAI_READINESS_STAGES = [
  "technical-preflight",
  "submission-ready",
] as const;

export type OpenAIReadinessStage = (typeof OPENAI_READINESS_STAGES)[number];

/** The lanes each stage rolls up, before mode applicability is applied. */
export const OPENAI_STAGE_LANES: Readonly<
  Record<OpenAIReadinessStage, readonly OpenAIReadinessLane[]>
> = Object.freeze({
  "technical-preflight": [
    "runtime-compatibility",
    "directory-policy",
    "plugin-package",
  ],
  "submission-ready": [
    "runtime-compatibility",
    "directory-policy",
    "plugin-package",
    "submission-artifacts",
    "release-contract",
  ],
});

/** The stage whose status becomes {@link OpenAIReadinessResult.status}. */
export const OPENAI_HEADLINE_STAGE: OpenAIReadinessStage = "submission-ready";

/**
 * The lanes a stage actually rolls up for THIS run.
 *
 * Two things narrow the static set. A lane the mode excludes is dropped —
 * rolling up a `not-applicable` lane would make every skills-only submission
 * permanently incomplete on an endpoint it does not have. And
 * `release-contract` is dropped when there is no published version to compare
 * against, because a first submission has no contract to break.
 */
export function stageLanesFor(
  stage: OpenAIReadinessStage,
  mode: OpenAISubmissionMode,
  options: { hasPublishedVersion: boolean },
): OpenAIReadinessLane[] {
  return OPENAI_STAGE_LANES[stage].filter((lane) => {
    if (!isLaneApplicableInMode(lane, mode)) return false;
    if (lane === "release-contract") return options.hasPublishedVersion;
    return true;
  });
}

/**
 * A capability the RUNNER may or may not have.
 *
 * Anthropic's set minus `webkit-browser`: Claude's apps render in WebKit
 * specifically and a check there legitimately asks for it, while ChatGPT's do
 * not, so carrying the capability would let an OpenAI check request something
 * that means nothing for its host.
 */
export const OPENAI_RUNNER_CAPABILITIES = [
  /** Can resolve arbitrary hostnames. */
  "dns",
  /** Can send requests with an arbitrary `Origin`, including a raw one. */
  "raw-origin",
  /** Can complete an interactive OAuth authorization. */
  "interactive-oauth",
  /** Can render a UI template in a real browser engine. */
  "browser",
  /** Explicit opt-in to side-effecting probes is present AND configured. */
  "intrusive-probes",
] as const;

export type OpenAIRunnerCapability =
  (typeof OPENAI_RUNNER_CAPABILITIES)[number];

/** How the run authenticated, recorded so `incomplete` explains itself. */
export type OpenAIReadinessAuthMode =
  | "headless"
  | "interactive"
  | "provided-token";

export type OpenAIReadinessFinding = DirectoryReadinessFinding<
  OpenAIReadinessLane,
  OpenAIPolicySourceRef,
  OpenAIRunnerCapability
>;

export type OpenAILaneCoverage = DirectoryLaneCoverage<OpenAIReadinessLane>;

export type OpenAIReadinessLaneResult =
  DirectoryReadinessLaneResult<OpenAIReadinessLane>;

export type OpenAILaneStatus = DirectoryLaneStatus;

export type OpenAICapabilityBadge = DirectoryCapabilityBadge;

/** One stage's verdict, and the lanes it was computed from. */
export interface OpenAIReadinessStageResult {
  stage: OpenAIReadinessStage;
  status: OpenAILaneStatus;
  /** Naming the lanes makes a stage's verdict reproducible by hand. */
  lanes: OpenAIReadinessLane[];
  summary: string;
}

/** How the target was reached and what the runner could do while it was there. */
export interface OpenAIReadinessRunContext {
  /** The endpoint or package the run graded, as the caller named it. */
  target: string;
  mode: OpenAISubmissionMode;
  authMode: OpenAIReadinessAuthMode;
  capabilities: OpenAIRunnerCapability[];
  /** Suite results consumed as evidence, by kind. */
  evidenceSources: string[];
}

export interface OpenAIReadinessResult {
  /**
   * Discriminator, present so a consumer never has to guess.
   *
   * Claude's readiness result carries lanes, findings and badges too, so its
   * structural shape matches this one exactly. Without an explicit kind, a
   * report adapter switching on shape would publish an OpenAI grade under
   * Anthropic's name.
   */
  readinessKind: "openai-directory-readiness";
  /**
   * The headline verdict: the {@link OPENAI_HEADLINE_STAGE} stage's status.
   *
   * Deliberately the STRICTER of the two stages. A submitter asking "am I
   * ready" is asking about the submission, and answering with the technical
   * preflight would report `ready` for a submission with no attestations.
   */
  status: OpenAILaneStatus;
  /** Human-readable rollup, naming what is missing when incomplete. */
  summary: string;
  context: OpenAIReadinessRunContext;
  /** Every stage, so the narrower verdict stays visible next to the headline. */
  stages: OpenAIReadinessStageResult[];
  lanes: OpenAIReadinessLaneResult[];
  findings: OpenAIReadinessFinding[];
  badges: OpenAICapabilityBadge[];
  /**
   * The model-observation axis, ALWAYS present.
   *
   * Independent of {@link status} on purpose. A run whose deterministic lanes
   * graded cleanly is `ready` even when the observation call was refused for
   * credit — a payment problem belongs to the account, not to the server under
   * grading — and a run that could not afford to look must never render as one
   * that looked and found nothing. Optional in the TYPE only so evidence
   * gathered before this field existed still parses; the grader always fills
   * it, with `not-requested` when nobody asked.
   */
  llmObservations?: DirectoryObservationState<
    OpenAIObservationKind,
    OpenAIObservationId
  >;
  /** Snapshot date of the policy corpus this run graded against (ISO date). */
  policySnapshotDate: string;
  engineVersion: string;
  startedAt: string;
  durationMs: number;
}

/** Narrow an unknown result to this product's. Used by the report adapter. */
export function isOpenAIReadinessResult(
  value: unknown,
): value is OpenAIReadinessResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readinessKind?: unknown }).readinessKind ===
      "openai-directory-readiness"
  );
}
