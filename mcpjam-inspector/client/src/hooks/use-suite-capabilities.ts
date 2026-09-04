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
  permissions: Record<SuiteCapabilityAction, boolean>;
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
