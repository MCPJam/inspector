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
import { UpgradeIntervalPicker } from "@/components/billing/UpgradeIntervalPicker";
import {
  RequestUpgradeButton,
  type UpgradeRequestAction,
  type UpgradeRequestRecipient,
} from "@/components/billing/RequestUpgradeButton";

export interface CreditsLimitDialogViewProps {
  description: string;
  /** Can't buy credits or upgrade. Gets the owner-request path instead. */
  isKnownNonManager: boolean;
  /** Free orgs whose user can manage billing. A paid org gets credits only. */
  showUpgrade: boolean;
  /** Can buy credits but can't upgrade (admins). They keep the credits path
   * and get a way to ask an owner, instead of a pitch with no button. */
  showRequestUpgrade?: boolean;
  requestRecipients: UpgradeRequestRecipient[];
  requestAction?: UpgradeRequestAction;
  organizationId?: string | null;
  organizationName: string;
  interval: BillingInterval;
  onIntervalChange: (interval: BillingInterval) => void;
  annualPriceLabel: string | null;
  monthlyPriceLabel: string | null;
  annualDiscountPct: number;
  annualSupported: boolean;
  monthlySupported: boolean;
  teamName: string;
  isStarting: boolean;
  isLoadingPrices?: boolean;
  onUpgrade: () => void;
  onBuyCredits: () => void;
  onUseOwnKey: () => void;
  onDismiss: () => void;
  /** Dev preview only; see PlanLimitDialogView. Production renders modal. */
  modal?: boolean;
}

/**
 * Presentation for the out-of-credits wall, with no data dependencies, so the
 * dev preview at `/__preview/plan-limit` can render each variant with dummy
 * props. `MCPJamLimitDialog` owns the data, the org resolution, and the copy.
 *
 * Upgrade leads because both of the older actions (buy credits, bring your own
 * key) keep the org on Free at a variable cost. Credits stay available for a
 * genuine burst, one step down.
 */
export function CreditsLimitDialogView({
  description,
  isKnownNonManager,
  showUpgrade,
  showRequestUpgrade = false,
  requestRecipients,
  requestAction = "upgrade",
  organizationId,
  organizationName,
  interval,
  onIntervalChange,
  annualPriceLabel,
  monthlyPriceLabel,
  annualDiscountPct,
  annualSupported,
  monthlySupported,
  teamName,
  isStarting,
  isLoadingPrices = false,
  onUpgrade,
  onBuyCredits,
  onUseOwnKey,
  onDismiss,
  modal = true,
}: CreditsLimitDialogViewProps) {
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
          <DialogTitle>Your org is out of credits</DialogTitle>
          <DialogDescription
            className="text-pretty"
            data-testid="limit-dialog-description"
          >
            {description}
          </DialogDescription>
        </DialogHeader>
        {isKnownNonManager ? (
          <RequestUpgradeButton
            recipients={requestRecipients}
            organizationName={organizationName}
            teamName={teamName}
            origin="credits"
            limitKind="credits"
            requestAction={requestAction}
            organizationId={organizationId}
          />
        ) : (
          <>
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
                isLoadingPrices={isLoadingPrices}
                onUpgrade={onUpgrade}
              />
            ) : null}
            {showRequestUpgrade ? (
              <RequestUpgradeButton
                recipients={requestRecipients}
                organizationName={organizationName}
                teamName={teamName}
                origin="credits"
                limitKind="credits"
                requestAction="upgrade"
                organizationId={organizationId}
              />
            ) : null}
            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="link"
                className="px-0 text-muted-foreground"
                onClick={onUseOwnKey}
              >
                Use your own API key
              </Button>
              <Button type="button" variant="outline" onClick={onBuyCredits}>
                Buy credits
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
