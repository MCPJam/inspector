/**
 * The composite readiness run, split into two halves that do not resemble each
 * other.
 *
 * `gatherOpenAIReadinessEvidence` performs every side effect — reading a
 * package, adapting suite results, and (from the discovery module) dialing the
 * target — and returns a SERIALIZABLE evidence object.
 * `gradeOpenAIReadiness` is pure: same evidence in, same result out, no
 * network, no clock, no randomness.
 *
 * This is stricter than the Claude runner, which takes pre-gathered evidence
 * pieces loose, and the strictness buys three things. A hosted surface can
 * gather on one node and grade on another. A test can drive the whole grader
 * from a fixture with no transport anywhere near it. And a grading run can
 * never accidentally reach `169.254.169.254`, because the half that could is a
 * different function.
 *
 * WHAT `status` MEANS HERE. The `submission-ready` stage — the stricter of the
 * two — because a submitter asking "am I ready" is asking about the submission.
 * `stages` carries both, so the narrower technical verdict stays visible next
 * to it rather than being the headline.
 *
 * WHY THE MODE IS AN ARGUMENT. Applicability is decided by the DECLARED
 * submission shape, never by which inputs happen to be present. Inference reads
 * a forgotten ZIP as "MCP-only" and reports the package lane `not-applicable` —
 * turning a missing input into a clean bill of health.
 */

import { enforceCapabilityGate } from "../directory-readiness/types.js";
import { rollUpLaneStatus as rollUpDirectoryLaneStatus } from "../directory-readiness/types.js";
import {
  decideLaneStatus,
  summarizeLaneCoverage,
} from "../directory-readiness/types.js";
import { OPENAI_POLICY_SNAPSHOT_DATE } from "./manifest.js";
import {
  readOpenAIPluginPackage,
  type OpenAIArchiveObservations,
  type OpenAIPluginPackageEvidence,
} from "./package/reader.js";
import {
  annotatedToolNames,
  runOpenAIAnnotationChecks,
  type OpenAIToolEvidence,
} from "./checks/annotations.js";
import {
  runOpenAIAppsUiChecks,
  type OpenAIAppsUiEvidence,
} from "./checks/apps-ui.js";
import { runOpenAIAuthChecks } from "./checks/auth.js";
import { runOpenAIMcpSkillChecks } from "./checks/mcp-skills.js";
import { runOpenAIMigrationChecks } from "./checks/migration.js";
import { runOpenAIOptionalFeatureChecks } from "./checks/optional-features.js";
import { runOpenAIPolicyChecks } from "./checks/policy.js";
import { runOpenAIDomainVerificationChecks } from "./checks/domain-verification.js";
import { runOpenAIEndpointChecks } from "./checks/endpoint.js";
import { runOpenAIPackageChecks } from "./checks/package.js";
import { runOpenAISubmissionChecks } from "./checks/submission.js";
import {
  discoverOpenAIAuthEvidence,
  discoverOpenAIImportedSkills,
  fetchOpenAIDomainVerification,
  traceOpenAIEndpoint,
  type OpenAIAuthEvidence,
  type OpenAIDomainVerificationEvidence,
  type OpenAIEndpointEvidence,
  type OpenAISkillsEvidence,
} from "./discovery.js";
import {
  parseOpenAISubmissionProfile,
  type OpenAISubmissionProfile,
} from "./submission-profile.js";
import {
  OPENAI_HEADLINE_STAGE,
  OPENAI_READINESS_ENGINE_VERSION,
  OPENAI_READINESS_LANES,
  OPENAI_READINESS_STAGES,
  OPENAI_SUBMISSION_MODE_SHAPES,
  isLaneApplicableInMode,
  stageLanesFor,
  type OpenAICapabilityBadge,
  type OpenAILaneStatus,
  type OpenAIReadinessAuthMode,
  type OpenAIReadinessFinding,
  type OpenAIReadinessLane,
  type OpenAIReadinessLaneResult,
  type OpenAIReadinessResult,
  type OpenAIReadinessStage,
  type OpenAIReadinessStageResult,
  type OpenAIRunnerCapability,
  type OpenAISubmissionMode,
} from "./types.js";

import type { XmlParseFn } from "./package/image-dimensions.js";
import type { PluginFileSource } from "../plugin-bundle/types.js";

/**
 * Everything a grade needs, already gathered and serializable.
 *
 * Deliberately holds no functions, no streams and no client handles: an
 * evidence object that could not survive `JSON.stringify` would defeat the
 * split this module exists to make.
 */
export interface OpenAIReadinessEvidence {
  /** The endpoint or package the run graded, as the caller named it. */
  target: string;
  /** The DECLARED submission shape. Never inferred — see the module docblock. */
  mode: OpenAISubmissionMode;
  authMode: OpenAIReadinessAuthMode;
  capabilities: OpenAIRunnerCapability[];
  startedAt: string;
  evaluatedAt: string;
  durationMs: number;

  /** The endpoint's redirect trace, when the run had an endpoint. */
  endpoint?: OpenAIEndpointEvidence;
  /** The authorization evidence, when the run had an endpoint. */
  auth?: OpenAIAuthEvidence;
  /** The domain-verification challenge, when the run had an endpoint. */
  domainVerification?: OpenAIDomainVerificationEvidence;
  /** The tool listing, read once by the gatherer and graded statically. */
  tools?: OpenAIToolEvidence[];
  /** Skills advertised for import, when the run read them. */
  importedSkills?: OpenAISkillsEvidence;
  /** UI resources the server serves, and the screenshots that go with them. */
  appsUi?: OpenAIAppsUiEvidence;
  /** Whether the plugin sells anything, for the commerce rules. */
  hasCommerce?: boolean;
  /** Read from a package source, when the run was given one. */
  package?: OpenAIPluginPackageEvidence;
  /** Raw submission profile, validated during grading so issues become findings. */
  submissionProfile?: unknown;
  /** Tools observed carrying a destructive or open-world annotation. */
  annotatedTools?: string[];
  /** UI frame domains observed on the wire. */
  frameDomains?: string[];
  /** Whether a version of this plugin is already published. */
  hasPublishedVersion?: boolean;
  /** Suite results consumed as evidence, named for the report. */
  evidenceSources?: string[];
}

const LANE_SUMMARIES: Record<OpenAIReadinessLane, string> = {
  "runtime-compatibility":
    "whether ChatGPT can connect, authenticate and render",
  "directory-policy": "the deterministic stated requirements",
  "plugin-package": "the archive the submission portal validates",
  "release-contract": "whether this version breaks the published contract",
  "optional-features":
    "capability badges; nothing here can make a submission unready",
  "submission-artifacts":
    "listing fields, tests, attestations and review materials",
  "experience-insights": "heuristics and observations for a human to weigh",
};

const STAGE_SUMMARIES: Record<OpenAIReadinessStage, string> = {
  "technical-preflight": "whether the thing itself is fit to submit",
  "submission-ready": "whether the submission is complete",
};

/** Inputs a caller could supply to close a lane's gaps. */
function missingInputsFor(
  lane: OpenAIReadinessLane,
  findings: OpenAIReadinessFinding[],
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
  lane: OpenAIReadinessLane,
  status: OpenAILaneStatus,
  findings: OpenAIReadinessFinding[],
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
 * A lane the MODE excludes reports `not-applicable`, once, rather than being
 * absent from the result.
 *
 * An absent lane and an inapplicable one read the same in a rollup and mean
 * opposite things, so the lane is always present and says which it is.
 */
function laneResultFor(
  lane: OpenAIReadinessLane,
  mode: OpenAISubmissionMode,
  findings: OpenAIReadinessFinding[],
): OpenAIReadinessLaneResult {
  const laneFindings = findings.filter((finding) => finding.lane === lane);

  if (!isLaneApplicableInMode(lane, mode)) {
    return {
      lane,
      // `ready` is the honest status for a lane with nothing to grade: the
      // stage rollup drops it entirely (see `stageLanesFor`), so this value is
      // never what decides a verdict, and calling it `incomplete` would make
      // every skills-only submission look like it was missing an endpoint.
      status: "ready",
      summary: `Not applicable — a ${mode} submission is ${OPENAI_SUBMISSION_MODE_SHAPES[mode].summary}.`,
      coverage: summarizeLaneCoverage(lane, laneFindings, []),
    };
  }

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
}

function buildStage(
  stage: OpenAIReadinessStage,
  mode: OpenAISubmissionMode,
  lanes: OpenAIReadinessLaneResult[],
  hasPublishedVersion: boolean,
): OpenAIReadinessStageResult {
  const stageLanes = stageLanesFor(stage, mode, { hasPublishedVersion });
  const status = rollUpDirectoryLaneStatus(lanes, stageLanes);
  return {
    stage,
    status,
    lanes: stageLanes,
    summary: describeStage(stage, status, lanes, stageLanes),
  };
}

function describeStage(
  stage: OpenAIReadinessStage,
  status: OpenAILaneStatus,
  lanes: OpenAIReadinessLaneResult[],
  stageLanes: OpenAIReadinessLane[],
): string {
  const inStage = lanes.filter((lane) => stageLanes.includes(lane.lane));
  if (status === "not-ready") {
    const failing = inStage
      .filter((lane) => lane.status === "not-ready")
      .map((lane) => lane.lane);
    return `Not ready — ${STAGE_SUMMARIES[stage]}: ${failing.join(" and ")} ${
      failing.length === 1 ? "has" : "have"
    } unmet requirements.`;
  }
  if (status === "incomplete") {
    const gaps = [
      ...new Set(
        inStage
          .filter((lane) => lane.status === "incomplete")
          .flatMap((lane) => lane.coverage.missingInputs),
      ),
    ];
    return gaps.length > 0
      ? `Undetermined — ${STAGE_SUMMARIES[stage]}. Supply ${gaps.join(", ")} to close the gap.`
      : `Undetermined — ${STAGE_SUMMARIES[stage]}: some requirements could not be evaluated by this run.`;
  }
  return `Ready — ${STAGE_SUMMARIES[stage]}: every applicable requirement was satisfied.`;
}

/**
 * Everything a package says about ITSELF, for the guideline metadata rules.
 *
 * Collected here rather than in the check so the check stays a pure function of
 * named strings: it grades copy, and it should not have to know the shape of a
 * package to find it.
 */
function packageSelfDescription(
  evidence: OpenAIPluginPackageEvidence | undefined,
): { field: string; text: string }[] {
  if (!evidence) return [];
  const out: { field: string; text: string }[] = [];
  const push = (field: string, text: string | undefined) => {
    if (text) out.push({ field, text });
  };
  push("manifest.description", evidence.manifest?.description);
  push(
    "interface.display_name",
    evidence.agentMetadata?.metadata?.interface.displayName,
  );
  push(
    "interface.short_description",
    evidence.agentMetadata?.metadata?.interface.shortDescription,
  );
  for (const skill of evidence.skills) {
    push(`skills/${skill.directoryName}.description`, skill.description);
  }
  return out;
}

/**
 * Grade gathered evidence. Pure — no network, no clock, no randomness.
 */
export function gradeOpenAIReadiness(
  evidence: OpenAIReadinessEvidence,
): OpenAIReadinessResult {
  const stamp = { evaluatedAt: evidence.evaluatedAt };

  // PRESENCE, not truthiness. `submissionProfile` is `unknown`, so `null`, `0`
  // and `""` are malformed INPUT rather than absent input, and routing them
  // down the "no input" branch would hide a caller's mistake behind a status
  // that reads like our limitation.
  const parsedProfile =
    evidence.submissionProfile === undefined
      ? {
          profile: undefined as OpenAISubmissionProfile | undefined,
          issues: [],
        }
      : parseOpenAISubmissionProfile(evidence.submissionProfile);

  // The profile is authoritative about whether a published version exists,
  // because that is a fact about the LISTING rather than about the run. A
  // caller may also state it directly for a run with no profile.
  const hasPublishedVersion =
    parsedProfile.profile?.hasPublishedVersion ??
    evidence.hasPublishedVersion ??
    false;

  const shape = OPENAI_SUBMISSION_MODE_SHAPES[evidence.mode];

  // Server-side checks run only in a shape that HAS a server. In a shape that
  // does not, the lane is reported `not-applicable` once by `laneResultFor`
  // rather than as a page of inapplicable findings.
  const serverFindings = shape.hasMcpServer
    ? [
        ...runOpenAIEndpointChecks(evidence.endpoint, stamp),
        ...runOpenAIAuthChecks(evidence.auth, stamp),
        ...runOpenAIAnnotationChecks(evidence.tools, stamp),
        ...runOpenAIDomainVerificationChecks(
          {
            evidence: evidence.domainVerification,
            declaredToken: parsedProfile.profile?.domainVerificationToken,
          },
          stamp,
        ),
        ...runOpenAIAppsUiChecks(
          evidence.appsUi
            ? {
                ...evidence.appsUi,
                screenshotCount:
                  evidence.appsUi.screenshotCount ??
                  parsedProfile.profile?.screenshots.length,
              }
            : undefined,
          stamp,
        ),
      ]
    : [];

  const optional = runOpenAIOptionalFeatureChecks(
    {
      importedSkills: evidence.importedSkills?.extensionAdvertised,
      uiResourceCount: evidence.appsUi?.resources?.length,
      clientIdMetadataDocuments: evidence.auth?.authorizationServers?.some(
        (server) =>
          server.document?.client_id_metadata_document_supported === true,
      ),
      checkout: evidence.hasCommerce,
    },
    stamp,
  );

  // Observed annotations beat a caller's list: the submission check needs to
  // know which tools ACTUALLY carry a destructive or open-world hint, and a
  // caller-supplied list can only ever be a restatement of the same listing.
  const annotatedTools =
    evidence.tools !== undefined
      ? annotatedToolNames(evidence.tools)
      : evidence.annotatedTools;

  const findings: OpenAIReadinessFinding[] = enforceCapabilityGate(
    [
      ...serverFindings,
      ...runOpenAIMcpSkillChecks(
        { mode: evidence.mode, evidence: evidence.importedSkills },
        stamp,
      ),
      ...runOpenAIPackageChecks(
        { mode: evidence.mode, package: evidence.package },
        stamp,
      ),
      ...(shape.hasUploadedPackage
        ? runOpenAIMigrationChecks(evidence.package, stamp)
        : []),
      ...runOpenAIPolicyChecks(
        {
          profile: parsedProfile.profile,
          packageMetadata: packageSelfDescription(evidence.package),
          hasCommerce: evidence.hasCommerce,
        },
        stamp,
      ),
      ...optional.findings,
      ...runOpenAISubmissionChecks(
        {
          profile: parsedProfile.profile,
          profileIssues: parsedProfile.issues,
          annotatedTools,
          frameDomains: evidence.frameDomains,
        },
        stamp,
      ),
    ],
    evidence.capabilities,
  );

  const badges: OpenAICapabilityBadge[] = optional.badges;

  const lanes = OPENAI_READINESS_LANES.map((lane) =>
    laneResultFor(lane, evidence.mode, findings),
  );

  const stages = OPENAI_READINESS_STAGES.map((stage) =>
    buildStage(stage, evidence.mode, lanes, hasPublishedVersion),
  );

  const headline =
    stages.find((stage) => stage.stage === OPENAI_HEADLINE_STAGE) ?? stages[0];

  return {
    readinessKind: "openai-directory-readiness",
    status: headline.status,
    summary: buildRunSummary(stages),
    context: {
      target: evidence.target,
      mode: evidence.mode,
      authMode: evidence.authMode,
      capabilities: [...evidence.capabilities].sort(),
      evidenceSources: [...(evidence.evidenceSources ?? [])].sort(),
    },
    stages,
    lanes,
    findings,
    badges,
    policySnapshotDate: OPENAI_POLICY_SNAPSHOT_DATE,
    engineVersion: OPENAI_READINESS_ENGINE_VERSION,
    startedAt: evidence.startedAt,
    durationMs: evidence.durationMs,
  };
}

/**
 * The headline sentence, which names BOTH stages when they disagree.
 *
 * A submitter whose server is fine and whose paperwork is not should read that
 * in one line. Reporting only the headline status would tell them "not ready"
 * and send them looking at their server.
 */
function buildRunSummary(stages: OpenAIReadinessStageResult[]): string {
  const technical = stages.find(
    (stage) => stage.stage === "technical-preflight",
  );
  const submission = stages.find((stage) => stage.stage === "submission-ready");
  if (!technical || !submission) {
    return stages.map((stage) => stage.summary).join(" ");
  }
  if (technical.status === submission.status) return submission.summary;
  return `${submission.summary} The technical preflight on its own is ${technical.status}.`;
}

// ---------------------------------------------------------------------------
// The side-effecting half.
// ---------------------------------------------------------------------------

export interface GatherOpenAIReadinessEvidenceOptions {
  target: string;
  mode: OpenAISubmissionMode;
  authMode?: OpenAIReadinessAuthMode;
  capabilities?: OpenAIRunnerCapability[];
  /**
   * The transport, REQUIRED to gather any wire evidence.
   *
   * With no `fetchFn` the gatherer dials nothing and the server lanes report
   * their gaps — the honest outcome for a package-only run. There is no default
   * on purpose: in a hosted run this must be the DNS-pinned transport, and a
   * default would make the unguarded case the easy one to reach.
   */
  fetchFn?: typeof fetch;
  /** A package source to read, when the submission shape uploads one. */
  packageSource?: PluginFileSource;
  /** The tool listing, when the caller already holds one. */
  tools?: OpenAIToolEvidence[];
  /** Imported skills, when the caller already holds them. */
  importedSkills?: OpenAISkillsEvidence;
  /** UI resources, typically adapted from an apps-conformance result. */
  appsUi?: OpenAIAppsUiEvidence;
  /** Whether the plugin sells anything. */
  hasCommerce?: boolean;
  /** Archive facts the source cannot report. See `OpenAIArchiveObservations`. */
  archive?: OpenAIArchiveObservations;
  /**
   * How to parse an SVG, for runtimes with no `DOMParser` — i.e. Node, which
   * passes `xmldomParseXml` from the Node entry.
   */
  parseXml?: XmlParseFn;
  submissionProfile?: unknown;
  annotatedTools?: string[];
  frameDomains?: string[];
  hasPublishedVersion?: boolean;
  evidenceSources?: string[];
  /**
   * Injected so the gatherer is deterministic under test.
   *
   * Not a convenience: a gatherer that read the clock itself would make every
   * evidence object unequal to every other, and the point of a serializable
   * evidence object is that two runs over the same inputs produce the same one.
   */
  now?: () => Date;
}

/**
 * Gather evidence, performing every side effect this product performs.
 *
 * Reads the package today; the discovery half joins it when the wire lanes
 * land. Callers that already hold evidence — a hosted node replaying a stored
 * run — skip this entirely and call {@link gradeOpenAIReadiness}.
 */
export async function gatherOpenAIReadinessEvidence(
  options: GatherOpenAIReadinessEvidenceOptions,
): Promise<OpenAIReadinessEvidence> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const packageEvidence = options.packageSource
    ? await readOpenAIPluginPackage(options.packageSource, {
        archive: options.archive,
        parseXml: options.parseXml,
      })
    : undefined;

  // The wire half. Only when the caller supplied BOTH a transport and a shape
  // that has a server: dialing a skills-only submission's non-existent endpoint
  // would be a request nobody asked for.
  const wantsServer = OPENAI_SUBMISSION_MODE_SHAPES[options.mode].hasMcpServer;
  const discovery =
    options.fetchFn && wantsServer
      ? { enteredUrl: options.target, fetchFn: options.fetchFn }
      : undefined;

  const [endpoint, auth, domainVerification] = discovery
    ? await Promise.all([
        traceOpenAIEndpoint(discovery),
        discoverOpenAIAuthEvidence(discovery),
        fetchOpenAIDomainVerification(discovery),
      ])
    : [undefined, undefined, undefined];

  // Skills are read only in the shape that imports them. Calling `skills/list`
  // against a server that does not advertise the extension would turn a
  // legitimate absence into an error in the log.
  const importedSkills =
    discovery && OPENAI_SUBMISSION_MODE_SHAPES[options.mode].hasImportedSkills
      ? await discoverOpenAIImportedSkills(discovery, now)
      : options.importedSkills;

  const finishedAt = now();

  return {
    target: options.target,
    mode: options.mode,
    authMode: options.authMode ?? "headless",
    capabilities: options.capabilities ?? [],
    startedAt,
    evaluatedAt: finishedAt.toISOString(),
    durationMs: Math.max(
      0,
      finishedAt.getTime() - new Date(startedAt).getTime(),
    ),
    endpoint,
    auth,
    domainVerification,
    tools: options.tools,
    importedSkills,
    appsUi: options.appsUi,
    hasCommerce: options.hasCommerce,
    package: packageEvidence,
    submissionProfile: options.submissionProfile,
    annotatedTools: options.annotatedTools,
    frameDomains: options.frameDomains,
    hasPublishedVersion: options.hasPublishedVersion,
    evidenceSources: options.evidenceSources,
  };
}
