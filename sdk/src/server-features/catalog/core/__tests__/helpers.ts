/**
 * Helpers for the core catalog rule tests: run one feature's rule and read
 * the outcome the way the evaluator will.
 */

import type {
  DeclaredSurface,
  FeatureDefinition,
  FeatureRuleOutcome,
  OAuthFlowSummary,
  ProbeSurface,
} from "../../../types.js";
import { CORE_FEATURES } from "../index.js";

export function feature(id: string): FeatureDefinition {
  const found = CORE_FEATURES.find((entry) => entry.id === id);
  if (!found) throw new Error(`No core feature ${id}`);
  return found;
}

export function declared(
  id: string,
  surface: DeclaredSurface
): FeatureRuleOutcome {
  const rule = feature(id).assessment.declared;
  if (!rule) throw new Error(`${id} has no declared rule`);
  return rule(surface);
}

export function probed(id: string, probes: ProbeSurface): FeatureRuleOutcome {
  const rule = feature(id).assessment.probed;
  if (!rule) throw new Error(`${id} has no probe rule`);
  return rule(probes);
}

export function fromOAuthFlow(
  id: string,
  summary: OAuthFlowSummary
): FeatureRuleOutcome {
  const rule = feature(id).assessment.oauthFlow;
  if (!rule) throw new Error(`${id} has no OAuth flow rule`);
  return rule(summary);
}

/**
 * True only when the evaluator could show "Could add": an absent outcome
 * whose every basis key was captured completely.
 */
export function isGap(
  outcome: FeatureRuleOutcome,
  surface: DeclaredSurface
): boolean {
  return (
    outcome?.kind === "absent" &&
    outcome.basis.every((key) => surface.coverage[key] === "complete")
  );
}

export function kindOf(outcome: FeatureRuleOutcome): string {
  return outcome === null ? "null" : outcome.kind;
}

export function makeOAuthSummary(
  overrides: Partial<OAuthFlowSummary> = {}
): OAuthFlowSummary {
  return {
    completedAt: 1_700_000_000_000,
    issuer: "https://auth.example.com",
    protocolVersion: "2026-07-28",
    registrationStrategy: "cimd",
    resourceIndicatorSent: true,
    scopesRequested: ["read"],
    scopesGranted: ["read"],
    issReturned: true,
    issValidated: true,
    refreshTokenIssued: true,
    ...overrides,
  };
}
