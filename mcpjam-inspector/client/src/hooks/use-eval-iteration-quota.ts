import { useQuery } from "convex/react";

export type EvalIterationQuota = {
  used: number;
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
  const quota = useQuery(
    "billing:getEvalIterationQuota" as any,
    enabled && organizationId ? ({ organizationId } as any) : "skip"
  ) as EvalIterationQuota | undefined;

  return {
    quota,
    isLoading: Boolean(enabled && organizationId && quota === undefined),
    isAtLimit: Boolean(
      quota && quota.allowed !== null && quota.used >= quota.allowed
    ),
  };
}
