import { useEffect, useState } from "react";
import { CoinStackIcon } from "@/components/ui/coin-stack-icon";
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
  organizationId?: string | null;
  /** Surface the user came from. Forwarded to telemetry events. */
  source: CreditTopupSource;
}

export function CreditTopupDialog({
  open,
  onOpenChange,
  chatSessionId,
  lastUserMessage,
  organizationId,
  source,
}: CreditTopupDialogProps) {
  const { presets, presetsLoading, startCheckout, isStartingCheckout } =
    useCreditTopup();
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!open) {
      setSelectedPackageId(null);
    }
  }, [open]);

  useEffect(() => {
    if (open && presets && selectedPackageId === null) {
      setSelectedPackageId(presets[0]?.packageId ?? null);
    }
  }, [open, presets, selectedPackageId]);

  const selectedPreset: CreditTopupPreset | undefined = presets?.find(
    (preset) => preset.packageId === selectedPackageId
  );

  const handleConfirm = async () => {
    if (!selectedPreset || !organizationId) return;
    try {
      await startCheckout({
        organizationId,
        packageId: selectedPreset.packageId,
        priceCents: selectedPreset.priceCents,
        chatSessionId,
        lastUserMessage,
        source,
        ...(typeof window !== "undefined"
          ? { returnUrl: window.location.href }
          : {}),
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
          <DialogTitle>Buy credits to keep chatting</DialogTitle>
          <DialogDescription>
            Add credits to your organization so the team can keep using MCPJam
            models when your shared credits run low.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {presetsLoading ? (
            <div className="text-sm text-muted-foreground">
              Loading amounts…
            </div>
          ) : !presets || presets.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Credit packages are unavailable right now. Please try again later.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2" role="radiogroup">
              {presets.map((preset) => {
                const isSelected = preset.packageId === selectedPackageId;
                const creditsAmount = preset.displayCredits.replace(
                  /\s*credits\s*$/i,
                  ""
                );
                return (
                  <button
                    key={preset.packageId}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedPackageId(preset.packageId)}
                    className={cn(
                      "flex flex-col items-center justify-center rounded-md border px-3 py-3 text-sm font-medium transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border hover:border-foreground/40"
                    )}
                  >
                    <span className="flex items-center gap-1 text-lg font-semibold leading-tight">
                      <CoinStackIcon aria-hidden="true" className="size-4" />
                      {creditsAmount}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      credits
                    </span>
                  </button>
                );
              })}
            </div>
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
            disabled={!selectedPreset || !organizationId || isStartingCheckout}
          >
            {isStartingCheckout
              ? "Redirecting…"
              : selectedPreset
              ? `Continue with ${selectedPreset.displayPrice}`
              : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
