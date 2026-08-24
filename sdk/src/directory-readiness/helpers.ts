/**
 * Finding constructors, bound once per publisher.
 *
 * Checks never build a {@link DirectoryReadinessFinding} literal. Going through
 * these is what guarantees the fields that make a grade auditable — source
 * citation, provenance, intrusiveness, engine version, timestamp — are present
 * on every finding rather than on the ones whose author remembered. A check
 * that could construct a finding by hand is a check that can quietly ship one
 * with no provenance.
 *
 * WHY A FACTORY RATHER THAN FREE FUNCTIONS. The engine version is a property of
 * the PUBLISHER's check inventory, not of a call site: Anthropic's checks and
 * OpenAI's are versioned independently, so two grades of the same target under
 * one publisher's snapshot stay comparable while the other publisher's engine
 * moves. Threading it through every call would put it in the hands of the
 * caller — and a check that passes the wrong version stamps a finding with a
 * provenance it does not have. Binding it once, at module scope, makes the
 * version impossible to get wrong from inside a check.
 *
 * Pure data. No transport.
 */

import type {
  DirectoryEvidenceProvenance,
  DirectoryFindingClass,
  DirectoryIntrusiveness,
  DirectoryReadinessFinding,
} from "./types.js";

/** Everything about a check that does not depend on what it observed. */
export interface DirectoryCheckDefinition<
  Lane extends string = string,
  SourceRef = unknown,
  Capability extends string = string,
> {
  id: string;
  title: string;
  lane: Lane;
  class: DirectoryFindingClass;
  source: SourceRef;
  provenance: DirectoryEvidenceProvenance;
  /** Defaults to `read-only`; a purely static lint should say `passive`. */
  intrusiveness?: DirectoryIntrusiveness;
  requiresCapabilities?: Capability[];
}

/** What every check is handed, so none of them reads a clock of its own. */
export interface DirectoryCheckStamp {
  /** One timestamp for the whole run: findings from one run are one moment. */
  evaluatedAt: string;
}

/**
 * The five constructors, all closed over one engine version.
 *
 * Named as an interface rather than inferred so a publisher's re-export has a
 * type to point at, and so adding a sixth constructor is a visible change to
 * this contract rather than a silent widening of everyone's surface.
 */
export interface DirectoryFindingConstructors<
  Lane extends string,
  SourceRef,
  Capability extends string,
> {
  satisfied(
    definition: DirectoryCheckDefinition<Lane, SourceRef, Capability>,
    stamp: DirectoryCheckStamp,
    details?: Record<string, unknown>,
  ): DirectoryReadinessFinding<Lane, SourceRef, Capability>;

  violated(
    definition: DirectoryCheckDefinition<Lane, SourceRef, Capability>,
    stamp: DirectoryCheckStamp,
    remediation: string,
    details?: Record<string, unknown>,
  ): DirectoryReadinessFinding<Lane, SourceRef, Capability>;

  /**
   * The requirement applies here but this run never exercised it.
   *
   * `reason` is not optional, and that is the point: an unevaluated
   * requirement with no stated reason is indistinguishable from a bug, and it
   * is what makes the lane's `incomplete` status actionable rather than
   * mysterious.
   */
  notEvaluated(
    definition: DirectoryCheckDefinition<Lane, SourceRef, Capability>,
    stamp: DirectoryCheckStamp,
    reason: string,
    details?: Record<string, unknown>,
  ): DirectoryReadinessFinding<Lane, SourceRef, Capability>;

  /**
   * The requirement cannot apply to THIS target — an app-only rule against a
   * server with no apps, an archive rule against a submission with no archive.
   *
   * Distinct from `notEvaluated` in exactly the way `not-applicable` is
   * distinct from `could-not-run` in the suites: nothing was left unverified.
   */
  notApplicable(
    definition: DirectoryCheckDefinition<Lane, SourceRef, Capability>,
    stamp: DirectoryCheckStamp,
    reason: string,
  ): DirectoryReadinessFinding<Lane, SourceRef, Capability>;

  /** A statement that carries no pass/fail meaning — badges, observations. */
  informational(
    definition: DirectoryCheckDefinition<Lane, SourceRef, Capability>,
    stamp: DirectoryCheckStamp,
    details?: Record<string, unknown>,
    note?: string,
  ): DirectoryReadinessFinding<Lane, SourceRef, Capability>;
}

export interface DirectoryFindingConstructorOptions {
  /**
   * Stamped onto every finding these constructors build.
   *
   * Bumped when a check's SEMANTICS change, not when the SDK version does: two
   * grades of the same target under the same policy snapshot should be
   * comparable, and tying this to the package version would make every
   * unrelated release look like a re-audit.
   */
  engineVersion: string;
}

export function createFindingConstructors<
  Lane extends string,
  SourceRef,
  Capability extends string,
>(
  options: DirectoryFindingConstructorOptions,
): DirectoryFindingConstructors<Lane, SourceRef, Capability> {
  type Definition = DirectoryCheckDefinition<Lane, SourceRef, Capability>;
  type Finding = DirectoryReadinessFinding<Lane, SourceRef, Capability>;

  function base(
    definition: Definition,
    stamp: DirectoryCheckStamp,
  ): Omit<Finding, "status"> {
    return {
      id: definition.id,
      title: definition.title,
      lane: definition.lane,
      class: definition.class,
      source: definition.source,
      provenance: definition.provenance,
      intrusiveness: definition.intrusiveness ?? "read-only",
      requiresCapabilities: definition.requiresCapabilities,
      evaluatedAt: stamp.evaluatedAt,
      engineVersion: options.engineVersion,
    };
  }

  return {
    satisfied(definition, stamp, details) {
      return { ...base(definition, stamp), status: "satisfied", details };
    },
    violated(definition, stamp, remediation, details) {
      return {
        ...base(definition, stamp),
        status: "violated",
        remediation,
        details,
      };
    },
    notEvaluated(definition, stamp, reason, details) {
      return {
        ...base(definition, stamp),
        status: "not-evaluated",
        notEvaluatedReason: reason,
        details,
      };
    },
    notApplicable(definition, stamp, reason) {
      return {
        ...base(definition, stamp),
        status: "not-applicable",
        notEvaluatedReason: reason,
      };
    },
    informational(definition, stamp, details, note) {
      return {
        ...base(definition, stamp),
        status: "informational",
        remediation: note,
        details,
      };
    },
  };
}

/**
 * Mark a finding as derived from an existing suite result rather than
 * re-observed.
 *
 * Readiness COMPOSES: re-running an equivalent check would let readiness and
 * the suite disagree about the same server, and the first question anyone asks
 * about a disagreement is which one to believe.
 *
 * Publisher-agnostic, and generic over the finding rather than over the three
 * type parameters, so a publisher's alias keeps its own finding type on both
 * sides of the call instead of widening it to the base shape.
 */
export function derivedFrom<
  Finding extends Pick<
    DirectoryReadinessFinding<string, unknown, string>,
    "derivedFrom"
  >,
>(finding: Finding, ...sources: string[]): Finding {
  return {
    ...finding,
    derivedFrom: [...(finding.derivedFrom ?? []), ...sources],
  };
}
