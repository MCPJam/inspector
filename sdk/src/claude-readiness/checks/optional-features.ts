/**
 * The optional-features lane: capability BADGES, not requirements.
 *
 * The distinction is the whole module. Lazy authentication and
 * enterprise-managed auth are features a connector may offer; a connector that
 * offers neither is not defective, and grading their absence would tell
 * submitters to build things Anthropic never asked them for. So nothing here
 * can move a lane's status — the findings are `experimental-feature`, which
 * `decideLaneStatus` ignores by construction, and the badges carry the actual
 * signal.
 *
 * DEPTH ONLY WHEN CLAIMED OR SELECTED. Establishing that lazy auth genuinely
 * works means driving a protected call and watching the challenge arrive
 * mid-session, and establishing enterprise-managed auth means having an
 * enterprise tenant. Doing either speculatively against every server would
 * spend real requests to answer a question nobody asked. So an unclaimed,
 * undetected feature reports `not-evaluated` and says so, rather than
 * reporting `unsupported` — which would be a claim this run did not earn.
 *
 * Pure data. No transport.
 */

import { claudePolicySource } from "../manifest.js";
import type {
  ClaudeCapabilityBadge,
  ClaudeReadinessFinding,
} from "../types.js";
import type { ClaudeAuthEvidence } from "./auth.js";
import {
  informational,
  notEvaluated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

const LAZY_AUTH: ClaudeCheckDefinition = {
  id: "claude.features.lazy-authentication",
  title: "Lazy authentication",
  lane: "optional-features",
  class: "experimental-feature",
  source: claudePolicySource("lazy-authentication", "§Overview"),
  provenance: "wire",
};

const ENTERPRISE_MANAGED_AUTH: ClaudeCheckDefinition = {
  id: "claude.features.enterprise-managed-auth",
  title: "Enterprise-managed authentication",
  lane: "optional-features",
  class: "experimental-feature",
  source: claudePolicySource("enterprise-managed-auth", "§Overview"),
  provenance: "declared",
  intrusiveness: "passive",
};

export interface ClaudeOptionalFeatureEvidence {
  auth: ClaudeAuthEvidence;
  /**
   * Features the submitter claimed. A claim is what unlocks depth evaluation;
   * it is never itself the evidence.
   */
  claimedFeatures?: {
    lazyAuthentication?: boolean;
    enterpriseManagedAuth?: boolean;
  };
  /**
   * Set when the run actually drove a protected call after an unauthenticated
   * one succeeded — the only observation that establishes lazy auth rather
   * than inferring it.
   */
  lazyAuthProbe?: {
    unauthenticatedCallSucceeded: boolean;
    protectedCallChallenged: boolean;
  };
}

export interface ClaudeOptionalFeatureOutput {
  findings: ClaudeReadinessFinding[];
  badges: ClaudeCapabilityBadge[];
}

export function runClaudeOptionalFeatureChecks(
  evidence: ClaudeOptionalFeatureEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeOptionalFeatureOutput {
  const findings: ClaudeReadinessFinding[] = [];
  const badges: ClaudeCapabilityBadge[] = [];

  // ── Lazy authentication ──────────────────────────────────────────────
  const probe = evidence.lazyAuthProbe;
  const claimed = evidence.claimedFeatures?.lazyAuthentication === true;
  const servedWithoutCredentials =
    evidence.auth.unauthenticated?.servedWithoutCredentials === true;
  const publishesChallenge =
    evidence.auth.prm?.discoveredVia !== undefined &&
    evidence.auth.prm.discoveredVia !== "not-found";

  if (probe) {
    const works =
      probe.unauthenticatedCallSucceeded && probe.protectedCallChallenged;
    badges.push({
      id: LAZY_AUTH.id,
      title: LAZY_AUTH.title,
      state: works ? "supported" : "unsupported",
      detail: works
        ? "an unauthenticated call succeeded and a protected one was challenged"
        : probe.unauthenticatedCallSucceeded
          ? "unauthenticated calls succeed, but no protected call produced a challenge"
          : "the server challenges before any call succeeds",
      provenance: "wire",
    });
    findings.push(informational(LAZY_AUTH, stamp, { probe }));
  } else if (servedWithoutCredentials && publishesChallenge) {
    // Consistent with lazy auth and not proof of it: a server that serves
    // everything and publishes metadata it never enforces looks identical from
    // here. `claimed` is the honest state for a signal that has not been driven.
    badges.push({
      id: LAZY_AUTH.id,
      title: LAZY_AUTH.title,
      state: "claimed",
      detail:
        "the server answered unauthenticated and still publishes resource metadata, which is consistent with lazy auth but was not driven",
      provenance: "wire",
    });
    findings.push(
      notEvaluated(
        LAZY_AUTH,
        stamp,
        "lazy authentication is consistent with what this run saw, but establishing it means driving a protected call, which this run did not do",
      ),
    );
  } else if (claimed) {
    badges.push({
      id: LAZY_AUTH.id,
      title: LAZY_AUTH.title,
      state: "claimed",
      detail: "declared by the submitter; not verified by this run",
      provenance: "declared",
    });
    findings.push(
      notEvaluated(
        LAZY_AUTH,
        stamp,
        "the submitter claims lazy authentication; verifying it requires driving a protected call",
      ),
    );
  } else {
    // NOT `unsupported`. Never looking is not the same as looking and finding
    // nothing, and a badge that says "unsupported" on the strength of not
    // having checked is a false statement about someone's product.
    badges.push({
      id: LAZY_AUTH.id,
      title: LAZY_AUTH.title,
      state: "not-evaluated",
      detail: "neither claimed nor detected, so it was not evaluated in depth",
      provenance: "wire",
    });
    findings.push(
      notEvaluated(
        LAZY_AUTH,
        stamp,
        "lazy authentication was neither claimed nor detected, so no depth evaluation was attempted",
      ),
    );
  }

  // ── Enterprise-managed authentication ────────────────────────────────
  const emaClaimed = evidence.claimedFeatures?.enterpriseManagedAuth === true;
  badges.push({
    id: ENTERPRISE_MANAGED_AUTH.id,
    title: ENTERPRISE_MANAGED_AUTH.title,
    state: emaClaimed ? "claimed" : "not-evaluated",
    detail: emaClaimed
      ? "declared by the submitter; verifying it requires an enterprise tenant this run does not have"
      : "not claimed, and it cannot be detected from an unauthenticated probe",
    provenance: "declared",
  });
  findings.push(
    notEvaluated(
      ENTERPRISE_MANAGED_AUTH,
      stamp,
      emaClaimed
        ? "enterprise-managed auth is claimed; verifying it requires an enterprise tenant and managed credentials"
        : "enterprise-managed auth leaves no trace on an unauthenticated probe and was not claimed",
    ),
  );

  return { findings, badges };
}
