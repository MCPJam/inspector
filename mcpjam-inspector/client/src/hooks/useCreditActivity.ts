import { useQuery } from "convex/react";
import { useMemo } from "react";

export interface CreditActivityEntry {
  id: string;
  createdAt: number;
  amountCredits: number; // signed: + granted, − clawed
  kind: "granted" | "clawed";
  label: string;
}

const normalize = (raw: unknown): CreditActivityEntry[] | undefined => {
  let items: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "items" in raw) {
    items = (raw as { items?: unknown }).items;
  }
  if (!Array.isArray(items)) return undefined;
  const out: CreditActivityEntry[] = [];
  for (const it of items as Record<string, unknown>[]) {
    if (typeof it?.id !== "string" || typeof it.createdAt !== "number")
      continue;
    out.push({
      id: it.id,
      createdAt: it.createdAt,
      amountCredits:
        typeof it.amountCredits === "number" ? it.amountCredits : 0,
      kind: it.kind === "clawed" ? "clawed" : "granted",
      label: typeof it.label === "string" ? it.label : "",
    });
  }
  return out;
};

/**
 * Reactive credit-activity feed (allowance grants + seat-drop claw-backs) from
 * our ledger. Pass a null organizationId to skip.
 */
export function useCreditActivity(organizationId?: string | null): {
  entries: CreditActivityEntry[] | undefined;
  isLoading: boolean;
} {
  const raw = useQuery(
    "billing/creditHistory:listCreditActivityForOrganization" as any,
    organizationId ? ({ organizationId } as any) : "skip"
  ) as unknown | undefined;

  const entries = useMemo(() => normalize(raw), [raw]);
  return { entries, isLoading: !!organizationId && raw === undefined };
}
