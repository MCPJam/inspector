import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";

export type TaxIdStatus = "pending" | "verified" | "unverified" | "unavailable";
export interface BillingTaxId {
  id: string;
  type: string;
  value: string;
  status: TaxIdStatus;
}

const statusCopy: Record<TaxIdStatus, { label: string; detail: string }> = {
  pending: {
    label: "Verification pending",
    detail:
      "Stripe is checking this tax ID. You can continue using your subscription.",
  },
  verified: {
    label: "Verified",
    detail:
      "Stripe verified this tax ID. This does not verify the business name or address.",
  },
  unverified: {
    label: "Not verified",
    detail:
      "Stripe could not verify this tax ID. Check it in billing details and correct it if needed.",
  },
  unavailable: {
    label: "Verification unavailable",
    detail:
      "Automatic verification is unavailable for this tax ID. Manual verification may be needed.",
  },
};

/** Mounted only for organization owners. Stripe is queried afresh, not cached. */
export function TaxIdStatusSection({
  organizationId,
}: {
  organizationId: string;
}) {
  const listTaxIds = useAction("billing:listOrganizationTaxIds" as any);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    organizationId: string;
    taxIds?: BillingTaxId[];
    error?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // Hide the previous organization's data immediately, before effects run.
  const current = result?.organizationId === organizationId ? result : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    listTaxIds({ organizationId })
      .then((taxIds: BillingTaxId[]) => {
        if (!cancelled) setResult({ organizationId, taxIds });
      })
      .catch(() => {
        if (!cancelled)
          setResult({
            organizationId,
            error: "Could not load tax ID verification. Try again.",
          });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listTaxIds, organizationId, refresh]);

  const pending = current?.taxIds?.some((taxId) => taxId.status === "pending");
  useEffect(() => {
    if (!pending) return;
    const timeout = window.setTimeout(
      () => setRefresh((value) => value + 1),
      15_000,
    );
    return () => window.clearTimeout(timeout);
  }, [pending, refresh]);

  return (
    <section
      aria-label="Tax ID verification"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Tax ID verification</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh status
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Add or update tax IDs through Manage billing. Verification happens after
        checkout and does not block your purchase.
      </p>
      <div aria-live="polite">
        {loading || !current ? (
          <p className="text-sm">Checking tax IDs…</p>
        ) : current.error ? (
          <p role="alert" className="text-sm">
            {current.error}
          </p>
        ) : current.taxIds?.length ? (
          <ul className="space-y-3">
            {current.taxIds.map((taxId) => {
              const copy = statusCopy[taxId.status] ?? statusCopy.unavailable;
              return (
                <li key={taxId.id} className="space-y-1">
                  <p className="text-sm">
                    <span className="font-mono">{taxId.value}</span> ·{" "}
                    {taxId.type.replaceAll("_", " ").toUpperCase()} ·{" "}
                    <span className="font-medium">{copy.label}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">{copy.detail}</p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No tax IDs have been added.
          </p>
        )}
      </div>
    </section>
  );
}
