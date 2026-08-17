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
  // The backend returns null for a denied org read. Keep the raw value so
  // `isLoading` below can tell a denial from a request still in flight.
  const raw = useQuery(
    "billing:getEvalIterationQuota" as any,
    enabled && organizationId ? ({ organizationId } as any) : "skip"
  ) as EvalIterationQuota | null | undefined;
  const quota = raw ?? undefined;

  return {
    quota,
    isLoading: Boolean(enabled && organizationId && raw === undefined),
    isAtLimit: Boolean(
      quota && quota.allowed !== null && quota.used >= quota.allowed
    ),
  };
}
