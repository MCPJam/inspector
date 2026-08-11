import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import type { UpgradeOrigin } from "@/hooks/use-upgrade-checkout";
import { UpgradeIntervalPicker } from "@/components/billing/UpgradeIntervalPicker";
import {
  RequestUpgradeButton,
  type UpgradeRequestRecipient,
} from "@/components/billing/RequestUpgradeButton";

export interface PlanLimitDialogViewProps {
  title: string;
  description: string;
  /** Self-serve checkout: free orgs whose user can manage billing. */
  showUpgrade: boolean;
  /** Sales path: paid orgs below Enterprise that hit their own ceiling. */
  showEnterprise: boolean;
  /** Owner-request path: free orgs whose user can't manage billing. */
  requestRecipients: UpgradeRequestRecipient[];
  organizationName: string;
  origin: UpgradeOrigin;
  limitKind: string;
  interval: BillingInterval;
  onIntervalChange: (interval: BillingInterval) => void;
  annualPriceLabel: string | null;
  monthlyPriceLabel: string | null;
  annualDiscountPct: number;
  annualSupported: boolean;
  monthlySupported: boolean;
  teamName: string;
  isStarting: boolean;
  onUpgrade: () => void;
  onRequestEnterprise: () => void;
  onDismiss: () => void;
  /**
   * Escape hatch for the dev preview only. Non-modal drops the overlay and the
   * body pointer-events lock so the preview's own variant switcher stays
   * clickable behind the dialog. Production always renders modal.
   */
  modal?: boolean;
}

/**
 * Presentation for the eval-iteration wall, with no data dependencies, so the
 * dev preview at `/__preview/plan-limit` can render every variant with dummy
 * props and no Convex client. `PlanLimitDialog` owns the data and the copy
 * assembly.
 */
export function PlanLimitDialogView({
  title,
  description,
  showUpgrade,
  showEnterprise,
  requestRecipients,
  organizationName,
  origin,
  limitKind,
  interval,
  onIntervalChange,
  annualPriceLabel,
  monthlyPriceLabel,
  annualDiscountPct,
  annualSupported,
  monthlySupported,
  teamName,
  isStarting,
  onUpgrade,
  onRequestEnterprise,
  onDismiss,
  modal = true,
}: PlanLimitDialogViewProps) {
  const showRequest = !showUpgrade && !showEnterprise;

  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription data-testid="plan-limit-dialog-description">
            {description}
          </DialogDescription>
        </DialogHeader>
        {showUpgrade ? (
          <UpgradeIntervalPicker
            interval={interval}
            onIntervalChange={onIntervalChange}
            annualPriceLabel={annualPriceLabel}
            monthlyPriceLabel={monthlyPriceLabel}
            annualDiscountPct={annualDiscountPct}
            annualSupported={annualSupported}
            monthlySupported={monthlySupported}
            teamName={teamName}
            isStarting={isStarting}
            onUpgrade={onUpgrade}
          />
        ) : null}
        {showEnterprise ? (
          <DialogFooter>
            <Button
              type="button"
              onClick={onRequestEnterprise}
              data-testid="plan-limit-enterprise-cta"
            >
              Request upgrade
            </Button>
          </DialogFooter>
        ) : null}
        {showRequest ? (
          <RequestUpgradeButton
            recipients={requestRecipients}
            organizationName={organizationName}
            teamName={teamName}
            origin={origin}
            limitKind={limitKind}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
