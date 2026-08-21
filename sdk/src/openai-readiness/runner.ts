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
import { dialMcpServer } from "../directory-readiness/mcp-dial.js";
import { NOT_REQUESTED_OBSERVATIONS } from "../directory-readiness/observations.js";
import {
  mapOpenAIObservationsToFindings,
  type OpenAIObservationState,
} from "./observations.js";
import { OPENAI_POLICY_SNAPSHOT_DATE } from "./manifest.js";
import { OPENAI_APP_HTML_MIME } from "./profile.js";
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
import { runOpenAIReleaseContractChecks } from "./checks/release-contract.js";
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

import type { OpenAIMetadataSnapshot } from "./snapshot.js";
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
  /**
   * Whether {@link tools} is the WHOLE listing.
   *
   * Separate from `tools` because the two answer different questions and only
   * one of them can be read off an array. A five-entry listing from a server
   * with forty tools is not a short listing, it is a truncated one, and
   * grading the annotation requirements against it would report a submission
   * as ready on the strength of the tools that happened to fit on page one.
   * Absent means "the caller handed these over and made no claim", which the
   * grader treats exactly as it treats a complete listing — a caller passing
   * evidence in has already decided what it is passing.
   */
  toolListingComplete?: boolean;
  /** Why the tool listing is partial or absent, in plain words. */
  toolListingError?: string;
  /** Skills advertised for import, when the run read them. */
  importedSkills?: OpenAISkillsEvidence;
  /** UI resources the server serves, and the screenshots that go with them. */
  appsUi?: OpenAIAppsUiEvidence;
  /** Whether the plugin sells anything, for the commerce rules. */
  hasCommerce?: boolean;
  /** This version's metadata snapshot, for the release-contract comparison. */
  draftSnapshot?: OpenAIMetadataSnapshot;
  /** The published version's snapshot, captured whenever it was published. */
  publishedSnapshot?: OpenAIMetadataSnapshot;
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
  /**
   * The model-observation axis, whatever happened on it.
   *
   * PART OF THE EVIDENCE rather than an argument to the grader, so a replayed
   * evidence object regrades to the same result. It arrives already validated
   * — the grader never sees raw provider output, and could not call a provider
   * if it wanted to.
   */
  llmObservations?: OpenAIObservationState;
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
      ? `Undetermined — ${STAGE_SUMMARIES[stage]}. Supply ${gaps.join(
          ", ",
        )} to close the gap.`
      : `Undetermined — ${STAGE_SUMMARIES[stage]}: some requirements could not be evaluated by this run.`;
  }
  return `Ready — ${STAGE_SUMMARIES[stage]}: every applicable requirement was satisfied.`;
}

/**
 * `_meta.ui.domain`, read off a dialled resource.
 *
 * A tiny reader rather than a shared one because the two publishers want
 * different things from the same `_meta`: OpenAI requires this field present
 * and unique, and Anthropic derives its content domain from the connector URL
 * instead. A shared extractor would have to serve both and would end up
 * meaning neither.
 */
function readUiDomain(meta: Record<string, unknown> | undefined) {
  const ui = meta?.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    return undefined;
  }
  const domain = (ui as Record<string, unknown>).domain;
  return typeof domain === "string" ? domain : undefined;
}

/**
 * The domains a resource's declared CSP names.
 *
 * TOLERANT ABOUT SHAPE: the extension spells this two ways in the wild, a flat
 * array of domains and an object of directive → domains. Reading whichever is
 * present costs nothing; insisting on one would report a template with a
 * perfectly good allowlist as declaring none, and the check that grades "the
 * allowlist is exact" would then flag every domain the template loads.
 */
function readUiCspDomains(meta: Record<string, unknown> | undefined) {
  const ui = meta?.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    return undefined;
  }
  const csp = (ui as Record<string, unknown>).csp;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];

  const flat = strings(csp);
  if (flat.length > 0) return flat;
  if (typeof csp !== "object" || csp === null || Array.isArray(csp)) {
    return undefined;
  }
  const domains = Object.values(csp as Record<string, unknown>).flatMap(
    strings,
  );
  return domains.length > 0 ? [...new Set(domains)].sort() : undefined;
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
        ...runOpenAIAnnotationChecks(evidence.tools, stamp, {
          complete: evidence.toolListingComplete,
          error: evidence.toolListingError,
        }),
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
      ...runOpenAIReleaseContractChecks(
        {
          draft: evidence.draftSnapshot,
          published: evidence.publishedSnapshot,
          hasPublishedVersion,
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
          hasPublishedVersion,
        },
        stamp,
      ),
      // LAST, and inside the capability gate like everything else. The mapper
      // can only emit `heuristic`/`manual-review` findings in
      // `experience-insights`, which `decideLaneStatus` does not consult — so
      // their position in this list cannot change a verdict. They are appended
      // rather than interleaved purely so a reader scanning the findings sees
      // the deterministic inventory first.
      ...mapOpenAIObservationsToFindings(
        evidence.llmObservations?.envelope,
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
    llmObservations: evidence.llmObservations ?? NOT_REQUESTED_OBSERVATIONS,
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
  /**
   * Per-request budget for the wire half. The caller owns the run deadline.
   *
   * Threaded through rather than left to the discovery default because a
   * hosted run and a local one have different ceilings: a hosted node is
   * holding a lease with a heartbeat, and a probe that outran the lease would
   * be swept mid-run.
   */
  timeoutMs?: number;
  /**
   * Headers the target needs, e.g. a saved server's credential.
   *
   * Without these a credentialed server answers `401` to every probe and the
   * whole run reports an auth wall — a true observation about an
   * unauthenticated dial, and the wrong one for a submitter grading their own
   * server with a token they supplied.
   */
  headers?: Record<string, string>;
  /**
   * The caller's cancellation.
   *
   * Composed into every request this gather makes — the redirect trace, the
   * auth discovery, the dial and the skills walk — so a cancelled run stops
   * the request IN FLIGHT rather than merely declining to start the next one.
   * A readiness run's requests are seconds long against somebody else's
   * server, and that traffic is exactly what a cancellation is meant to stop.
   */
  signal?: AbortSignal;
  /** A package source to read, when the submission shape uploads one. */
  packageSource?: PluginFileSource;
  /**
   * The tool listing, when the caller already holds one.
   *
   * Supplying it SKIPS the dial. A caller holding an attributable listing from
   * a conformance run should not make the target answer `tools/list` twice,
   * and re-dialling would also let the two listings disagree about one server.
   */
  tools?: OpenAIToolEvidence[];
  /** Imported skills, when the caller already holds them. */
  importedSkills?: OpenAISkillsEvidence;
  /** UI resources, typically adapted from an apps-conformance result. */
  appsUi?: OpenAIAppsUiEvidence;
  /** Whether the plugin sells anything. */
  hasCommerce?: boolean;
  /** Snapshots for the release-contract comparison. */
  draftSnapshot?: OpenAIMetadataSnapshot;
  publishedSnapshot?: OpenAIMetadataSnapshot;
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
   * An ALREADY VALIDATED observation state.
   *
   * The gatherer performs every side effect this product performs, and calling
   * a model is emphatically not one of them: provider credentials never reach
   * a Node worker, the call is billed, and a gatherer that could make it would
   * put spending inside a function every local run calls for free. The hosted
   * runner asks the backend broker, validates the answer against this
   * publisher's schema, and hands the state in here.
   */
  llmObservations?: OpenAIObservationState;
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
      ? {
          enteredUrl: options.target,
          fetchFn: options.fetchFn,
          timeoutMs: options.timeoutMs,
          headers: options.headers,
          signal: options.signal,
        }
      : undefined;

  const [endpoint, auth, domainVerification] = discovery
    ? await Promise.all([
        traceOpenAIEndpoint(discovery),
        discoverOpenAIAuthEvidence(discovery),
        fetchOpenAIDomainVerification(discovery),
      ])
    : [undefined, undefined, undefined];

  // THE TOOL LISTING, DIALLED. Until this landed the gatherer accepted a
  // listing as an argument and never fetched one, so every wire run graded the
  // whole annotation inventory `not-evaluated` — checks that existed, were
  // wired up, and could not fire. A caller-supplied listing still wins: it is
  // attributable to a run that already happened, and dialling over the top
  // would let two listings of one server disagree.
  // AN EXPLICIT EMPTY ARRAY IS A SUPPLIED LISTING. `!options.tools` is truthy
  // for `[]`, which would dial over the top of a caller that had already
  // established this server advertises no tools — and then attach the dial's
  // completeness and errors to their answer, turning a known zero-tool server
  // into an incomplete listing.
  const hasSuppliedTools = options.tools !== undefined;
  const hasSuppliedAppsUi = options.appsUi !== undefined;
  const dialled =
    discovery && (!hasSuppliedTools || !hasSuppliedAppsUi)
      ? await dialMcpServer({
          ...discovery,
          // Each half is requested only when its answer will be USED. A
          // caller who already holds one of them gets the other without the
          // target being asked twice for something this run would discard.
          appHtmlMime: hasSuppliedAppsUi ? undefined : OPENAI_APP_HTML_MIME,
          ...(hasSuppliedTools ? { tools: options.tools } : {}),
        })
      : undefined;

  // A TRUNCATED LISTING IS NOT A LISTING. `complete` is the dial's own verdict
  // over pagination caps, entry caps and transport failures; when it is false
  // the entries are still carried — they are real observations — but the
  // grader is told not to treat them as the whole set, and the annotation
  // checks report a gap rather than a pass earned by the tools that fit on
  // page one. An `unsupported` listing IS complete: a server that answered
  // "no such method" has answered.
  const tools = hasSuppliedTools ? options.tools : dialled?.tools?.entries;
  const toolListingComplete = hasSuppliedTools
    ? undefined
    : dialled?.tools?.complete;

  // Skills are read only in the shape that imports them. Calling `skills/list`
  // against a server that does not advertise the extension would turn a
  // legitimate absence into an error in the log.
  const importedSkills =
    discovery && OPENAI_SUBMISSION_MODE_SHAPES[options.mode].hasImportedSkills
      ? await discoverOpenAIImportedSkills(discovery, now)
      : options.importedSkills;

  // A TRUNCATED RESOURCE LISTING GRADES NOTHING, for the same reason a
  // truncated tool listing does: a widget that fell off the end reads as a
  // server with no widgets, which the UI checks report `not-applicable` — a
  // clean bill of health for a page nobody read.
  const dialledApps = dialled?.appResources;
  const appsUiFromDial: OpenAIAppsUiEvidence | undefined =
    dialledApps && dialledApps.listing.complete
      ? {
          resources: dialledApps.appResources.map((resource) => ({
            uri: resource.uri,
            mimeType: resource.mimeType,
            domain: readUiDomain(resource._meta),
            declaredCspDomains: readUiCspDomains(resource._meta),
            referencedByTools: dialledApps.referencedByTools[resource.uri],
          })),
        }
      : undefined;

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
    tools,
    toolListingComplete,
    toolListingError: hasSuppliedTools ? undefined : dialled?.tools?.error,
    importedSkills,
    // THE DIALLED RESOURCES ARE USED, not discarded. Requesting them and then
    // returning only the caller's `appsUi` would leave the UI lane
    // permanently `not-evaluated` on a wire run — the same shape of bug the
    // tool listing had. A caller-supplied result still wins: it is
    // attributable to a run that already happened, and re-reading would let
    // two readings of one server disagree.
    appsUi: options.appsUi ?? appsUiFromDial,
    hasCommerce: options.hasCommerce,
    draftSnapshot: options.draftSnapshot,
    publishedSnapshot: options.publishedSnapshot,
    package: packageEvidence,
    submissionProfile: options.submissionProfile,
    annotatedTools: options.annotatedTools,
    frameDomains: options.frameDomains,
    hasPublishedVersion: options.hasPublishedVersion,
    evidenceSources: options.evidenceSources,
    llmObservations: options.llmObservations,
  };
}
