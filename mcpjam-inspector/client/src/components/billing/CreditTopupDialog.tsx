import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { cn } from "@/lib/utils";
import {
  useCreditTopup,
  type CreditTopupPreset,
  type CreditTopupSource,
} from "@/hooks/useCreditTopup";

interface CreditTopupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatSessionId: string;
  lastUserMessage: string;
  /** Surface the user came from. Forwarded to telemetry events. */
  source: CreditTopupSource;
}

export function CreditTopupDialog({
  open,
  onOpenChange,
  chatSessionId,
  lastUserMessage,
  source,
}: CreditTopupDialogProps) {
  const { presets, presetsLoading, startCheckout, isStartingCheckout } =
    useCreditTopup();
  const [selectedAmountCents, setSelectedAmountCents] = useState<number | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setSelectedAmountCents(null);
    }
  }, [open]);

  useEffect(() => {
    if (open && presets && selectedAmountCents === null) {
      setSelectedAmountCents(presets[0]?.amountCents ?? null);
    }
  }, [open, presets, selectedAmountCents]);

  const selectedPreset: CreditTopupPreset | undefined = presets?.find(
    (preset) => preset.amountCents === selectedAmountCents,
  );

  const handleConfirm = async () => {
    if (!selectedPreset) return;
    try {
      await startCheckout({
        amountCents: selectedPreset.amountCents,
        chatSessionId,
        lastUserMessage,
        source,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not start checkout. Please try again.";
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Top up to keep chatting</DialogTitle>
          <DialogDescription>
            Add credit to your account so you can keep using MCPJam models
            without waiting for your daily limit to reset.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {presetsLoading ? (
            <div className="text-sm text-muted-foreground">
              Loading amounts…
            </div>
          ) : !presets || presets.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Top-up amounts are unavailable right now. Please try again later.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2" role="radiogroup">
              {presets.map((preset) => {
                const isSelected = preset.amountCents === selectedAmountCents;
                return (
                  <button
                    key={preset.amountCents}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedAmountCents(preset.amountCents)}
                    className={cn(
                      "flex flex-col items-center justify-center rounded-md border px-3 py-3 text-sm font-medium transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border hover:border-foreground/40",
                    )}
                  >
                    <span className="text-base">{preset.amountUsd}</span>
                  </button>
                );
              })}
            </div>
          )}
          {selectedPreset && (
            <p className="text-xs text-muted-foreground">
              A portion of your payment covers payment processing and platform
              fees; the rest is added to your account balance.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isStartingCheckout}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedPreset || isStartingCheckout}
          >
            {isStartingCheckout
              ? "Redirecting…"
              : selectedPreset
                ? `Continue with ${selectedPreset.amountUsd}`
                : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
