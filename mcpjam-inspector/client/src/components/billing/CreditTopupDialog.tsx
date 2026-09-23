import { JamIllustration } from "./JamIllustration";
import { useCreditTopupPricing } from "@/hooks/useCreditTopupPricing";
import { useOrganizationBillingStatus } from "@/hooks/useOrganizationBilling";
import { useEffect, useRef, useState } from "react";
import { CreditAmountOption } from "./CreditAmountOption";
import { toast } from "@/lib/toast";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
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
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";

interface CreditTopupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatSessionId: string;
  lastUserMessage: string;
  organizationId?: string | null;
  organizationName?: string;
  /** Surface the user came from. Forwarded to telemetry events. */
  source: CreditTopupSource;
}

export function CreditTopupDialog({
  open,
  onOpenChange,
  chatSessionId,
  lastUserMessage,
  organizationId,
  organizationName = "your organization",
  source,
}: CreditTopupDialogProps) {
  const navigate = useAppNavigate();
  const { presets, presetsLoading, startCheckout, isStartingCheckout } =
    useCreditTopup();
  const quotePreset = useCreditTopupPricing(organizationId, open);
  const billingStatus = useOrganizationBillingStatus(organizationId ?? null, {
    enabled: open,
  });
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

  const selectedQuote = selectedPreset ? quotePreset(selectedPreset) : null;

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
    if (!selectedPreset || !organizationId || !quotePreset.canPurchase) return;
    try {
      const result = await startCheckout({
        organizationId,
        packageId: selectedPreset.packageId,
        priceCents: selectedQuote?.priceCents ?? null,
        chatSessionId,
        lastUserMessage,
        source,
        ...(typeof window !== "undefined"
          ? { returnUrl: window.location.href }
          : {}),
      });
      if (result.handedOffToBrowser) {
        // Nothing will navigate this window, so the dialog has to step aside.
        onOpenChange(false);
      }
    } catch (err) {
      toast.error(
        getBillingErrorMessage(
          err,
          "Could not start checkout. Please try again.",
          billingStatus?.canManageBilling ?? false,
        ),
      );
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
        {quotePreset.requiresUpgrade && <JamIllustration />}
        <DialogHeader>
          <DialogTitle>
            {quotePreset.requiresUpgrade
              ? "Get more testing capacity"
              : "Buy credits to keep testing"}
          </DialogTitle>
          <DialogDescription>
            {quotePreset.requiresUpgrade
              ? "Pro and Team include a larger monthly credit allowance and let you buy extra credits when you need them."
              : `Add shared credits to ${organizationName} to run more evaluations, Swarms, user tests, and CI/CD checks before your included allowance renews.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {quotePreset.error ? (
            <div role="alert" className="text-sm text-muted-foreground">
              Credit pricing is unavailable right now. Close this dialog and try
              again later.
            </div>
          ) : quotePreset.isLoading ? (
            <div role="status" className="text-sm text-muted-foreground">
              Loading credit options…
            </div>
          ) : quotePreset.requiresUpgrade ? (
            <div role="status" className="text-sm text-muted-foreground">
              Only an organization owner can upgrade the plan.
            </div>
          ) : presetsLoading ? (
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
                const creditsAmount = (
                  quotePreset(preset)?.displayCredits ?? preset.displayCredits
                ).replace(/\s*credits\s*$/i, "");
                return (
                  <CreditAmountOption
                    key={preset.packageId}
                    credits={creditsAmount}
                    price={
                      quotePreset(preset)?.displayPrice ?? "Price at checkout"
                    }
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
          {quotePreset.requiresUpgrade && organizationId ? (
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                navigate(buildOrganizationPath(organizationId, "plans"));
              }}
            >
              Compare plans
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={
                !selectedPreset ||
                !organizationId ||
                !quotePreset.canPurchase ||
                isStartingCheckout
              }
            >
              {isStartingCheckout
                ? "Redirecting…"
                : selectedQuote
                ? `Continue with ${selectedQuote.displayCredits} for ${selectedQuote.displayPrice}`
                : "Continue"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
