import type { EvalIterationQuota } from "@/hooks/use-eval-iteration-quota";

export function formatEvalIterationResetTime(resetsAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

export function calculateEvalIterationRequest(
  modelCount: number,
  iterationCount: number
): number {
  return (
    Math.max(1, Math.floor(modelCount)) *
    Math.max(1, Math.floor(iterationCount))
  );
}

export function getEvalIterationQuotaDisabledReason(
  quota: EvalIterationQuota | undefined,
  requestedIterations = 1
): string | null {
  const requested = Math.max(1, Math.floor(requestedIterations));
  if (
    !quota ||
    quota.allowed === null ||
    quota.used + requested <= quota.allowed
  ) {
    return null;
  }
  const remaining = Math.max(0, quota.allowed - quota.used);
  if (remaining > 0) {
    return `This run needs ${requested.toLocaleString()} eval iterations, but only ${remaining.toLocaleString()} remain. Resets ${formatEvalIterationResetTime(
      quota.resetsAt
    )}.`;
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
