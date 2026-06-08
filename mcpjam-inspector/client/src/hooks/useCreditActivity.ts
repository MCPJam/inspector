import { useQuery } from "convex/react";
import { useMemo } from "react";

export interface CreditActivityEntry {
  id: string;
  createdAt: number;
  amountCredits: number; // signed: + granted, − clawed
  seatDelta?: number;
  fromSeats?: number;
  toSeats?: number;
  kind: "granted" | "clawed";
  label: string;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
    const seatDelta = finiteNumber(it.seatDelta);
    const fromSeats = finiteNumber(it.fromSeats);
    const toSeats = finiteNumber(it.toSeats);
    out.push({
      id: it.id,
      createdAt: it.createdAt,
      amountCredits:
        typeof it.amountCredits === "number" ? it.amountCredits : 0,
      ...(seatDelta !== undefined ? { seatDelta } : {}),
      ...(fromSeats !== undefined ? { fromSeats } : {}),
      ...(toSeats !== undefined ? { toSeats } : {}),
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
