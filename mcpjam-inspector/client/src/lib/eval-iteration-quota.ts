import type { EvalIterationQuota } from "@/hooks/use-eval-iteration-quota";

export function formatEvalIterationResetTime(resetsAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

export function getEvalIterationQuotaDisabledReason(
  quota: EvalIterationQuota | undefined
): string | null {
  if (!quota || quota.allowed === null || quota.used < quota.allowed) {
    return null;
  }
  return `Eval iteration limit reached. Resets ${formatEvalIterationResetTime(
    quota.resetsAt
  )}.`;
}

export function getEvalIterationQuotaLabel(
  windowKind: EvalIterationQuota["windowKind"] | undefined
): string {
  if (windowKind === "day") {
    return "Daily eval iterations";
  }
  if (windowKind === "month") {
    return "Monthly eval iterations";
  }
  return "Eval iterations";
}
