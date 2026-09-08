/**
 * What this person can do with this suite, and why not when they cannot.
 *
 * THE PROBLEM THIS SOLVES. The settings sheet gated three rows on three
 * different answers — a PostHog flag for the computer environment, another for
 * the schedule, a backend availability read for GitHub Checks — and every
 * refusal looked the same: the row was gone. A missing permission, a feature
 * the organization does not have, and a flag service that timed out are three
 * different problems with three different next steps, and a person staring at a
 * page that simply does not mention the thing they were told to configure
 * cannot tell which one they have.
 *
 * The backend now answers all of it at once, with CLOSED reasons, so the sheet
 * can render the row disabled and say why instead of hiding it.
 *
 * WHY NOT `useQuery`. It re-throws a failed query DURING RENDER, and this query
 * has ordinary failure modes: a deployment that predates it (the two repos
 * release independently), and a caller the backend answers `null` for. An
 * unguarded `useQuery` here would take the whole suite page down the first time
 * either happened — which has happened before on this exact surface, and is why
 * `useGithubChecksSettings` carries its warning. So the read goes through
 * `useConvex().query` inside an effect, where a rejection is a value.
 *
 * WHEN THE READ FAILS the answer is `unavailable`, and every caller must treat
 * that as "behave exactly as before this hook existed". Capabilities make a
 * page more honest; they must never make it less usable than the page that had
 * none.
 */

import { useEffect, useState } from "react";
import { useConvex } from "convex/react";

/** Why a gated feature is off. A closed vocabulary, mirrored by hand. */
export type SuiteFeatureDenialReason =
  | "flag_false"
  | "missing_email"
  | "missing_external_id"
  | "missing_organization"
  | "flag_unavailable";

export type SuiteCapabilityAction =
  | "suite.view"
  | "suite.edit"
  | "suite.configure"
  | "suite.delete"
  | "suite.schedule"
  | "suite.environments"
  | "run.launch"
  | "gate.waive"
  | "judge.review";

export type SuiteFeatureGate = {
  enabled: boolean;
  reason?: SuiteFeatureDenialReason;
};

/** Calibration evidence for the suite's CURRENT rubric and judge template. */
export type SuiteJudgeAgreement = {
  reviews: number;
  agreements: number;
  /** `null` at zero reviews — 0/0 is no evidence, not 0% agreement. */
  rate: number | null;
  lowerBound: number | null;
  /**
   * Cohen's kappa over the same blind labels: agreement corrected for what
   * two raters would reach by chance on this corpus's class mix. `null` at
   * zero reviews, or when both raters were constant on one class (undefined,
   * not 1). Reported beside the rate, never gated on; absent on a backend that
   * predates it.
   */
  kappa?: number | null;
  threshold: number;
  minReviews: number;
  eligible: boolean;
  reasons: Array<"insufficient_reviews" | "agreement_below_threshold">;
};

/**
 * Hand-mirrored from `testSuites:getSuiteCapabilities`. There is no codegen
 * between the two repos, so a field renamed on the backend is a runtime
 * `undefined` here rather than a build error — read defensively.
 */
export type SuiteCapabilities = {
  suiteId: string;
  organizationId: string | null;
  /**
   * `baseline.set` is the manage-tier write for stored gate policy. Absent
   * on an older permissions object — treat as not granted.
   */
  permissions: Record<SuiteCapabilityAction, boolean> & {
    "baseline.set"?: boolean;
  };
  /**
   * WHO CONFIGURES THIS SUITE — a sibling of `permissions`, not part of it.
   *
   * `permissions` answers "what does this ROLE allow"; CI ownership is a
   * property of the SUITE, true for an org owner and a guest alike. Keeping
   * them apart is what lets the UI disable a control for ownership and explain
   * it differently from a missing role — the two need different copy and have
   * different remedies.
   *
   * ABSENT on a backend that predates it, and every caller must still lock the
   * suite in that case: `isCiOwnedSuite` on the suite row is the client's own
   * answer, and this block only ADDS the platform's enumeration of what it
   * refuses.
   */
  ownership?: {
    ciOwned: boolean;
    declaredSuiteId: string | null;
    /**
     * The actions the platform refuses, named — the wire's own enumeration,
     * carried through verbatim.
     *
     * NOT what the UI locks on, and deliberately not: every control keys on
     * `ciOwned` (or, on a backend that predates this block, `isCiOwnedSuite`
     * over the suite row), because the lock has to hold when this block is
     * absent and a per-action gate that silently unlocks everything on an older
     * deployment is worse than a coarse one that holds. What the list is good
     * for is saying WHICH write was refused when one is — the refusal carries
     * the same `action` — and for seeing at a glance what a deployment
     * actually enforces.
     */
    lockedActions: string[];
  };
  features: {
    computers: SuiteFeatureGate;
    environments: SuiteFeatureGate;
    skills: SuiteFeatureGate;
    "claude-code-harness": SuiteFeatureGate;
    "codex-harness": SuiteFeatureGate;
    "cursor-harness": SuiteFeatureGate;
    "grading-engine-mode": SuiteFeatureGate;
    /** An env-var kill switch, not a per-org flag: no reason vocabulary. */
    scheduledEvals: { enabled: boolean };
  };
  verdictPolicyV2: {
    deploymentMode: "off" | "shadow" | "enforce";
    suiteMode: string | null;
    canUpgrade: boolean;
  };
  judge: {
    gating: { enabled: boolean; reason?: "not_enabled_on_deployment" };
    role: "advisory" | "gating";
    hasRubric: boolean;
    agreement: SuiteJudgeAgreement;
    acknowledgement: {
      acknowledgedBy: string;
      acknowledgedAt: number;
      judgeTemplateVersion: number;
      current: boolean;
    } | null;
  };
  /**
   * Per-judge identity from C1. Absent on an older backend — every caller
   * then degrades: no Warn control, groundedness template stays null, and
   * calibration is treated as unavailable rather than copied from goal
   * completion.
   */
  judges?: {
    goalCompletion: {
      role: "advisory" | "gating";
      template: { version: number; hash: string };
      execution: "wired";
      calibration: SuiteJudgeAgreement;
    };
    groundedness: {
      role: "advisory";
      template: null;
      execution: "not_wired";
      calibration: "unavailable";
    };
  };
  /**
   * Scorer-authoring capabilities. Absent on a backend that predates A1 —
   * the Role control then degrades to today's read-only Gate chip.
   */
  scorers?: { checkPolicy?: boolean };
  /**
   * Stored quality-gate capabilities. Absent on a backend that predates B2 —
   * the Quality gate rows then disable rather than inventing a write path.
   */
  qualityGate?: {
    storage?: boolean;
    evaluator?: boolean;
    githubEnforcement?: boolean;
    /** Reserved previous-run baseline. A client constant cannot authorize it. */
    previousRunBaseline?: boolean;
  };
  revisionNumber: number | null;
};

export type SuiteCapabilitiesState =
  | { state: "loading"; capabilities: null }
  | { state: "ready"; capabilities: SuiteCapabilities }
  | { state: "unavailable"; capabilities: null };

/**
 * Read one suite's capabilities.
 *
 * `refreshKey` re-asks. The sheet passes the suite's revision number, so a
 * save that changes what the person may do next — acknowledging a judge gate,
 * upgrading the verdict policy — updates the rows rather than leaving them
 * describing the suite as it was when the page loaded.
 */
export function useSuiteCapabilities(
  suiteId: string | null,
  refreshKey?: unknown,
): SuiteCapabilitiesState {
  const convex = useConvex();
  const [state, setState] = useState<SuiteCapabilitiesState>({
    state: "loading",
    capabilities: null,
  });

  useEffect(() => {
    if (!suiteId) {
      setState({ state: "unavailable", capabilities: null });
      return;
    }
    let cancelled = false;
    setState({ state: "loading", capabilities: null });
    void (async () => {
      try {
        const result = await convex.query(
          "testSuites:getSuiteCapabilities" as never,
          { suiteId } as never,
        );
        if (cancelled) return;
        // `null` is the backend's answer for a suite this caller cannot see —
        // 404-never-403, so it cannot be used to discover which ids exist. It
        // is not an error, and it is not a set of capabilities either.
        setState(
          result
            ? {
                state: "ready",
                capabilities: result as unknown as SuiteCapabilities,
              }
            : { state: "unavailable", capabilities: null },
        );
      } catch {
        // Swallowed on purpose, and NOT reported: the ordinary case is a
        // deployment that predates this query, which is the two repos
        // releasing independently rather than a fault. Every caller falls back
        // to the behaviour it had before capabilities existed.
        if (!cancelled) setState({ state: "unavailable", capabilities: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex, suiteId, refreshKey]);

  return state;
}

/**
 * True when this deployment advertised C1's per-judge identity, which is
 * what authorizes a goal-completion Warn control. An older backend has no
 * `judges` map — do not invent severity support from today's `judge` fields.
 */
export function hasJudgeSeverityCapability(
  capabilities: SuiteCapabilities | null | undefined,
): boolean {
  return capabilities?.judges?.goalCompletion != null;
}
