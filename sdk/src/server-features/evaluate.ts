/**
 * `evaluateServerFeatures`: catalog + evidence for one capture context →
 * one user-facing state per feature, and per-card and per-family counts.
 *
 * Precedence per feature (engineering spec v0.4, "User state precedence"):
 *
 *   not applicable (a rule says so, or the feature was removed at this
 *   revision) → Check failed → Supported → Needs a newer version or client
 *   → Could add → Not checked yet.
 *
 * "Could add" needs all of: an `absent` outcome whose coverage basis was
 * captured completely, a server-side owner, a known revision at which the
 * feature applies, and no deprecation. Everything else without evidence is
 * "Not checked yet" with a reason and a next step. Counts are per leaf.
 */

import {
  FEATURE_CARD_IDS,
  FEATURE_FAMILY_IDS,
  FEATURE_USER_STATES,
  type CoverageKey,
  type CoverageState,
  type DeclaredSurface,
  type EvidenceSource,
  type FeatureAssessment,
  type FeatureCardId,
  type FeatureDefinition,
  type FeatureEvidence,
  type FeatureFamilyId,
  type FeatureGroupSummary,
  type FeatureRuleOutcome,
  type FeatureStateCounts,
  type FeatureUserState,
  type ProbeSurface,
  type ServerFeatureEvaluation,
  type ServerFeatureEvidenceInput,
} from "./types.js";
import { featureFamily } from "./families.js";
import {
  featureApplicability,
  featureMarkers,
  isDeprecatedAt,
  isKnownFeatureVersion,
} from "./applicability.js";
import { featuresForCheck } from "./check-map/index.js";
import { computeCaptureContextHash } from "./context.js";
import { isConformanceCheckRef } from "./check-evidence.js";
import { nextStepFor } from "./next-step.js";

const SERVER_SIDE_OWNERS = new Set(["server", "authorization-server"]);

/** Strongest first: what the source chip shows when several agree. */
const SOURCE_STRENGTH: readonly EvidenceSource[] = [
  "checked",
  "observed",
  "probed",
  "oauth-flow",
  "declared",
  "detected",
];

/**
 * The chip names what the evidence shows, not how MCPJam fetched it: a probe
 * that reads a listing or a metadata document found a declaration.
 */
function presentSource(
  channel: RuleEvidenceArgs["source"],
  via: Extract<NonNullable<FeatureRuleOutcome>, { kind: "present" }>["via"],
): EvidenceSource {
  if (via === "detected") return "detected";
  if (via === "advertised") return "declared";
  return channel;
}

function emptyCounts(): Record<FeatureUserState, number> {
  return Object.fromEntries(
    FEATURE_USER_STATES.map((state) => [state, 0]),
  ) as Record<FeatureUserState, number>;
}

function basisCoverage(
  surface: DeclaredSurface | undefined,
  basis: readonly CoverageKey[],
): CoverageState {
  if (!surface) return "not-captured";
  let worst: CoverageState = "complete";
  for (const key of basis) {
    const state = surface.coverage[key];
    if (state === "not-captured") return "not-captured";
    if (state === "partial") worst = "partial";
  }
  return worst;
}

/** Runs a rule; a rule that throws is a catalog bug, reported as unknown. */
function runRule<T>(
  rule: ((input: T) => FeatureRuleOutcome) | undefined,
  input: T | undefined,
): FeatureRuleOutcome {
  if (!rule || input === undefined) return null;
  try {
    return rule(input);
  } catch (error) {
    return {
      kind: "unknown",
      reason: `This feature's rule failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function newestProbeAt(probes: ProbeSurface | undefined): number | undefined {
  let newest: number | undefined;
  for (const summary of Object.values(probes ?? {})) {
    if (summary && (newest === undefined || summary.at > newest))
      newest = summary.at;
  }
  return newest;
}

interface RuleEvidenceArgs {
  feature: FeatureDefinition;
  outcome: FeatureRuleOutcome;
  source: "declared" | "probed" | "oauth-flow";
  capturedAt?: number;
  contextHash?: string;
  surface?: DeclaredSurface;
}

function evidenceFromRule(args: RuleEvidenceArgs): FeatureEvidence | null {
  const { outcome, feature } = args;
  if (!outcome) return null;
  const base = {
    featureId: feature.id,
    provenance: args.source === "declared" ? "declared" : "wire",
    intrusiveness: args.source === "probed" ? "read-only" : "passive",
    capturedAt: args.capturedAt,
    contextHash: args.contextHash,
  } as const;
  switch (outcome.kind) {
    case "present":
      return {
        ...base,
        source: presentSource(args.source, outcome.via),
        outcome: "present",
        coverage: "complete",
        detail: outcome.detail,
        count: outcome.count,
      };
    case "absent":
      return {
        ...base,
        source: args.source,
        outcome: "absent",
        coverage:
          args.source === "declared"
            ? basisCoverage(args.surface, outcome.basis)
            : "complete",
        detail: outcome.detail,
      };
    case "unknown":
      return {
        ...base,
        source: args.source,
        outcome: "unknown",
        coverage: "partial",
        detail: outcome.reason,
      };
    case "not-applicable":
      return {
        ...base,
        source: args.source,
        outcome: "not-applicable",
        coverage: "complete",
        detail: outcome.reason,
      };
  }
}

function collectEvidence(
  feature: FeatureDefinition,
  input: ServerFeatureEvidenceInput,
  contextHash: string | undefined,
): FeatureEvidence[] {
  const evidence: FeatureEvidence[] = [];
  const push = (entry: FeatureEvidence | null) => {
    if (entry) evidence.push(entry);
  };
  const rules = feature.assessment;
  const surface = input.declared?.surface;

  push(
    evidenceFromRule({
      feature,
      outcome: runRule(rules.declared, surface),
      source: "declared",
      capturedAt: input.declared?.capturedAt,
      contextHash,
      surface,
    }),
  );
  push(
    evidenceFromRule({
      feature,
      outcome: runRule(rules.probed, input.probes),
      source: "probed",
      capturedAt: newestProbeAt(input.probes),
      contextHash,
    }),
  );
  push(
    evidenceFromRule({
      feature,
      outcome: runRule(rules.oauthFlow, input.oauthFlow),
      source: "oauth-flow",
      capturedAt: input.oauthFlow?.completedAt,
      contextHash,
    }),
  );

  // Read-only checks graded by background probes.
  for (const summary of Object.values(input.probes ?? {})) {
    for (const [ref, status] of Object.entries(summary?.checks ?? {})) {
      if (!summary || !isConformanceCheckRef(ref)) continue;
      if (!featuresForCheck(ref).includes(feature.id)) continue;
      if (status === undefined || status === "skipped") continue;
      evidence.push({
        featureId: feature.id,
        source: "probed",
        outcome: status === "failed" ? "failed" : "present",
        provenance: "wire",
        intrusiveness: "read-only",
        coverage: "complete",
        capturedAt: summary.at,
        contextHash,
        detail: status === "warned" ? "Passed with warnings." : undefined,
        ref: { probeId: summary.probeId, check: ref },
      });
    }
  }

  for (const observation of input.observations ?? []) {
    if (observation.featureId !== feature.id) continue;
    evidence.push({
      featureId: feature.id,
      source: "observed",
      outcome: "present",
      provenance: observation.lastSource === "apps-bridge" ? "browser" : "wire",
      intrusiveness: "passive",
      coverage: "complete",
      capturedAt: observation.lastSeenAt,
      contextHash,
      count: observation.count,
    });
  }

  for (const check of input.checks ?? []) {
    if (!featuresForCheck(check.ref).includes(feature.id)) continue;
    if (check.status === "skipped") continue;
    const sameVersion =
      !check.protocolVersion ||
      !input.context?.protocolVersion ||
      check.protocolVersion === input.context.protocolVersion;
    evidence.push({
      featureId: feature.id,
      source: "checked",
      outcome: !sameVersion
        ? "unknown"
        : check.status === "failed"
          ? "failed"
          : "present",
      provenance: "wire",
      intrusiveness: "side-effecting",
      coverage: "complete",
      capturedAt: check.runAt,
      detail: !sameVersion
        ? `The last run used ${check.protocolVersion}, not ${input.context?.protocolVersion}.`
        : check.status === "warned"
          ? "Passed with warnings."
          : undefined,
      ref: { runId: check.runId, check: check.ref },
    });
  }
  return evidence;
}

function newest(evidence: readonly FeatureEvidence[]): number | undefined {
  let at: number | undefined;
  for (const entry of evidence) {
    if (entry.capturedAt !== undefined && (at === undefined || entry.capturedAt > at))
      at = entry.capturedAt;
  }
  return at;
}

function assess(
  feature: FeatureDefinition,
  input: ServerFeatureEvidenceInput,
  contextHash: string | undefined,
): FeatureAssessment {
  const version =
    input.context?.protocolVersion ?? input.declared?.surface.protocolVersion;
  const evidence = collectEvidence(feature, input, contextHash);
  const markers = featureMarkers(feature, version);
  let applicability = featureApplicability(feature, version);
  const base = {
    featureId: feature.id,
    markers,
    evidence,
    seenAt: newest(evidence),
  };
  const result = (
    state: FeatureUserState,
    extra: Partial<FeatureAssessment> = {},
  ): FeatureAssessment => ({
    ...base,
    applicability,
    state,
    sources: [],
    ...extra,
  });

  const notApplicable = evidence.find((e) => e.outcome === "not-applicable");
  const present = evidence.filter((e) => e.outcome === "present");
  const failed = evidence.find((e) => e.outcome === "failed");

  if (notApplicable && present.length === 0 && !failed) {
    applicability = "not-applicable";
    return result("not-applicable", { reason: notApplicable.detail });
  }
  if (failed) {
    return result("check-failed", {
      sources: [failed.source],
      reason: failed.detail ?? "A conformance check for this feature failed.",
      nextAction: "run-checks",
    });
  }
  if (present.length > 0) {
    const sources = SOURCE_STRENGTH.filter((source) =>
      present.some((e) => e.source === source),
    );
    return result("supported", { sources });
  }
  if (applicability === "removed") {
    return result("not-applicable", {
      reason: `Removed in ${feature.lifecycle.removed}.`,
    });
  }
  if (applicability === "not-yet") {
    return result("needs-newer", {
      reason: `Added in ${feature.lifecycle.introduced}; this connection uses ${version}.`,
      nextAction: "upgrade-version",
    });
  }
  if (!SERVER_SIDE_OWNERS.has(feature.owner)) {
    const unknown = evidence.find((e) => e.outcome === "unknown");
    return result("needs-newer", {
      reason:
        unknown?.detail ??
        `Depends on the ${feature.owner === "identity-provider" ? "identity provider" : feature.owner}, not only the server.`,
    });
  }

  const absent = evidence.find((e) => e.outcome === "absent");
  if (absent && absent.coverage === "complete") {
    // An unknown revision gets no gaps at all, version-independent features
    // included: today's rules are never applied to a revision we have not read.
    if (applicability === "unknown-version" || !isKnownFeatureVersion(version)) {
      return result("not-checked", {
        reason: version
          ? `MCPJam has no rules for protocol version ${version} yet.`
          : "The protocol version is unknown.",
        nextAction: "reconnect",
      });
    }
    const clientExtension = feature.assessment.requiresClientExtension;
    const clientExtensions = input.context?.clientExtensions;
    if (clientExtension && !clientExtensions) {
      return result("not-checked", {
        reason:
          "MCPJam did not record which extensions this client advertised. Reconnect to capture them.",
        nextAction: "reconnect",
      });
    }
    if (clientExtension && !clientExtensions?.includes(clientExtension)) {
      return result("needs-newer", {
        reason: `This client did not advertise ${clientExtension}, and servers may hide this feature from such clients.`,
      });
    }
    if (isDeprecatedAt(feature, version)) {
      return result("not-applicable", {
        reason: `Deprecated in ${feature.lifecycle.deprecated}; not needed for new servers.`,
      });
    }
    return result("could-add", {
      sources: [absent.source],
      reason: feature.optional
        ? absent.detail
        : (absent.detail ?? "The specification requires this."),
    });
  }
  if (absent) {
    return result("not-checked", {
      reason:
        "The captured data was incomplete, so its absence proves nothing. Reconnect to capture it again.",
      nextAction: "reconnect",
    });
  }
  const unknown = evidence.find((e) => e.outcome === "unknown");
  // Setup comes before connecting: connecting without it shows nothing.
  if (feature.assessment.primary === "configured")
    return needsSetup(feature, input, unknown, result);
  if (!input.connected && evidence.length === 0) {
    return result("not-checked", {
      reason: "Connect this server to check it.",
      nextAction: "connect",
    });
  }
  const step = nextStepFor(feature, input);
  return result("not-checked", {
    reason: unknown?.detail ?? step.reason,
    ...(step.nextAction ? { nextAction: step.nextAction } : {}),
  });
}

/**
 * A feature MCPJam can only check after setup. Setup alone proves nothing
 * about the server, so it never makes a feature Supported; the evidence comes
 * from the sign-in that uses it. Setup this MCPJam surface cannot offer, or
 * whose result it cannot record, gets no step.
 */
function needsSetup(
  feature: FeatureDefinition,
  input: ServerFeatureEvidenceInput,
  unknown: FeatureEvidence | undefined,
  result: (
    state: FeatureUserState,
    extra?: Partial<FeatureAssessment>,
  ) => FeatureAssessment,
): FeatureAssessment {
  const setup = feature.assessment.setup;
  if (!setup || !input.setupOffered?.includes(setup)) {
    // Setup this surface cannot offer: another source may still reach it.
    const step = nextStepFor(feature, input);
    return result("not-checked", {
      reason: unknown?.detail ?? step.reason,
      ...(step.nextAction ? { nextAction: step.nextAction } : {}),
    });
  }
  if (!input.configured?.includes(setup)) {
    return result("not-checked", {
      reason: unknown?.detail ?? "Needs setup in MCPJam before it can be checked.",
      nextAction: "set-up",
    });
  }
  // An inconclusive probe is not a connection, so it keeps Connect.
  if (!input.connected) {
    return result("not-checked", {
      reason:
        unknown?.detail ?? "Set up in MCPJam. Connect this server to check it.",
      nextAction: "connect",
    });
  }
  // Reconnecting with saved tokens records nothing; only a new sign-in does,
  // so the way to record it stays even beside an inconclusive probe.
  const signIn =
    "Set up in MCPJam. Reconnect the account from the Auth tab to record the result.";
  return result("not-checked", {
    reason: unknown?.detail ? `${unknown.detail} ${signIn}` : signIn,
  });
}

const PARENT_STATE_ORDER: readonly FeatureUserState[] = [
  "check-failed",
  "supported",
  "could-add",
  "needs-newer",
  "not-checked",
  "not-applicable",
];

/**
 * A parent without evidence of its own takes the strongest child state, and
 * the sources of the children in that state, so its chip says what they say.
 */
function rollUpParent(
  own: FeatureAssessment,
  children: readonly FeatureAssessment[],
): FeatureAssessment {
  if (children.length === 0 || own.evidence.length > 0) return own;
  const state =
    PARENT_STATE_ORDER.find((candidate) =>
      children.some((child) => child.state === candidate),
    ) ?? own.state;
  if (state === own.state) return own;
  const rolled = { ...own, state, reason: undefined, nextAction: undefined };
  if (state !== "supported") return rolled;
  const sources = SOURCE_STRENGTH.filter((source) =>
    children.some(
      (child) => child.state === "supported" && child.sources.includes(source),
    ),
  );
  return { ...rolled, sources };
}

export function evaluateServerFeatures(
  catalog: readonly FeatureDefinition[],
  input: ServerFeatureEvidenceInput,
): ServerFeatureEvaluation {
  const contextHash = input.context
    ? computeCaptureContextHash(input.context)
    : undefined;
  const assessments: Record<string, FeatureAssessment> = {};
  const childrenOf = new Map<string, string[]>();
  for (const feature of catalog) {
    assessments[feature.id] = assess(feature, input, contextHash);
    if (feature.parent) {
      const siblings = childrenOf.get(feature.parent) ?? [];
      siblings.push(feature.id);
      childrenOf.set(feature.parent, siblings);
    }
  }
  // Children always follow their parent, so walking backwards settles
  // grandchildren before their ancestors.
  for (const feature of [...catalog].reverse()) {
    const children = childrenOf.get(feature.id);
    if (!children) continue;
    assessments[feature.id] = rollUpParent(
      assessments[feature.id],
      children.map((id) => assessments[id]),
    );
  }

  const totals = emptyCounts();
  const cardCounts = new Map<FeatureCardId, Record<FeatureUserState, number>>();
  const familyCounts = new Map<
    FeatureFamilyId,
    Record<FeatureUserState, number>
  >();
  const cardLeaves = new Map<FeatureCardId, number>();
  const familyLeaves = new Map<FeatureFamilyId, number>();
  for (const feature of catalog) {
    if (childrenOf.has(feature.id)) continue;
    const state = assessments[feature.id].state;
    const card = featureFamily(feature.family).card;
    totals[state] += 1;
    const cardTally = cardCounts.get(card) ?? emptyCounts();
    cardTally[state] += 1;
    cardCounts.set(card, cardTally);
    const familyTally = familyCounts.get(feature.family) ?? emptyCounts();
    familyTally[state] += 1;
    familyCounts.set(feature.family, familyTally);
    cardLeaves.set(card, (cardLeaves.get(card) ?? 0) + 1);
    familyLeaves.set(feature.family, (familyLeaves.get(feature.family) ?? 0) + 1);
  }

  const group = <Id extends string>(
    id: Id,
    counts: FeatureStateCounts | undefined,
    leafCount: number | undefined,
  ): FeatureGroupSummary<Id> => ({
    id,
    counts: counts ?? emptyCounts(),
    leafCount: leafCount ?? 0,
  });

  return {
    context: input.context,
    contextHash,
    assessments,
    cards: FEATURE_CARD_IDS.map((id) =>
      group(id, cardCounts.get(id), cardLeaves.get(id)),
    ),
    families: FEATURE_FAMILY_IDS.map((id) =>
      group(id, familyCounts.get(id), familyLeaves.get(id)),
    ),
    totals,
  };
}
