/**
 * The publisher-agnostic directory-readiness result algebra.
 *
 * WHY THIS EXISTS. `claude-readiness` was written first and answered one
 * question: would Anthropic list this connector. The OpenAI plugin directory
 * asks a structurally identical question against an entirely different policy,
 * and the two share nothing about WHAT is required — but they share everything
 * about how a requirement is graded: a finding cites a source, declares its
 * provenance, names the capabilities it needed, and can be dispositive or not;
 * a lane rolls its findings up; coverage is reported separately from verdicts
 * so an unevaluated requirement is never mistaken for a satisfied one.
 *
 * Duplicating that algebra per publisher would let the two drift, and the
 * first thing to drift would be the rule that keeps this product honest —
 * "did not run" must never read as "conformed". So the algebra lives here,
 * once, and each publisher supplies its own lane union, source-reference type
 * and capability union as type parameters.
 *
 * WHAT IS *NOT* HERE. Anything a publisher decides: which lanes exist, which
 * of them are dispositive, what a source reference looks like, what the
 * engine version is. Those are arguments, not constants — a shared module that
 * knew Anthropic's lane names would not be shared, it would be Anthropic's
 * module with a second caller.
 *
 * Pure data reasoning: no MCP client, no transport, no Node built-ins. Safe
 * from the browser entry.
 */

/**
 * What KIND of statement a finding is making. Deliberately not `MUST`/`SHOULD`
 * — those belong to the MCP spec, and reusing them here would let a publisher's
 * policy preference read as a protocol violation.
 *
 * These classes are shared across publishers because they describe the
 * EPISTEMIC status of a statement, not its content: "a human has to look at
 * this" means the same thing whoever is reviewing.
 *
 *   - `required` — the publisher states it as a submission/review requirement.
 *     A violation means the listing will be rejected or delisted.
 *   - `runtime-blocker` — the host cannot complete the flow at all. Distinct
 *     from `required` because it fails before policy is even reached.
 *   - `recommended` — stated guidance whose violation is not disqualifying.
 *   - `experimental-feature` — a capability badge, not a grade. Absence is
 *     never a defect.
 *   - `manual-review` — a human has to look. Quality, ownership, and
 *     credential validity cannot be decided from the wire.
 *   - `heuristic` — a signal, not a verdict. May be confirmed by an LLM or a
 *     person; never fails a lane.
 */
export const DIRECTORY_FINDING_CLASSES = [
  "required",
  "runtime-blocker",
  "recommended",
  "experimental-feature",
  "manual-review",
  "heuristic",
] as const;

export type DirectoryFindingClass = (typeof DIRECTORY_FINDING_CLASSES)[number];

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
export type DirectoryLaneStatus = "ready" | "not-ready" | "incomplete";

/**
 * How a finding was established. A grade that cannot say where its evidence
 * came from is not auditable, and provenance is what stops a static lint from
 * being read as an observed runtime fact.
 *
 *   - `wire` — observed in an HTTP/MCP exchange this run performed.
 *   - `browser` — observed in a rendered widget/browser harness.
 *   - `static` — read out of a document, manifest, archive or schema without
 *     dialing anything.
 *   - `declared` — asserted by the submitter in a submission profile. Never
 *     independently verified by this run.
 *   - `manual` — recorded by a person.
 *   - `llm` — a language model READ evidence this run gathered and said
 *     something about it. Its own provenance value rather than being folded
 *     into `static` or `manual`, because a reader deciding how much weight to
 *     put on a line has to be able to see that a model, not a person and not
 *     the wire, is what produced it. Findings carrying this provenance are
 *     confined to non-dispositive classes by
 *     `directory-readiness/observations`; the separation is enforced there,
 *     not merely documented here.
 */
export const DIRECTORY_EVIDENCE_PROVENANCE = [
  "wire",
  "browser",
  "static",
  "declared",
  "manual",
  "llm",
] as const;

export type DirectoryEvidenceProvenance =
  (typeof DIRECTORY_EVIDENCE_PROVENANCE)[number];

/**
 * How much a check DOES to the target.
 *
 *   - `passive` — no request attributable to this check.
 *   - `read-only` — requests with no persistent effect on the target.
 *   - `side-effecting` — registers a client, spends a grant, mutates state.
 *     Only ever reached through an explicit intrusive opt-in.
 */
export const DIRECTORY_INTRUSIVENESS_LEVELS = [
  "passive",
  "read-only",
  "side-effecting",
] as const;

export type DirectoryIntrusiveness =
  (typeof DIRECTORY_INTRUSIVENESS_LEVELS)[number];

/** A finding's verdict. `informational` carries no pass/fail meaning at all. */
export type DirectoryFindingStatus =
  | "satisfied"
  | "violated"
  | "not-evaluated"
  | "not-applicable"
  | "informational";

/**
 * One graded statement about the target.
 *
 * Every field below the verdict exists so the finding survives contact with
 * time: publisher documentation changes, and a grade that cannot say WHICH
 * revision it was made against becomes silently wrong rather than visibly
 * stale.
 *
 * `SourceRef` is a type parameter rather than a shared interface on purpose.
 * Anthropic's citation names a page key from Anthropic's corpus and OpenAI's
 * names one from OpenAI's; a union of the two would let a check cite the wrong
 * publisher's documentation and still typecheck.
 */
export interface DirectoryReadinessFinding<
  Lane extends string = string,
  SourceRef = unknown,
  Capability extends string = string,
> {
  /**
   * Stable identifier, shipped WITH its check. There is deliberately no frozen
   * union of ids for checks that do not exist yet: publishing one would make
   * the inventory look complete while the coverage was not, which is the same
   * lie `incomplete` exists to prevent.
   */
  id: string;
  title: string;
  lane: Lane;
  class: DirectoryFindingClass;
  status: DirectoryFindingStatus;
  /** One sentence a submitter can act on. Absent for `satisfied`. */
  remediation?: string;
  /** Where in the publisher's documentation this requirement comes from. */
  source: SourceRef;
  provenance: DirectoryEvidenceProvenance;
  intrusiveness: DirectoryIntrusiveness;
  /**
   * Capabilities the runner needed. When the run lacks one, the finding is
   * `not-evaluated` and this is why — which is what makes a coverage gap
   * legible instead of silent.
   */
  requiresCapabilities?: Capability[];
  /** Why a `not-evaluated` finding was not evaluated, in plain words. */
  notEvaluatedReason?: string;
  /** ISO-8601. The moment the verdict was reached, not when it was rendered. */
  evaluatedAt: string;
  /** Version of the readiness engine that produced this finding. */
  engineVersion: string;
  /** Raw observation behind the verdict. Redacted before telemetry. */
  details?: Record<string, unknown>;
  /**
   * Suite results this finding was DERIVED from rather than re-observed, e.g.
   * `"oauth-conformance:oauth-prm-resource-match"`. Readiness composes; a
   * finding that quietly re-ran an existing check would let the two disagree.
   */
  derivedFrom?: string[];
}

/**
 * What a lane managed to look at, reported SEPARATELY from what it found.
 *
 * A lane with zero violations and zero evaluated checks is not a pass, and the
 * only way to keep those apart is to publish the denominator.
 */
export interface DirectoryLaneCoverage<Lane extends string = string> {
  lane: Lane;
  /** Findings that reached a `satisfied`/`violated` verdict. */
  evaluated: number;
  /** Applicable but never exercised. Each one is an unanswered question. */
  notEvaluated: number;
  /** Could not apply to this target; not a gap. */
  notApplicable: number;
  /**
   * Named inputs the caller could supply to close the gap, e.g.
   * `"submissionProfile"`. Empty when the gap is not the caller's to close.
   */
  missingInputs: string[];
}

export interface DirectoryReadinessLaneResult<Lane extends string = string> {
  lane: Lane;
  status: DirectoryLaneStatus;
  /** One line a human can read without opening the findings. */
  summary: string;
  coverage: DirectoryLaneCoverage<Lane>;
}

/**
 * A capability badge. Never a defect when absent — that is the whole
 * difference between a badge and a requirement.
 */
export interface DirectoryCapabilityBadge {
  id: string;
  title: string;
  /**
   * `supported` — observed working. `unsupported` — observed absent.
   * `claimed` — the submitter declared it and this run did not verify it.
   * `not-evaluated` — never looked, which is the default for a badge whose
   * depth-evaluation was neither claimed nor selected.
   */
  state: "supported" | "unsupported" | "claimed" | "not-evaluated";
  detail?: string;
  provenance: DirectoryEvidenceProvenance;
}

/**
 * Whether a finding can DECIDE a lane.
 *
 * Exported because the report adapter needs the same answer: a finding that
 * decides a lane must render as a testcase, and one that does not must render
 * as an advisory. Two copies of this predicate could disagree, and then a
 * report would contradict the verdict it is reporting.
 */
export function isDispositiveDirectoryFinding(
  finding: Pick<DirectoryReadinessFinding<string, unknown, string>, "class">,
): boolean {
  return finding.class === "required" || finding.class === "runtime-blocker";
}

/**
 * Decide one lane's status from its findings.
 *
 * Only `required` and `runtime-blocker` findings can make a lane `not-ready`.
 * A `heuristic` or `manual-review` finding never does, however alarming it
 * reads — that separation is what keeps an LLM's opinion out of a verdict a
 * submitter is held to.
 */
export function decideLaneStatus(
  findings: readonly Pick<
    DirectoryReadinessFinding<string, unknown, string>,
    "class" | "status"
  >[],
): DirectoryLaneStatus {
  const dispositive = findings.filter(isDispositiveDirectoryFinding);
  if (dispositive.some((finding) => finding.status === "violated")) {
    return "not-ready";
  }
  if (dispositive.some((finding) => finding.status === "not-evaluated")) {
    return "incomplete";
  }
  return dispositive.length === 0 ? "incomplete" : "ready";
}

/**
 * Roll a named subset of lanes up into one verdict.
 *
 * `not-ready` dominates `incomplete` dominates `ready`. The ordering is the
 * point: a run that found a violation AND could not evaluate something else is
 * `not-ready` — the violation is established, and softening it to `incomplete`
 * would let an unrelated coverage gap launder a real failure.
 *
 * `requiredLanes` is an argument rather than a module constant because a
 * publisher may roll up more than one way: OpenAI grades a quick technical
 * preflight and a full submission-ready verdict from the same findings, and
 * hard-coding one lane set here would make the second one impossible to state.
 *
 * A lane named in `requiredLanes` but absent from `lanes` is NOT ignored: the
 * rollup is `incomplete`, because a verdict that silently drops a lane it was
 * told to grade is the same failure as reporting an unevaluated lane as a
 * pass.
 */
export function rollUpLaneStatus<Lane extends string>(
  lanes: readonly DirectoryReadinessLaneResult<Lane>[],
  requiredLanes: readonly Lane[],
): DirectoryLaneStatus {
  const byLane = new Map(lanes.map((lane) => [lane.lane, lane]));
  const required = requiredLanes.map((lane) => byLane.get(lane));

  if (required.some((lane) => lane?.status === "not-ready")) return "not-ready";
  // `undefined` — a required lane this result never reported — lands here
  // alongside a genuinely incomplete one. Both mean the same thing to a
  // reader: something dispositive went ungraded.
  if (
    required.some((lane) => lane === undefined || lane.status === "incomplete")
  ) {
    return "incomplete";
  }
  // No required lane at all is not a pass; it is a run that graded nothing
  // dispositive.
  return required.length === 0 ? "incomplete" : "ready";
}

/** Tally a lane's coverage from its findings. */
export function summarizeLaneCoverage<Lane extends string>(
  lane: Lane,
  findings: readonly Pick<
    DirectoryReadinessFinding<Lane, unknown, string>,
    "status"
  >[],
  missingInputs: readonly string[] = [],
): DirectoryLaneCoverage<Lane> {
  return {
    lane,
    evaluated: findings.filter(
      (finding) =>
        finding.status === "satisfied" || finding.status === "violated",
    ).length,
    notEvaluated: findings.filter(
      (finding) => finding.status === "not-evaluated",
    ).length,
    notApplicable: findings.filter(
      (finding) => finding.status === "not-applicable",
    ).length,
    missingInputs: [...new Set(missingInputs)].sort(),
  };
}

/**
 * Hold every finding to the capabilities its own definition declares.
 *
 * `requiresCapabilities` was documented as an invariant and enforced nowhere:
 * each check module was trusted to remember that it had asked for a browser,
 * an interactive authorization, or an intrusive opt-in, and to report
 * `not-evaluated` when the run had none. A check that forgets does not fail
 * loudly — it publishes a verdict it had no evidence for, which is the one
 * outcome this product cannot afford. Enforcing it centrally makes the
 * declaration the thing that decides, rather than a comment each author has to
 * honour.
 *
 * It only ever downgrades. A missing capability turns a verdict into
 * `not-evaluated`; nothing here can turn a `not-evaluated` into a pass.
 *
 * THREE STATUSES ARE LEFT ALONE, because for them there is no verdict to
 * withdraw:
 *
 *   - `not-evaluated` is already the downgrade, and rewriting it would replace
 *     a specific reason ("the endpoint could not be reached") with a generic
 *     one about a capability that was never the obstacle.
 *   - `not-applicable` says the rule does not apply to THIS submission — a
 *     skills-only bundle has no MCP endpoint whatever capabilities the run
 *     holds. Downgrading it invents a coverage gap out of a settled question
 *     and puts a "nobody checked" line in a report where "there is nothing to
 *     check" is the truth.
 *   - `informational` carries no verdict at all: badges and heuristics are
 *     excluded from lane rollups by construction, so gating them changes
 *     nothing except to make a report read as less complete than it is.
 */
export function enforceCapabilityGate<
  Capability extends string,
  Finding extends Pick<
    DirectoryReadinessFinding<string, unknown, Capability>,
    "status" | "requiresCapabilities" | "notEvaluatedReason"
  >,
>(
  findings: readonly Finding[],
  capabilities: readonly Capability[],
): Finding[] {
  const available = new Set<Capability>(capabilities);
  return findings.map((finding) => {
    const missing = (finding.requiresCapabilities ?? []).filter(
      (capability) => !available.has(capability),
    );
    if (
      missing.length === 0 ||
      finding.status === "not-evaluated" ||
      finding.status === "not-applicable" ||
      finding.status === "informational"
    ) {
      return finding;
    }
    return {
      ...finding,
      status: "not-evaluated",
      notEvaluatedReason: `this run had no ${missing.join(
        ", ",
      )} capability, so the check could not observe what it grades`,
    };
  });
}
