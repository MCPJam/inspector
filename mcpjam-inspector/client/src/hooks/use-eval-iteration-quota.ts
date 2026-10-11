import { useSoftQuery } from "@/hooks/use-soft-query";

export type EvalIterationQuota = {
  used: number;
  starterRemaining?: number | null;
  allowed: number | null;
  resetsAt: number;
  windowKind: "day" | "month";
};

export function useEvalIterationQuota({
  organizationId,
  enabled = true,
}: {
  organizationId?: string | null;
  enabled?: boolean;
}) {
  // Soft: the sidebar meter reads this on every page, and a failed quota must
  // not replace the app. A failure reads as no quota, which the meter hides.
  const { data: quota, error } = useSoftQuery<EvalIterationQuota>(
    "billing:getEvalIterationQuota",
    enabled && organizationId ? { organizationId } : "skip",
  );

  return {
    quota,
    isLoading: Boolean(
      enabled && organizationId && quota === undefined && !error,
    ),
    isAtLimit: Boolean(
      quota && quota.allowed !== null && quota.used >= quota.allowed,
    ),
  };
}
