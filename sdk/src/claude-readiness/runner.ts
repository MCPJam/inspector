/**
 * The composite readiness run.
 *
 * It gathers evidence once, hands it to the pure check modules, and assembles
 * five lanes plus coverage. It deliberately does NOT re-implement anything the
 * conformance suites already grade: an apps result and a protocol result are
 * INPUTS, cited by the findings that rest on them.
 *
 * WHAT `status` MEANS HERE. Only the required lanes roll up
 * (runtime-compatibility and directory-policy). Optional features can never
 * make a connector "not ready" — a missing badge is not a defect — and
 * experience insights can never do so either, because an LLM's opinion and a
 * markup heuristic are not things a submitter should be held to.
 *
 * WHY `capabilities` IS ON THE RESULT. A CLI on a laptop can open a browser
 * and complete an interactive authorization; a hosted node may refuse a raw
 * origin; a Slack bot has neither. Two surfaces grading the same target agree
 * only on their SHARED capability subset, and recording what this run could
 * actually do is what makes a coverage gap legible instead of looking like a
 * disagreement.
 */

import {
  CLAUDE_APPS_RESULT_INPUT,
  runClaudeAppsChecks,
  type ClaudeAppsEvidence,
} from "./checks/apps.js";
import {
  CLAUDE_AUTHORIZATION_REQUESTS_INPUT,
  runClaudeAuthChecks,
  type ClaudeAuthEvidence,
} from "./checks/auth.js";
import {
  runClaudeEndpointChecks,
  type ClaudeEndpointEvidence,
} from "./checks/endpoint.js";
import { runClaudeOptionalFeatureChecks } from "./checks/optional-features.js";
import {
  CLAUDE_SUBMISSION_PROFILE_INPUT,
  runClaudeSubmissionChecks,
} from "./checks/submission.js";
import {
  CLAUDE_TOOL_LISTING_INPUT,
  runClaudeToolChecks,
} from "./checks/tools.js";
import {
  gradeClaudeIntrusiveObservations,
  resolveClaudeIntrusiveMode,
  type ClaudeIntrusiveConfig,
  type ClaudeIntrusiveObservations,
} from "./intrusive.js";
import { CLAUDE_POLICY_SNAPSHOT_DATE } from "./manifest.js";
import { NOT_REQUESTED_OBSERVATIONS } from "../directory-readiness/observations.js";
import {
  mapClaudeObservationsToFindings,
  type ClaudeObservationState,
} from "./observations.js";
import {
  parseClaudeSubmissionProfile,
  type ClaudeSubmissionProfile,
} from "./submission-profile.js";
import {
  CLAUDE_READINESS_ENGINE_VERSION,
  CLAUDE_READINESS_LANES,
  CLAUDE_REQUIRED_LANES,
  decideLaneStatus,
  enforceCapabilityGate,
  rollUpLaneStatus,
  summarizeLaneCoverage,
  type ClaudeCapabilityBadge,
  type ClaudeReadinessAuthMode,
  type ClaudeReadinessFinding,
  type ClaudeReadinessLane,
  type ClaudeReadinessLaneResult,
  type ClaudeReadinessResult,
  type ClaudeRunnerCapability,
} from "./types.js";

import type { Tool } from "@modelcontextprotocol/client";

/**
 * Everything a run needs, already gathered.
 *
 * The runner takes evidence rather than a URL because the two halves have
 * different trust requirements: gathering evidence needs the pinned transport
 * and a live connection, and grading it needs neither. Splitting them means
 * the grading half is a pure function that a test can drive with a fixture and
 * a hosted surface cannot accidentally point at `169.254.169.254`.
 */
export interface ClaudeReadinessInput {
  /** The connector URL exactly as the user entered it. */
  enteredUrl: string;
  authMode: ClaudeReadinessAuthMode;
  capabilities: ClaudeRunnerCapability[];
  startedAt: string;
  evaluatedAt: string;
  durationMs: number;

  endpoint: ClaudeEndpointEvidence;
  auth: ClaudeAuthEvidence;
  apps: ClaudeAppsEvidence;
  tools?: Tool[];
  /**
   * Whether {@link tools} is the WHOLE listing.
   *
   * Separate from `tools` because the two answer different questions and only
   * one of them can be read off an array. Absent means "the caller handed
   * these over and made no claim", which the grader treats exactly as it
   * treats a complete listing.
   */
  toolListingComplete?: boolean;
  /** Why the tool listing is partial, in plain words. */
  toolListingError?: string;

  /** Raw submission profile, validated here so its issues become findings. */
  submissionProfile?: unknown;
  /** Features the submitter claimed, if any. */
  claimedFeatures?: {
    lazyAuthentication?: boolean;
    enterpriseManagedAuth?: boolean;
  };
  /** Observed auth mode, for contradicting a declaration. Never for supplying one. */
  observedAuthMode?: string;

  intrusive?: ClaudeIntrusiveConfig;
  intrusiveObservations?: ClaudeIntrusiveObservations;

  /**
   * The model-observation axis, whatever happened on it.
   *
   * PART OF THE EVIDENCE rather than an argument to the grader, so a replayed
   * evidence object regrades to the same result. It arrives already validated
   * — the grader never sees raw provider output, and could not call a provider
   * if it wanted to.
   */
  llmObservations?: ClaudeObservationState;

  /** Suite results consumed as evidence, named for the report. */
  evidenceSources?: string[];
}

/** Inputs a caller could supply to close a lane's gaps, by lane. */
function missingInputsFor(
  lane: ClaudeReadinessLane,
  findings: ClaudeReadinessFinding[],
): string[] {
  return findings
    .filter((finding) => finding.lane === lane)
    .flatMap((finding) => {
      const named = (finding.details as { missingInput?: unknown } | undefined)
        ?.missingInput;
      return typeof named === "string" ? [named] : [];
    });
}

const LANE_SUMMARIES: Record<ClaudeReadinessLane, string> = {
  "runtime-compatibility": "whether Claude can connect, authenticate and render",
  "directory-policy": "the deterministic submission and review requirements",
  "optional-features": "capability badges; nothing here can make a connector unready",
  "submission-artifacts": "listing fields, screenshots and attestations",
  "experience-insights": "heuristics and observations for a human to weigh",
};

function summarizeLane(
  lane: ClaudeReadinessLane,
  status: ClaudeReadinessLaneResult["status"],
  findings: ClaudeReadinessFinding[],
): string {
  const violations = findings.filter(
    (finding) =>
      finding.status === "violated" &&
      (finding.class === "required" || finding.class === "runtime-blocker"),
  );
  if (status === "not-ready") {
    return `${violations.length} requirement(s) unmet — ${LANE_SUMMARIES[lane]}.`;
  }
  if (status === "incomplete") {
    const unevaluated = findings.filter(
      (finding) => finding.status === "not-evaluated",
    ).length;
    return unevaluated > 0
      ? `${unevaluated} requirement(s) not evaluated — ${LANE_SUMMARIES[lane]}.`
      : `Nothing dispositive was evaluated — ${LANE_SUMMARIES[lane]}.`;
  }
  return `All applicable requirements satisfied — ${LANE_SUMMARIES[lane]}.`;
}

/**
 * Grade gathered evidence. Pure — no network, no clock, no randomness.
 *
 * The capability gate that holds every finding to the capabilities its own
 * definition declares now lives in `directory-readiness/types.ts`: the rule —
 * a missing capability downgrades a verdict to `not-evaluated`, and nothing
 * can ever upgrade one — is publisher-agnostic, and a second copy of it would
 * be a second place for a check to start publishing verdicts it had no
 * evidence for.
 */
export function gradeClaudeReadiness(
  input: ClaudeReadinessInput,
): ClaudeReadinessResult {
  const stamp = { evaluatedAt: input.evaluatedAt };

  // A malformed profile is kept and reported, not discarded: the caller did
  // the work and got it wrong, and "no input" would hide their mistake.
  // PRESENCE, not truthiness. `submissionProfile` is `unknown`, so `null`, `0`
  // and `""` are malformed INPUT rather than absent input, and routing them
  // down the "no input" branch would hide a caller's mistake behind a status
  // that reads like our limitation — the very thing the parse result exists to
  // prevent.
  const parsedProfile =
    input.submissionProfile === undefined
      ? { profile: undefined as ClaudeSubmissionProfile | undefined, issues: [] }
      : parseClaudeSubmissionProfile(input.submissionProfile);

  // ONE merged view, shared by both check modules.
  //
  // The profile is authoritative when it declares a mode, but a caller may
  // also declare one directly on the evidence — and an unconditional overwrite
  // with `parsedProfile.profile?.declaredAuthMode` erased that declaration
  // whenever no profile was supplied, which graded a preregistered-client
  // connector as a runtime failure it does not have. Handing the two modules
  // different views of the same field was the second half of the same bug.
  const authEvidence = {
    ...input.auth,
    declaredAuthMode:
      parsedProfile.profile?.declaredAuthMode ?? input.auth.declaredAuthMode,
  };
  const auth = runClaudeAuthChecks(authEvidence, stamp);
  const optional = runClaudeOptionalFeatureChecks(
    {
      auth: authEvidence,
      claimedFeatures: input.claimedFeatures,
    },
    stamp,
  );

  const intrusiveMode = resolveClaudeIntrusiveMode(input.intrusive, {
    // A run whose auth mode is `provided-token` is holding somebody's
    // credentials. The resolver is told so it can refuse to spend them.
    hasBorrowedAccessToken: input.authMode === "provided-token",
  });

  const findings: ClaudeReadinessFinding[] = enforceCapabilityGate(
    [
    ...runClaudeEndpointChecks(input.endpoint, stamp),
    ...auth.findings,
    ...runClaudeToolChecks(input.tools, stamp, {
      complete: input.toolListingComplete,
      error: input.toolListingError,
    }),
    ...runClaudeAppsChecks(input.apps, stamp),
    ...runClaudeSubmissionChecks(
      {
        profile: parsedProfile.profile,
        profileIssues: parsedProfile.issues,
        observedAuthMode: input.observedAuthMode,
      },
      stamp,
    ),
    ...optional.findings,
    ...gradeClaudeIntrusiveObservations(
      intrusiveMode,
      input.intrusiveObservations ?? {},
      stamp,
    ),
    // LAST, and inside the capability gate like everything else. The mapper
    // can only emit `heuristic`/`manual-review` findings in
    // `experience-insights`, which is not a required lane — so their position
    // in this list cannot change a verdict. They are appended rather than
    // interleaved purely so a reader scanning the findings sees the
    // deterministic inventory first.
    ...mapClaudeObservationsToFindings(input.llmObservations?.envelope, stamp),
    ],
    input.capabilities,
  );

  const badges: ClaudeCapabilityBadge[] = [...auth.badges, ...optional.badges];

  const lanes: ClaudeReadinessLaneResult[] = CLAUDE_READINESS_LANES.map((lane) => {
    const laneFindings = findings.filter((finding) => finding.lane === lane);
    const status = decideLaneStatus(laneFindings);
    return {
      lane,
      status,
      summary: summarizeLane(lane, status, laneFindings),
      coverage: summarizeLaneCoverage(
        lane,
        laneFindings,
        missingInputsFor(lane, findings),
      ),
    };
  });

  const status = rollUpLaneStatus(lanes);

  return {
    status,
    summary: buildRunSummary(status, lanes),
    context: {
      target: input.enteredUrl,
      authMode: input.authMode,
      capabilities: [...input.capabilities].sort(),
      evidenceSources: [...(input.evidenceSources ?? [])].sort(),
    },
    lanes,
    findings,
    badges,
    llmObservations: input.llmObservations ?? NOT_REQUESTED_OBSERVATIONS,
    policySnapshotDate: CLAUDE_POLICY_SNAPSHOT_DATE,
    engineVersion: CLAUDE_READINESS_ENGINE_VERSION,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
  };
}

function buildRunSummary(
  status: ClaudeReadinessResult["status"],
  lanes: ClaudeReadinessLaneResult[],
): string {
  // From the shared constant, not a restated literal: `rollUpLaneStatus`
  // decides the verdict from `CLAUDE_REQUIRED_LANES`, and a second copy here
  // would let the summary name the wrong lanes after a change to that set.
  const required = lanes.filter((lane) =>
    CLAUDE_REQUIRED_LANES.includes(lane.lane),
  );
  if (status === "not-ready") {
    const failing = required
      .filter((lane) => lane.status === "not-ready")
      .map((lane) => lane.lane);
    return `Not ready for the Claude directory: ${failing.join(" and ")} ${
      failing.length === 1 ? "has" : "have"
    } unmet requirements.`;
  }
  if (status === "incomplete") {
    const gaps = required
      .filter((lane) => lane.status === "incomplete")
      .flatMap((lane) => lane.coverage.missingInputs);
    const unique = [...new Set(gaps)];

    // GATED INPUTS ARE NOT RECOMMENDATIONS. `intrusive` registers OAuth
    // clients and spends refresh grants; it is only ever legitimate against a
    // server the submitter controls, with a dedicated test account. Listing it
    // in the same breath as "give us a tool listing" reads as advice to run
    // it — and on a connector whose ONLY gap was intrusive, that is exactly
    // what a clean report told the reader to do.
    const suggestable = unique.filter(
      (input) => !CLAUDE_GATED_INPUTS.includes(input),
    );
    const gated = unique.filter((input) =>
      CLAUDE_GATED_INPUTS.includes(input),
    );
    const gatedNote =
      gated.length > 0
        ? gated.length === 1
          ? ` The remaining gap (${gated[0]}) needs explicit opt-in on a server you control.`
          : ` The remaining gaps (${gated.join(", ")}) need explicit opt-in on a server you control.`
        : "";

    if (suggestable.length > 0) {
      return `Readiness is undetermined: some requirements were not evaluated. Supply ${suggestable.join(", ")} to close the gap.${gatedNote}`;
    }
    return gated.length > 0
      ? `Readiness is undetermined: nothing failed, and every remaining requirement needs a probe this run is not allowed to make on its own.${gatedNote}`
      : "Readiness is undetermined: some requirements could not be evaluated by this run.";
  }
  return "Every requirement this run could evaluate is satisfied.";
}

/** Named inputs a surface can offer to make a run more complete. */
export const CLAUDE_READINESS_INPUTS = {
  submissionProfile: CLAUDE_SUBMISSION_PROFILE_INPUT,
  toolListing: CLAUDE_TOOL_LISTING_INPUT,
  appsResult: CLAUDE_APPS_RESULT_INPUT,
  authorizationRequests: CLAUDE_AUTHORIZATION_REQUESTS_INPUT,
  intrusive: "intrusive",
} as const;

/**
 * Inputs a report must never simply ask for.
 *
 * Everything else on {@link CLAUDE_READINESS_INPUTS} is something a submitter
 * can hand over at no cost to anyone. These are not: supplying them means
 * running probes that mutate state on the target, so the decision belongs to
 * whoever owns that server and a summary line is the wrong place to nudge it.
 */
export const CLAUDE_GATED_INPUTS: readonly string[] = [
  CLAUDE_READINESS_INPUTS.intrusive,
];
