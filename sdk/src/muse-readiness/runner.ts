/**
 * The Muse readiness grader.
 *
 * Takes gathered evidence and is pure — same evidence in, same result out —
 * so a test can drive it from a fixture and a hosted surface can grade on one
 * machine what it gathered on another. The gatherer (`gather.ts`) is the only
 * Muse code that dials anything.
 *
 * TWO VERDICTS FROM ONE SET OF FINDINGS. `technicalStatus` rolls up the lanes
 * the wire can settle (runtime-compatibility, tool-policy) and is answerable
 * with no profile at all. `status` adds the submission lane, and stays
 * `incomplete` until a profile is supplied — which is the truth: Muse's
 * §5 requirements are things a submitter declares, and no probe can see them.
 * Experience-insights never rolls up into either.
 */

import {
  runMuseEndpointChecks,
  type MuseEndpointEvidence,
} from "./checks/endpoint.js";
import { MUSE_READINESS_INPUTS } from "./checks/helpers.js";
import { runMuseSubmissionChecks } from "./checks/submission.js";
import { runMuseToolChecks } from "./checks/tools.js";
import type { MuseToolEvidence } from "./classification.js";
import { MUSE_POLICY_SNAPSHOT_DATE } from "./manifest.js";
import {
  parseMuseSubmissionProfile,
  type MuseSubmissionProfile,
} from "./submission-profile.js";
import {
  MUSE_READINESS_ENGINE_VERSION,
  MUSE_READINESS_LANES,
  MUSE_STAGE_LANES,
  decideLaneStatus,
  enforceCapabilityGate,
  rollUpMuseStage,
  summarizeLaneCoverage,
  type MuseReadinessFinding,
  type MuseReadinessLane,
  type MuseReadinessLaneResult,
  type MuseReadinessResult,
  type MuseRunnerCapability,
} from "./types.js";

/** Everything a grade needs, already gathered. Survives `JSON.stringify`. */
export interface MuseReadinessInput {
  /** The connector URL exactly as the user entered it. */
  enteredUrl: string;
  capabilities: MuseRunnerCapability[];
  startedAt: string;
  evaluatedAt: string;
  durationMs: number;

  endpoint: MuseEndpointEvidence;
  tools?: MuseToolEvidence[];
  /**
   * Whether {@link tools} is the WHOLE listing. Absent means the caller
   * handed the listing over and made no claim, which grades as complete.
   */
  toolListingComplete?: boolean;
  /** Why the tool listing is partial, in plain words. */
  toolListingError?: string;

  /** Raw submission profile, validated here so its issues become findings. */
  submissionProfile?: unknown;

  /** Suite results consumed as evidence, named for the report. */
  evidenceSources?: string[];
}

const LANE_SUMMARIES: Record<MuseReadinessLane, string> = {
  "runtime-compatibility": "whether Muse can reach the endpoint over HTTPS",
  "tool-policy": "what the tool listing itself settles against §3 and §4",
  "submission-artifacts": "the §5 submission and the per-tool classification",
  "experience-insights": "heuristics for a human to weigh; never a blocker",
};

function missingInputsFor(
  lane: MuseReadinessLane,
  findings: MuseReadinessFinding[]
): string[] {
  return findings
    .filter((finding) => finding.lane === lane)
    .flatMap((finding) => {
      const named = (finding.details as { missingInput?: unknown } | undefined)
        ?.missingInput;
      return typeof named === "string" ? [named] : [];
    });
}

function summarizeLane(
  lane: MuseReadinessLane,
  status: MuseReadinessLaneResult["status"],
  findings: MuseReadinessFinding[]
): string {
  if (status === "not-ready") {
    const violations = findings.filter(
      (finding) =>
        finding.status === "violated" &&
        (finding.class === "required" || finding.class === "runtime-blocker")
    ).length;
    return `${violations} requirement(s) unmet — ${LANE_SUMMARIES[lane]}.`;
  }
  if (status === "incomplete") {
    const unevaluated = findings.filter(
      (finding) => finding.status === "not-evaluated"
    ).length;
    return unevaluated > 0
      ? `${unevaluated} requirement(s) not evaluated — ${LANE_SUMMARIES[lane]}.`
      : `Nothing dispositive was evaluated — ${LANE_SUMMARIES[lane]}.`;
  }
  return `All applicable requirements satisfied — ${LANE_SUMMARIES[lane]}.`;
}

/** Grade gathered evidence. Pure — no network, no clock, no randomness. */
export function gradeMuseReadiness(
  input: MuseReadinessInput
): MuseReadinessResult {
  const stamp = { evaluatedAt: input.evaluatedAt };

  // PRESENCE, not truthiness: `null` or `""` is malformed input, not absent
  // input, and must surface as a parse issue rather than as "no profile".
  const parsedProfile =
    input.submissionProfile === undefined
      ? { profile: undefined as MuseSubmissionProfile | undefined, issues: [] }
      : parseMuseSubmissionProfile(input.submissionProfile);

  const listing = {
    complete: input.toolListingComplete,
    error: input.toolListingError,
  };
  const toolChecks = runMuseToolChecks(
    input.tools,
    stamp,
    listing,
    parsedProfile.profile?.toolClassifications ?? {}
  );

  const findings: MuseReadinessFinding[] = enforceCapabilityGate(
    [
      ...runMuseEndpointChecks(input.endpoint, stamp),
      ...toolChecks.findings,
      ...runMuseSubmissionChecks(
        {
          profile: parsedProfile.profile,
          profileIssues: parsedProfile.issues,
          tools: input.tools,
          listing,
        },
        stamp
      ),
    ],
    input.capabilities
  );

  const lanes: MuseReadinessLaneResult[] = MUSE_READINESS_LANES.map((lane) => {
    const laneFindings = findings.filter((finding) => finding.lane === lane);
    const status = decideLaneStatus(laneFindings);
    return {
      lane,
      status,
      summary: summarizeLane(lane, status, laneFindings),
      coverage: summarizeLaneCoverage(
        lane,
        laneFindings,
        missingInputsFor(lane, findings)
      ),
    };
  });

  const status = rollUpMuseStage(lanes, "submission-ready");

  return {
    status,
    technicalStatus: rollUpMuseStage(lanes, "technical-preflight"),
    summary: buildRunSummary(status, lanes),
    context: {
      target: input.enteredUrl,
      capabilities: [...input.capabilities].sort(),
      evidenceSources: [...(input.evidenceSources ?? [])].sort(),
    },
    lanes,
    findings,
    classificationSheet: toolChecks.classificationSheet,
    policySnapshotDate: MUSE_POLICY_SNAPSHOT_DATE,
    engineVersion: MUSE_READINESS_ENGINE_VERSION,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
  };
}

function buildRunSummary(
  status: MuseReadinessResult["status"],
  lanes: MuseReadinessLaneResult[]
): string {
  // From the stage table, not a restated list, so the summary can never name
  // different lanes than the rollup decided over.
  const graded = new Set(MUSE_STAGE_LANES["submission-ready"]);
  const required = lanes.filter((lane) => graded.has(lane.lane));
  if (status === "not-ready") {
    const failing = required
      .filter((lane) => lane.status === "not-ready")
      .map((lane) => lane.lane);
    return `Not ready for Muse: ${failing.join(" and ")} ${
      failing.length === 1 ? "has" : "have"
    } unmet requirements.`;
  }
  if (status === "incomplete") {
    const inputs = [
      ...new Set(
        required
          .filter((lane) => lane.status === "incomplete")
          .flatMap((lane) => lane.coverage.missingInputs)
      ),
    ];
    return inputs.length > 0
      ? `Readiness is undetermined: some requirements were not evaluated. Supply ${inputs.join(", ")} to close the gap.`
      : "Readiness is undetermined: some requirements could not be evaluated by this run.";
  }
  return "Every requirement this run could evaluate is satisfied. Meta still reviews every tool and runs end-to-end QA before approval.";
}

/** Named inputs a surface can offer to make a run more complete. */
export { MUSE_READINESS_INPUTS };
