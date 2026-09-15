import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { messageOf } from "@/hooks/useOrgScopedWrite";
import type {
  AutoTopupConfiguration,
  AutoTopupView,
} from "@/hooks/useAutoTopup";
export type { AutoTopupConfiguration } from "@/hooks/useAutoTopup";
export const refillDollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const STATUS: Record<AutoTopupView["status"], string> = {
  not_configured: "",
  not_active: "Saved, not active. Complete card setup to turn on.",
  awaiting_card: "Card setup is awaiting completion.",
  enrolled: "Auto-reload is on.",
  paused: "Automatic refills are paused. Check your plan and payment settings.",
  payment_pending:
    "A refill payment is pending. An already-authorized payment can still complete after turning refills off.",
  needs_attention: "Automatic refills: payment needs attention.",
};
export interface AutoTopupSettingsProps {
  view?: AutoTopupView;
  canManage: boolean;
  onSave?: (configuration: AutoTopupConfiguration) => Promise<void>;
  cardSetupConfigured?: boolean;
  onClear?: () => Promise<void>;
  onDisable?: () => Promise<void>;
  onBegin?: () => Promise<unknown>;
  onClose?: () => void;
}
/** Parent keys this form by organization/revision so stale settings never carry consent. */
export function AutoTopupSettings({
  view,
  canManage,
  onSave,
  onDisable,
  onClear,
  cardSetupConfigured = true,
  onBegin,
  onClose,
}: AutoTopupSettingsProps) {
  const preferences = view?.preferences;
  const [threshold, setThreshold] = useState(
    String(preferences?.thresholdCredits ?? 100),
  );
  const [amount, setAmount] = useState(
    String(preferences?.topupCredits ?? 1000),
  );
  const [limit, setLimit] = useState(
    preferences?.monthlySpendLimitCents == null
      ? ""
      : (preferences.monthlySpendLimitCents / 100).toFixed(2),
  );
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parsedLimit =
    limit.trim() === ""
      ? null
      : /^\d+(\.\d{1,2})?$/.test(limit)
        ? Math.round(Number(limit) * 100)
        : NaN;
  const dirty =
    !preferences ||
    Number(threshold) !== preferences.thresholdCredits ||
    Number(amount) !== preferences.topupCredits ||
    parsedLimit !== preferences.monthlySpendLimitCents;
  const perform = async (work: () => Promise<unknown>) => {
    if (busy || !canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const thresholdCredits = Number(threshold),
      topupCredits = Number(amount);
    if (
      !Number.isSafeInteger(topupCredits) ||
      topupCredits < 500 ||
      topupCredits > 1000000 ||
      !Number.isSafeInteger(thresholdCredits) ||
      thresholdCredits < 1 ||
      thresholdCredits > topupCredits
    ) {
      setError(
        "Enter 500–1,000,000 whole credits per refill and a minimum balance from 1 through the refill size.",
      );
      return;
    }
    if (
      parsedLimit !== null &&
      (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0)
    ) {
      setError(
        "Enter a positive dollar limit with at most two decimal places, or leave it blank for unlimited.",
      );
      return;
    }
    if (
      parsedLimit !== null &&
      Number(amount) === preferences?.topupCredits &&
      view?.refillPriceCents != null &&
      parsedLimit < view.refillPriceCents
    ) {
      setError("Maximum monthly spend must cover at least one refill.");
      return;
    }
    if (
      !onSave ||
      !view ||
      !view.eligible ||
      (view.status === "enrolled" && !dirty)
    )
      return;
    await perform(async () => {
      await onSave({
        thresholdCredits,
        topupCredits,
        monthlySpendLimitCents: parsedLimit,
      });
      setConsent(false);
      setNotice(
        "Settings saved. Fresh authorization is required for automatic purchases.",
      );
    });
  };
  const canAuthorize =
    preferences &&
    view?.activationAllowed &&
    view.eligible &&
    view.refillPriceCents != null &&
    view.status !== "enrolled" &&
    view.status !== "payment_pending" &&
    view.paymentIssue !== "needs_review";
  const setupUnavailable =
    view &&
    canManage &&
    !["enrolled", "payment_pending", "needs_attention", "paused"].includes(
      view.status,
    ) &&
    (!view.eligible || !view.activationAllowed || !cardSetupConfigured);
  const statusText = !view
    ? "Loading settings…"
    : setupUnavailable
      ? !view.eligible
        ? "Auto-reload isn’t available for this organization."
        : "Auto-reload setup is currently unavailable."
      : STATUS[view.status];
  return (
    <div className="space-y-5">
      {statusText && (
        <p role="status" className="text-sm">
          {statusText}
        </p>
      )}
      {view?.paymentIssue && (
        <p className="text-sm">
          {view.paymentIssue === "payment_failed"
            ? "The card payment failed. Review your card and authorize again."
            : view.paymentIssue === "balance_still_low"
              ? "The refill settled existing debt and the balance is still low. Review usage before authorizing again."
              : "Contact support to review the payment. Pending payments are not retried from this screen."}
        </p>
      )}
      {view?.card && (
        <p className="text-sm">
          Card: {view.card.brand} ending in {view.card.last4}
        </p>
      )}
      {view?.monthlySpend &&
        (view.monthlySpend.chargedCents > 0 ||
          view.monthlySpend.reservedCents > 0) && (
          <p className="text-sm">
            {view.monthlySpend.month} UTC. Charged:{" "}
            {refillDollars(view.monthlySpend.chargedCents)} · Reserved:{" "}
            {refillDollars(view.monthlySpend.reservedCents)}
          </p>
        )}
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset
          disabled={!canManage || busy || !view || !view.eligible}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="auto-topup-amount">Credits to add</Label>
            <Input
              id="auto-topup-amount"
              type="number"
              min={500}
              max={1000000}
              step={1}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setConsent(false);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auto-topup-threshold">Minimum balance</Label>
            <Input
              id="auto-topup-threshold"
              type="number"
              min={1}
              step={1}
              value={threshold}
              onChange={(event) => {
                setThreshold(event.target.value);
                setConsent(false);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auto-topup-monthly-limit">
              Maximum monthly spend (USD, optional)
            </Label>
            <Input
              id="auto-topup-monthly-limit"
              inputMode="decimal"
              value={limit}
              placeholder="No limit"
              onChange={(event) => {
                setLimit(event.target.value);
                setConsent(false);
              }}
            />
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Leave blank for no monthly limit.
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">How billing works</summary>
          <p className="mt-2">
            Limits reset each UTC calendar month. Manual purchases don’t count;
            refunds don’t reduce monthly spend. Saving settings turns off
            auto-reload until you authorize again. Saving alone won’t charge
            you.
          </p>
        </details>
        {canManage && (
          <Button
            type="submit"
            disabled={
              busy ||
              !view?.eligible ||
              !onSave ||
              (view.status === "enrolled" && !dirty)
            }
          >
            {busy ? "Working…" : "Save settings"}
          </Button>
        )}
      </form>
      {canManage && canAuthorize && onBegin && (
        <div className="space-y-3 border-t border-border pt-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || dirty}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I authorize MCPJam to save this card and automatically buy{" "}
              {preferences.topupCredits.toLocaleString("en-US")} credits for{" "}
              {refillDollars(view.refillPriceCents!)} when my balance falls
              below {preferences.thresholdCredits.toLocaleString("en-US")},{" "}
              {preferences.monthlySpendLimitCents === null
                ? "with no spending limit"
                : `up to ${refillDollars(
                    preferences.monthlySpendLimitCents,
                  )}`}{" "}
              per UTC calendar month. I can turn this off in billing settings.
            </span>
          </label>
          <Button
            disabled={busy || dirty || !consent}
            onClick={() => void perform(onBegin)}
          >
            Continue to card setup
          </Button>
        </div>
      )}
      {!canManage && (
        <p className="text-sm">
          Ask an organization admin to manage auto-reload.
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {canManage &&
          view &&
          onDisable &&
          (preferences || view.status !== "not_configured") && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await onDisable();
                  setConsent(false);
                  setNotice(
                    "New automatic purchases are off. Saved settings remain; already-authorized payments can still complete.",
                  );
                })
              }
            >
              Turn off auto-reload
            </Button>
          )}
        {canManage && preferences && onClear && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await onClear();
                setConsent(false);
                setNotice(
                  "Saved settings removed. New automatic purchases are off; already-authorized payments can still complete.",
                );
              })
            }
          >
            Clear saved settings
          </Button>
        )}
        {onClose && (
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Back
          </Button>
        )}
      </div>
    </div>
  );
}
