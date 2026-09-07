/**
 * Shared sentences for the suite-settings draft and a few live rows.
 *
 * Config vocabulary only. Nothing here describes a run, so the words
 * "not measured" never appear. Policy sentences are suite defaults and
 * never claim a case uses them.
 */

import type { Predicate } from "@mcpjam/sdk/predicates";
import type { SuiteGatePolicyV1 } from "@mcpjam/sdk/contract";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { OUTAGE_POLICY_LABELS } from "@/components/settings/github-checks-outage-policy";
import type { SuiteVerdictPolicyDefaults } from "./suite-settings-draft";
import type { EvalJudgeConfig, EvalJudgeRubric } from "./types";
import type {
  GithubCheckConnectionStatus,
  GithubCheckOutagePolicy,
  GithubChecksAvailability,
} from "@/hooks/useGithubChecksSettings";

export type SettingSummary = {
  state: "ready" | "loading" | "unavailable";
  text: string;
  detail?: string;
  tone: "set" | "empty" | "gap" | "attention";
  chips?: Array<{ label: string; tone?: "set" | "off" | "on" | "attention" }>;
  cta?: string;
};

/** A stored FRACTION as the percent a person reads. */
export function formatFraction(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function describePredicates(list: Predicate[]): string {
  if (list.length === 0) return "None";
  const counts = new Map<string, number>();
  for (const predicate of list) {
    const label =
      PREDICATE_KIND_LABELS[
        predicate.type as keyof typeof PREDICATE_KIND_LABELS
      ] ?? predicate.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind))
    .join(", ");
}

/**
 * Review-dialog sentence for a judge config. Absent is "Not configured",
 * not "Off" — an unset `enabled` resolves to on.
 */
export function describeJudge(value: EvalJudgeConfig | undefined): string {
  const goal = value?.goalCompletion;
  if (!goal) return "Not configured";
  if (goal.enabled === false) return "Off";
  const bits = [goal.role === "gating" ? "Gating" : "Advisory"];
  if (goal.autoRun) bits.push("runs automatically");
  if (goal.judgeModel) bits.push(goal.judgeModel);
  if (goal.threshold !== undefined) {
    bits.push(`threshold ${Math.round(goal.threshold * 100)}%`);
  }
  return bits.join(", ");
}

/** The three validity ceilings, as percents where they are fractions. */
export function describeValidity(
  defaults: SuiteVerdictPolicyDefaults | undefined,
): string {
  const validity = defaults?.validity;
  if (!validity) return "Contract defaults";
  const parts: string[] = [];
  if (validity.minEligibleTrials !== undefined) {
    parts.push(`at least ${validity.minEligibleTrials} trials`);
  }
  if (validity.minCompletionRate !== undefined) {
    parts.push(`${formatFraction(validity.minCompletionRate)} completed`);
  }
  if (validity.maxEvaluatorErrorRate !== undefined) {
    parts.push(
      `at most ${formatFraction(validity.maxEvaluatorErrorRate)} grader errors`,
    );
  }
  return parts.length > 0 ? parts.join(", ") : "Contract defaults";
}

function describeGateBaseline(
  baseline: SuiteGatePolicyV1["baseline"],
): string | undefined {
  if (!baseline) return undefined;
  if (baseline.kind === "run") {
    return baseline.runId ? `Run ${baseline.runId}` : "A specific run";
  }
  if (baseline.kind === "commit_sha") {
    return baseline.commitSha
      ? `Commit ${baseline.commitSha}`
      : "A specific commit";
  }
  return "Previous run";
}

/**
 * Review-dialog sentence for a stored quality-gate policy.
 *
 * Enumerates the actual baseline and active conditions. Numeric `0` is a
 * configured threshold, not "none".
 */
export function describeGatePolicy(
  policy: SuiteGatePolicyV1 | undefined,
): string {
  if (!policy) return "None";
  const parts: string[] = [];
  const baseline = describeGateBaseline(policy.baseline);
  if (baseline) parts.push(baseline);
  if (policy.maximumPassRateDrop !== undefined) {
    parts.push(`${formatFraction(policy.maximumPassRateDrop)} allowed drop`);
  }
  if (policy.noDeterministicRegressions === true) {
    parts.push("no deterministic regressions");
  }
  if (policy.maximumP95LatencyIncreaseMs !== undefined) {
    parts.push(`${policy.maximumP95LatencyIncreaseMs}ms p95 increase`);
  }
  if (policy.noGatingScoreErrors === true) {
    parts.push("any gating scorer errored");
  }
  return parts.length > 0 ? parts.join(", ") : "None";
}

export function summarizeRubric(rubric: EvalJudgeRubric | undefined): string {
  const criteria = rubric?.criteria ?? [];
  if (criteria.length === 0) return "None";
  return criteria.map((criterion) => criterion.label).join(", ");
}

const CONNECTION_LABEL: Record<GithubCheckConnectionStatus, string> = {
  verified: "connected",
  legacy_unverified: "unverified",
  installation_inactive: "installation inactive",
  repository_access_removed: "access removed",
};

export function summarizeGithubChecks(input: {
  availability: GithubChecksAvailability;
  rows:
    | Array<{
        suiteId: string;
        repoFullName: string;
        enabled: boolean;
        outagePolicy?: GithubCheckOutagePolicy;
        connectionStatus: GithubCheckConnectionStatus;
      }>
    | undefined;
  suiteId: string;
}): SettingSummary {
  if (input.availability === undefined || input.rows === undefined) {
    return {
      state: "loading",
      text: "Loading GitHub Checks…",
      tone: "empty",
    };
  }
  if (input.availability.state === "disabled") {
    return {
      state: "unavailable",
      text: "GitHub Checks is not available for this organization",
      tone: "attention",
    };
  }
  const connected = input.rows.filter((row) => row.suiteId === input.suiteId);
  if (connected.length === 0) {
    return {
      state: "ready",
      text: "No repositories",
      tone: "empty",
      cta: "connect one",
    };
  }
  return {
    state: "ready",
    text: `${connected.length} repositor${connected.length === 1 ? "y" : "ies"}`,
    tone: connected.some(
      (row) => !row.enabled || row.connectionStatus !== "verified",
    )
      ? "attention"
      : "set",
    chips: connected.map((row) => {
      const policy = row.outagePolicy
        ? OUTAGE_POLICY_LABELS[row.outagePolicy]
        : "no policy chosen";
      const activity = row.enabled ? "Active" : "Paused";
      const attention =
        !row.enabled ||
        row.connectionStatus !== "verified" ||
        row.outagePolicy === undefined;
      const connection =
        row.connectionStatus !== "verified"
          ? ` · ${CONNECTION_LABEL[row.connectionStatus]}`
          : "";
      return {
        label: `${row.repoFullName} · ${activity} · ${policy}${connection}`,
        tone: attention ? "attention" : "on",
      };
    }),
  };
}
