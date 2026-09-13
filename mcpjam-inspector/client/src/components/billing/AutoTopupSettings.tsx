import { creditsToUsdString, usdStringToCredits } from "@/shared/usd-credits";
import { CreditAmountOption } from "./CreditAmountOption";
import { useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import { messageOf } from "@/hooks/useOrgScopedWrite";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

export interface AutoTopupConfiguration {
  monthlySpendLimitCredits?: number | null;
  thresholdCredits: number;
  topupCredits: number;
}

export interface AutoTopupSettingsProps {
  /** undefined: service unavailable; null: confirmed not enrolled. */
  enrollment?: AutoTopupConfiguration | null;
  onClose?: () => void;
  canManage: boolean;
  /** Resolves only once enrollment/configuration has been persisted. */
  onSave?: (configuration: AutoTopupConfiguration) => Promise<void>;
  /** Resolves only once enrollment has been removed. */
  onDisable?: () => Promise<void>;
}

export function AutoTopupSettings({
  enrollment,
  canManage,
  onSave,
  onDisable,
  onClose,
}: AutoTopupSettingsProps) {
  const [custom, setCustom] = useState(
    ![500, 1000, 2000].includes(enrollment?.topupCredits ?? 500),
  );
  const [threshold, setThreshold] = useState(
    String(enrollment?.thresholdCredits ?? 100),
  );
  const [amount, setAmount] = useState(String(enrollment?.topupCredits ?? 500));
  const [monthlyLimit, setMonthlyLimit] = useState(
    enrollment?.monthlySpendLimitCredits == null
      ? ""
      : creditsToUsdString(enrollment.monthlySpendLimitCredits),
  );
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrolled = Boolean(enrollment);
  const loading = enrollment === undefined;
  const busy = saving || disabling;

  const save = async () => {
    const thresholdCredits = Number(threshold);
    const topupCredits = Number(amount);
    if (
      !Number.isSafeInteger(thresholdCredits) ||
      thresholdCredits < 1 ||
      !Number.isSafeInteger(topupCredits) ||
      topupCredits < 1
    ) {
      setError("Enter a positive whole number of credits for both fields.");
      return;
    }
    const monthlySpendLimitCredits =
      monthlyLimit.trim() === "" ? null : usdStringToCredits(monthlyLimit);
    if (
      monthlyLimit.trim() !== "" &&
      (monthlySpendLimitCredits === null ||
        !Number.isSafeInteger(monthlySpendLimitCredits) ||
        monthlySpendLimitCredits < topupCredits)
    ) {
      setError("Maximum monthly spend must cover at least one reload.");
      return;
    }
    if (!canManage || !onSave || enrollment === undefined) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        thresholdCredits,
        topupCredits,
        monthlySpendLimitCredits,
      });
    } catch (cause) {
      setError(
        messageOf(cause) || "Could not save auto-reload settings. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    if (!canManage || !onDisable || !enrolled) return;
    setDisabling(true);
    setError(null);
    try {
      await onDisable();
      onClose?.();
    } catch (cause) {
      setError(
        messageOf(cause) || "Could not turn off auto-reload. Try again.",
      );
    } finally {
      setDisabling(false);
    }
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Credits per reload</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[500, 1000, 2000].map((credits) => (
            <CreditAmountOption
              key={credits}
              credits={credits.toLocaleString()}
              price={`$${Number(creditsToUsdString(credits))}`}
              selected={!custom && amount === String(credits)}
              disabled={!canManage || busy}
              onSelect={() => {
                setCustom(false);
                setAmount(String(credits));
              }}
            />
          ))}
          <label className="cursor-pointer">
            <input
              type="radio"
              name="reload-amount"
              aria-label="Custom amount"
              checked={custom}
              disabled={!canManage || busy}
              onChange={() => setCustom(true)}
              className="peer sr-only"
            />
            <span className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-input p-3 peer-checked:border-ring peer-checked:ring-2 peer-checked:ring-ring peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
              <span className="text-lg font-semibold">Other</span>
              <span className="text-sm text-foreground">Custom amount</span>
            </span>
          </label>
        </div>
      </fieldset>
      {custom && (
        <div className="space-y-2">
          <Label htmlFor="auto-topup-amount">Credits to add</Label>
          <Input
            id="auto-topup-amount"
            type="number"
            min="1"
            step="1"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={!canManage || busy}
          />
          {Number(amount) > 0 && Number.isSafeInteger(Number(amount)) && (
            <p className="text-xs text-muted-foreground">
              ${creditsToUsdString(Number(amount))} per reload
            </p>
          )}
        </div>
      )}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="auto-topup-threshold">Minimum balance</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About minimum balance"
                className="text-muted-foreground"
              >
                <Info className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Automatically purchase the selected amount when your credit
              balance falls below this number of credits.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="relative">
          <Input
            id="auto-topup-threshold"
            type="number"
            min="1"
            step="1"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            disabled={!canManage || busy}
            className="pr-20"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            credits
          </span>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="auto-topup-monthly-limit">
            Maximum monthly spend (optional)
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About maximum monthly spend"
                className="text-muted-foreground"
              >
                <Info className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Limit automatic credit purchases per month. Leave blank for no
              limit. This does not limit manual purchases or usage of existing
              credits.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm">
            $
          </span>
          <Input
            id="auto-topup-monthly-limit"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="No limit"
            value={monthlyLimit}
            onChange={(event) => setMonthlyLimit(event.target.value)}
            disabled={!canManage || busy}
            className="pl-7"
          />
        </div>
      </div>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading auto-reload settings…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!canManage && (
        <p className="text-sm text-foreground">
          Ask an organization admin to manage auto-reload.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-4">
        {canManage && enrolled && onDisable && (
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void disable()}
            className="mr-auto"
          >
            {disabling ? "Turning off…" : "Turn off auto-reload"}
          </Button>
        )}
        {onClose && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Back
          </Button>
        )}
        {canManage && (
          <Button type="submit" disabled={busy || !onSave || loading}>
            <RefreshCw
              aria-hidden="true"
              className={saving ? "size-4 animate-spin" : "size-4"}
            />
            {saving
              ? "Saving…"
              : enrolled
                ? "Save changes"
                : "Turn on auto-reload"}
          </Button>
        )}
      </div>
    </form>
  );
}
