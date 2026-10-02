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

import type { DirectoryLazyAuthProbeEvidence } from "../../directory-readiness/lazy-auth.js";
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
   * Set when the run actually drove a public and a protected call without
   * credentials — the only observation that establishes lazy auth rather
   * than inferring it.
   */
  lazyAuthProbe?: DirectoryLazyAuthProbeEvidence;
}

/** What the probe established, against Claude's documented trigger. */
type LazyAuthVerdict =
  | { state: "supported" | "unsupported"; detail: string }
  /** The probe ran and established neither answer; say why. */
  | { state: "undetermined"; detail: string };

/**
 * Read the probe against CLAUDE'S trigger, not "any 401".
 *
 * Claude starts sign-in only when the request itself fails with HTTP 401 and
 * a `WWW-Authenticate` header. So `supported` needs exactly that on the
 * protected call — the `challengeHeader === "bearer"` facet — AND a public
 * call that was served, because a server that refuses every call is not
 * lazy, however well-formed its challenge. A headerless 401, and a `_meta`
 * challenge on a 200 `isError` result, are both `unsupported` for Claude, and
 * the detail says why so the submitter is not left guessing.
 */
function judgeLazyAuthProbe(
  probe: DirectoryLazyAuthProbeEvidence,
): LazyAuthVerdict {
  if (!probe.attempted) {
    return {
      state: "undetermined",
      detail: `the lazy-auth probe was requested but did not run: ${probe.reason ?? "it was refused"}`,
    };
  }
  const initialize = probe.initialize;
  if (initialize && !initialize.ok) {
    return initialize.unreachable
      ? {
          state: "undetermined",
          detail: "the probe's anonymous initialize could not be reached",
        }
      : {
          state: "unsupported",
          detail: `the server challenges before any call succeeds (anonymous initialize answered ${initialize.status ?? "an error"})`,
        };
  }

  const publicCall = probe.publicCall;
  // The probe sends `{}`. A tool that rejects that never reached its
  // authorization decision, so its refusal is not evidence either way.
  if (publicCall?.invalidArguments) {
    return {
      state: "undetermined",
      detail: `the public tool "${publicCall.toolName}" rejected the probe's empty arguments before any authorization decision; name a public read-only tool that takes no required arguments`,
    };
  }
  if (publicCall && publicCall.outcome !== "unreachable" && publicCall.outcome !== "succeeded") {
    return {
      state: "unsupported",
      detail: `the public tool "${publicCall.toolName}" was refused without credentials (${publicCall.outcome}${publicCall.status ? `, HTTP ${publicCall.status}` : ""})`,
    };
  }

  const call = probe.protectedCall;
  if (!call || call.outcome === "unreachable") {
    return {
      state: "undetermined",
      detail: call
        ? `the protected call to "${call.toolName}" could not be reached`
        : `no protected call was made: ${probe.protectedCallSkipped ?? "no protected tool was selected"}`,
    };
  }
  if (call.outcome === "succeeded") {
    return {
      state: "undetermined",
      detail: `"${call.toolName}" ran without credentials, so it is not a protected tool; name one that requires sign-in`,
    };
  }
  if (call.invalidArguments) {
    return {
      state: "undetermined",
      detail: `the protected tool "${call.toolName}" rejected the probe's empty arguments before any authorization decision; name a protected read-only tool that takes no required arguments`,
    };
  }

  const bearer401 =
    call.outcome === "unauthorized" &&
    call.challenge?.facets.challengeHeader === "bearer";
  if (!bearer401) {
    const what =
      call.outcome === "unauthorized"
        ? "answered HTTP 401 without a WWW-Authenticate: Bearer header"
        : call.challenge?.source === "tool_result_meta"
          ? 'answered with a 200 isError result carrying _meta["mcp/www_authenticate"]'
          : `answered ${call.outcome}${call.status ? ` (HTTP ${call.status})` : ""}`;
    return {
      state: "unsupported",
      detail: `the protected tool "${call.toolName}" ${what}. Claude starts sign-in only on HTTP 401 with WWW-Authenticate; a 200 isError result is an ordinary tool failure to Claude.`,
    };
  }

  if (!publicCall || publicCall.outcome !== "succeeded") {
    return {
      state: "undetermined",
      detail: publicCall
        ? `the protected call was challenged correctly, but the public call to "${publicCall.toolName}" could not be reached`
        : `the protected call was challenged correctly, but no public call was made: ${probe.publicCallSkipped ?? "no public tool was selected"}`,
    };
  }

  return {
    state: "supported",
    detail: `an unauthenticated call to "${publicCall.toolName}" was served, and one to "${call.toolName}" was refused with HTTP 401 and a WWW-Authenticate: Bearer challenge`,
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

  const verdict = probe ? judgeLazyAuthProbe(probe) : undefined;

  if (verdict && verdict.state !== "undetermined") {
    badges.push({
      id: LAZY_AUTH.id,
      title: LAZY_AUTH.title,
      state: verdict.state,
      detail: verdict.detail,
      provenance: "wire",
    });
    findings.push(
      informational(
        LAZY_AUTH,
        stamp,
        {
          probe: summarizeProbe(probe!),
          protocolVersion: probe!.protocolVersion,
          eraNote: probe!.eraNote,
        },
        verdict.detail,
      ),
    );
  } else if (verdict) {
    // The probe ran and could not decide. A claim still counts as a claim,
    // and the probe's reason is the most useful sentence to show.
    badges.push({
      id: LAZY_AUTH.id,
      title: LAZY_AUTH.title,
      state: claimed ? "claimed" : "not-evaluated",
      detail: claimed
        ? `declared by the submitter; not verified by this run: ${verdict.detail}`
        : verdict.detail,
      provenance: claimed ? "declared" : "wire",
    });
    findings.push(
      notEvaluated(LAZY_AUTH, stamp, verdict.detail, {
        probe: summarizeProbe(probe!),
      }),
    );
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

/** The probe, reduced to what a reader of the finding needs. */
function summarizeProbe(
  probe: DirectoryLazyAuthProbeEvidence,
): Record<string, unknown> {
  const call = (entry: DirectoryLazyAuthProbeEvidence["publicCall"]) =>
    entry
      ? {
          toolName: entry.toolName,
          selectedBy: entry.selectedBy,
          outcome: entry.outcome,
          status: entry.status,
          invalidArguments: entry.invalidArguments,
          challengeSource: entry.challenge?.source,
          facets: entry.challenge?.facets,
        }
      : undefined;
  return {
    initialize: probe.initialize
      ? { ok: probe.initialize.ok, status: probe.initialize.status }
      : undefined,
    publicCall: call(probe.publicCall),
    publicCallSkipped: probe.publicCallSkipped,
    protectedCall: call(probe.protectedCall),
    protectedCallSkipped: probe.protectedCallSkipped,
    rediscovery: probe.rediscovery,
  };
}
