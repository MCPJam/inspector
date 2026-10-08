import {
  swarmVerdictLabel,
  swarmVerdictValueLabel,
  swarmLifecycleLabel,
} from "@mcpjam/sdk/contract";
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
  return { label: swarmLifecycleLabel(lifecycle), tone: tones.neutral };
}
export function verdictBadge(verdict?: SwarmSessionVerdict) {
  return {
    label: swarmVerdictLabel(verdict),
    tone: verdict ? runVerdictBadge(verdict.verdict).tone : tones.neutral,
  };
}
export function runVerdictBadge(verdict: SwarmSessionVerdictValue) {
  return {
    label: swarmVerdictValueLabel(verdict),
    tone: {
      passed: tones.positive,
      failed: tones.negative,
      inconclusive: tones.warning,
      notEstablished: tones.neutral,
    }[verdict],
  };
}

export function observationLabel(kind: string) {
  return isKnownPredicateKind(kind) ? PREDICATE_KIND_LABELS[kind] : "Evaluator";
}
