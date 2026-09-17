import {
  PREDICATE_KIND_LABELS,
  isKnownPredicateKind,
} from "@/shared/predicate-kinds";
import type {
  SwarmSessionLifecycle,
  SwarmSessionVerdict,
  SwarmSessionVerdictValue,
} from "@mcpjam/sdk/contract";
const tones = {
  neutral: "text-muted-foreground",
  positive: "text-success",
  negative: "text-destructive",
  warning: "text-warning-foreground",
} as const;
export function lifecycleChip(lifecycle: SwarmSessionLifecycle) {
  return {
    label: (
      {
        pending: "Pending",
        running: "Running",
        ran: "Ran",
        broke: "Broke",
        limited: "Limited",
        withdrawn: "Withdrawn",
      } as const
    )[lifecycle],
    tone: tones.neutral,
  };
}
export function verdictBadge(verdict?: SwarmSessionVerdict) {
  if (!verdict) return { label: "Not graded", tone: tones.neutral };
  if (verdict.verdict === "notEstablished") {
    return {
      label: ["queued", "running"].includes(verdict.grading.state)
        ? "Grading"
        : verdict.grading.state === "unavailable"
        ? "Couldn't grade"
        : "Not graded",
      tone: tones.neutral,
    };
  }
  if (verdict.verdict === "inconclusive")
    return { label: "Couldn't grade", tone: tones.warning };
  return runVerdictBadge(verdict.verdict);
}
export function runVerdictBadge(verdict: SwarmSessionVerdictValue) {
  return {
    passed: { label: "Passed", tone: tones.positive },
    failed: { label: "Failed", tone: tones.negative },
    inconclusive: { label: "Inconclusive", tone: tones.warning },
    notEstablished: { label: "Not established", tone: tones.neutral },
  }[verdict];
}

export function observationLabel(kind: string) {
  return isKnownPredicateKind(kind)
    ? PREDICATE_KIND_LABELS[kind]
    : "Check observation";
}
