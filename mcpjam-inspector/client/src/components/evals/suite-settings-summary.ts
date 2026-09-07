/**
 * Collapsed-row summaries for the suite-settings ledger.
 *
 * Config vocabulary only. Nothing here describes a run, so the words
 * "not measured" never appear. Policy sentences are suite defaults and
 * never claim a case uses them.
 */

import {
  USER_VALUE_STAGE_LABELS,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { compactModelIdTail, environmentLabel } from "@/lib/environment-label";
import { OUTAGE_POLICY_LABELS } from "@/components/settings/github-checks-outage-policy";
import { PAUSE_COPY, type SuiteSchedule } from "./schedule-editor";
import { formatNextDue } from "./suite-automation-row";
import {
  judgeMode,
  type JudgeMode,
  type StageConfigState,
} from "./suite-grading-model";
import type { SuiteGradingModel } from "./suite-grading-model";
import type {
  SuiteSettingsValues,
  SuiteVerdictPolicyDefaults,
} from "./suite-settings-draft";
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

export function summarizeRubric(rubric: EvalJudgeRubric | undefined): string {
  const criteria = rubric?.criteria ?? [];
  if (criteria.length === 0) return "None";
  return criteria.map((criterion) => criterion.label).join(", ");
}

export function summarizeName(values: SuiteSettingsValues): SettingSummary {
  const name = values.name.trim();
  return {
    state: "ready",
    text: name.length > 0 ? name : "Untitled",
    tone: name.length > 0 ? "set" : "empty",
  };
}

export function summarizePolicy(values: SuiteSettingsValues): SettingSummary {
  if (values.verdictPolicyVersion !== 2) {
    const rate = values.defaultPassCriteria?.minimumPassRate;
    const iterations =
      values.minIterations === undefined ? "off" : String(values.minIterations);
    return {
      state: "ready",
      text: `Minimum accuracy ${rate ?? 100}% · minimum iterations ${iterations}`,
      tone: "set",
      chips: [{ label: "Legacy · suite-wide percent", tone: "set" }],
    };
  }
  const defaults = values.verdictPolicyDefaults;
  const repetitions = defaults?.repetitions ?? 1;
  const threshold = defaults?.passThreshold ?? 1;
  return {
    state: "ready",
    text: `Default ${repetitions} repetition${repetitions === 1 ? "" : "s"} · ${formatFraction(threshold)} pass threshold`,
    detail: "Cases may set their own.",
    tone: "set",
  };
}

export function summarizeValidity(values: SuiteSettingsValues): SettingSummary {
  return {
    state: "ready",
    text: describeValidity(values.verdictPolicyDefaults),
    detail: "Checked before the verdict; a miss is inconclusive, not failed.",
    tone: "set",
  };
}

export function summarizeJudge(judgeConfig: EvalJudgeConfig | undefined): {
  mode: JudgeMode;
  text: string;
  detail?: string;
} {
  const mode = judgeMode(judgeConfig);
  switch (mode) {
    case "off":
      return { mode, text: "Judge off" };
    case "manual":
      return {
        mode,
        text: "Judge on request · advisory",
        detail: "Never changes the verdict.",
      };
    case "automatic":
      return {
        mode,
        text: "Judge runs on every run · advisory",
        detail: "Never changes the verdict.",
      };
    case "gating":
      return { mode, text: "Judge gates the verdict" };
  }
}

export function summarizeChecks(predicates: Predicate[]): SettingSummary {
  const checks = predicates.filter(
    (predicate) =>
      predicate.type !== "tokenBudgetUnder" &&
      predicate.type !== "turnCountUnder",
  );
  if (checks.length === 0) {
    return { state: "ready", text: "None", tone: "empty" };
  }
  return {
    state: "ready",
    text: `${checks.length} check${checks.length === 1 ? "" : "s"} · ${describePredicates(checks)}`,
    tone: "set",
  };
}

export function summarizeComputerEnvironment(input: {
  id: string | undefined;
  computerEnvironments:
    | Array<{
        environmentId: string;
        name: string;
        currentBuild?: { status?: string } | null;
      }>
    | undefined;
  disabledReason?: string;
}): SettingSummary {
  if (input.disabledReason) {
    return {
      state: "unavailable",
      text: input.disabledReason,
      tone: "attention",
    };
  }
  if (input.computerEnvironments === undefined) {
    return {
      state: "loading",
      text: "Loading computer images…",
      tone: "empty",
    };
  }
  if (!input.id) {
    return { state: "ready", text: "Default image", tone: "set" };
  }
  const image = input.computerEnvironments.find(
    (environment) => environment.environmentId === input.id,
  );
  if (!image) {
    return { state: "ready", text: input.id, tone: "set" };
  }
  const notBuilt = image.currentBuild?.status !== "ready";
  return {
    state: "ready",
    text: image.name,
    tone: notBuilt ? "attention" : "set",
    chips: notBuilt ? [{ label: "not built", tone: "attention" }] : undefined,
  };
}

function joinShown(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
}

function runsPerRunAll(count: number): SettingSummary["chips"] {
  return [
    {
      label: `${count} run${count === 1 ? "" : "s"} per Run all`,
      tone: "set",
    },
  ];
}

/**
 * The fan-out matrix in one line: which clients, times which models.
 *
 * TWO MODES, decided by whether this deployment can edit cells (the
 * `modelMatrix` capability) — never by the named-environments feature flag.
 * No cells (no project, or a backend without the matrix): the fan-out axis is
 * `suite.hostAttachments` and the models come from the cases, because a legacy
 * suite has no model axis of its own. Cells: one run per attached environment,
 * each carrying its own client and model. A suite that attaches environments
 * on a backend that cannot edit them says so rather than spinning on a query
 * that will never resolve.
 */
export function summarizeEnvironments(input: {
  suite: {
    environmentIds?: string[];
    hostAttachments?: Array<{ namedHostId: string; hostName: string | null }>;
  };
  environments:
    | Array<{
        environmentId: string;
        hostId: string;
        modelId?: string;
        name?: string;
        origin?: "named" | "adhoc";
      }>
    | undefined;
  /**
   * Can this deployment edit cells (the `modelMatrix` capability), not "is the
   * environments feature flagged on". Default true so older callers keep the
   * environment-mode reading.
   */
  cellsEditable?: boolean;
  /** Distinct model ids across the suite's cases — the legacy model axis. */
  caseModels?: string[];
  hostName?: (hostId: string) => string | undefined;
}): SettingSummary {
  const cellsEditable = input.cellsEditable ?? true;
  const ids = input.suite.environmentIds ?? [];
  const caseModels = (input.caseModels ?? []).map(compactModelIdTail);

  if (!cellsEditable) {
    if (ids.length > 0) {
      return {
        state: "ready",
        text: `${ids.length} environment${ids.length === 1 ? "" : "s"}`,
        detail: "This deployment cannot edit environments.",
        tone: "set",
        chips: runsPerRunAll(ids.length),
      };
    }
    const clients = (input.suite.hostAttachments ?? []).map(
      (attachment) => attachment.hostName ?? attachment.namedHostId,
    );
    if (clients.length === 0) {
      return {
        state: "ready",
        text: "No clients",
        tone: "empty",
        cta: "pick some",
      };
    }
    return {
      state: "ready",
      text: joinShown(clients),
      detail: caseModels.length > 0 ? `× ${joinShown(caseModels)}` : undefined,
      tone: "set",
      chips: runsPerRunAll(clients.length),
    };
  }

  if (input.environments === undefined) {
    return { state: "loading", text: "Loading environments…", tone: "empty" };
  }
  if (ids.length === 0) {
    return {
      state: "ready",
      text: "None",
      tone: "empty",
      cta: "add one",
    };
  }
  const byId = new Map(
    input.environments.map((environment) => [
      environment.environmentId,
      environment,
    ]),
  );
  const rows = ids.map((id) => byId.get(id));
  const names = rows.map((row, index) =>
    row ? environmentLabel(row, { hostName: input.hostName }) : ids[index],
  );
  const hosts = [
    ...new Set(
      rows.flatMap((row) => {
        const name = row ? input.hostName?.(row.hostId) : undefined;
        return name ? [name] : [];
      }),
    ),
  ];
  const models = [
    ...new Set(
      rows.flatMap((row) =>
        row?.modelId ? [compactModelIdTail(row.modelId)] : [],
      ),
    ),
  ];
  return {
    state: "ready",
    text: joinShown(names),
    detail:
      hosts.length > 0 && models.length > 0
        ? `${joinShown(hosts)} × ${joinShown(models)}`
        : undefined,
    tone: "set",
    chips: runsPerRunAll(ids.length),
  };
}

const PAUSE_CHIP: Record<Exclude<SuiteSchedule["state"], "active">, string> = {
  paused_quota: "quota",
  paused_auth: "sign-in",
  paused_failures: "failures",
};

function formatInterval(minutes: number): string {
  if (minutes === 1440) return "day";
  if (minutes === 60) return "hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function summarizeSchedule(input: {
  schedule: SuiteSchedule | undefined;
  nextDueAt?: number;
  ownerName?: string | null;
}): SettingSummary {
  const { schedule, nextDueAt, ownerName } = input;
  const ownerDetail = ownerName ? `Runs as ${ownerName}` : undefined;
  if (!schedule || !schedule.enabled) {
    return { state: "ready", text: "Off", tone: "empty" };
  }
  if (schedule.state !== "active") {
    return {
      state: "ready",
      text: "Paused",
      detail: [PAUSE_COPY[schedule.state], ownerDetail]
        .filter(Boolean)
        .join(" "),
      tone: "attention",
      chips: [{ label: PAUSE_CHIP[schedule.state], tone: "attention" }],
    };
  }
  return {
    state: "ready",
    text: `Every ${formatInterval(schedule.intervalMinutes)} · next ${formatNextDue(nextDueAt)}`,
    detail: ownerDetail,
    tone: "set",
  };
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

function joinStages(stages: UserValueStage[]): string {
  const labels = stages.map((stage) => USER_VALUE_STAGE_LABELS[stage]);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function describeGradingDefaults(
  values: SuiteSettingsValues,
  model: SuiteGradingModel,
  judge: ReturnType<typeof summarizeJudge>,
  states: StageConfigState[],
): string[] {
  void model;
  const sentences: string[] = [];

  if (values.verdictPolicyVersion !== 2) {
    const rate = values.defaultPassCriteria?.minimumPassRate ?? 100;
    sentences.push(
      `A run fails when the suite-wide accuracy is under ${rate}% across all iterations.`,
    );
  } else {
    const threshold = formatFraction(
      values.verdictPolicyDefaults?.passThreshold ?? 1,
    );
    sentences.push(
      `Each case passes when at least ${threshold} of its eligible trials pass; the run fails when any case falls short.`,
    );
    sentences.push("Cases may set their own repetitions and threshold.");
  }

  if (values.verdictPolicyVersion === 2) {
    const validity = values.verdictPolicyDefaults?.validity;
    const trials =
      validity?.minEligibleTrials !== undefined
        ? `at least ${validity.minEligibleTrials} eligible trials`
        : "too few eligible trials";
    const completion =
      validity?.minCompletionRate !== undefined
        ? `under ${formatFraction(validity.minCompletionRate)} completed`
        : "too many incomplete trials";
    const errors =
      validity?.maxEvaluatorErrorRate !== undefined
        ? `more than ${formatFraction(validity.maxEvaluatorErrorRate)} grader errors`
        : "too many grader errors";
    sentences.push(
      `Validity is decided first: a run with ${trials}, ${completion}, or ${errors} is inconclusive, not failed.`,
    );
  }

  const gated = states.filter((state) => state.gates >= 1);
  const gateCount = gated.reduce((sum, state) => sum + state.gates, 0);
  if (gateCount > 0) {
    sentences.push(
      `${gateCount} deterministic gate${gateCount === 1 ? "" : "s"} at ${joinStages(gated.map((state) => state.stage))}.`,
    );
  }
  const gaps = states.filter((state) => state.state === "gap");
  if (gaps.length > 0) {
    const names = joinStages(gaps.map((state) => state.stage));
    const verb = gaps.length === 1 ? "has" : "have";
    sentences.push(`${names} ${verb} no grader.`);
  }

  switch (judge.mode) {
    case "off":
      sentences.push("The judge is off.");
      break;
    case "manual":
      sentences.push(
        "The judge runs only on request and never changes the verdict.",
      );
      break;
    case "automatic":
      sentences.push(
        "The judge scores every run and never changes the verdict.",
      );
      break;
    case "gating":
      sentences.push("The judge gates the verdict.");
      break;
  }

  return sentences;
}
