import { useEffect, useRef, useState } from "react";
import { CreditAmountOption } from "./CreditAmountOption";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  useCreditTopup,
  type CreditTopupPreset,
  type CreditTopupSource,
} from "@/hooks/useCreditTopup";
import { track } from "@/lib/analytics";

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
    null,
  );
  const impressionTrackedRef = useRef(false);
  const dismissalTrackedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setSelectedPackageId(null);
      impressionTrackedRef.current = false;
      dismissalTrackedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (open && presets && selectedPackageId === null) {
      setSelectedPackageId(presets[0]?.packageId ?? null);
    }
  }, [open, presets, selectedPackageId]);

  useEffect(() => {
    if (!open || presetsLoading || impressionTrackedRef.current) return;

    impressionTrackedRef.current = true;
    track("credit_topup_dialog_shown", {
      location: "credit_topup",
      source,
      organization_id: organizationId,
      organization_resolved: Boolean(organizationId),
      package_count: presets?.length ?? 0,
      default_package_id: presets?.[0]?.packageId ?? null,
      default_price_cents: presets?.[0]?.priceCents ?? null,
      packages_available: Boolean(presets?.length),
      has_resume_context: Boolean(chatSessionId && lastUserMessage),
    });
  }, [
    chatSessionId,
    lastUserMessage,
    open,
    organizationId,
    presets,
    presetsLoading,
    source,
  ]);

  const selectedPreset: CreditTopupPreset | undefined = presets?.find(
    (preset) => preset.packageId === selectedPackageId,
  );

  const handleDismiss = (dismissalMethod: "cancel" | "dialog") => {
    onOpenChange(false);
    if (dismissalTrackedRef.current) return;

    dismissalTrackedRef.current = true;
    track("credit_topup_dialog_dismissed", {
      location: "credit_topup",
      source,
      organization_id: organizationId,
      dismissal_method: dismissalMethod,
      selected_package_id: selectedPreset?.packageId ?? null,
      selected_price_cents: selectedPreset?.priceCents ?? null,
    });
  };

  const handlePackageSelection = (
    preset: CreditTopupPreset,
    packageIndex: number,
  ) => {
    setSelectedPackageId(preset.packageId);
    track("credit_topup_package_selected", {
      location: "credit_topup",
      source,
      organization_id: organizationId,
      package_id: preset.packageId,
      price_cents: preset.priceCents,
      package_index: packageIndex,
      package_count: presets?.length ?? 0,
    });
  };

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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleDismiss("dialog");
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Buy credits to keep testing</DialogTitle>
          <DialogDescription>
            Credits cover usage across our product: evaluate, swarm, user
            testing, and CI/CD.
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
              {presets.map((preset, packageIndex) => {
                const isSelected = preset.packageId === selectedPackageId;
                const creditsAmount = preset.displayCredits.replace(
                  /\s*credits\s*$/i,
                  "",
                );
                return (
                  <CreditAmountOption
                    key={preset.packageId}
                    credits={creditsAmount}
                    price={preset.displayPrice}
                    selected={isSelected}
                    onSelect={() =>
                      handlePackageSelection(preset, packageIndex)
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleDismiss("cancel")}
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
