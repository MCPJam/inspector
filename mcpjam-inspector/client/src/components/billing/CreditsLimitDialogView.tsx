import { CreditLimitDialogFrame } from "./CreditLimitDialogFrame";
import { Button } from "@mcpjam/design-system/button";
import type { BillingInterval } from "@/hooks/useOrganizationBilling";
import { UpgradeIntervalPicker } from "@/components/billing/UpgradeIntervalPicker";
import {
  RequestUpgradeButton,
  type UpgradeRequestAction,
  type UpgradeRequestRecipient,
} from "@/components/billing/RequestUpgradeButton";

export interface CreditsLimitDialogViewProps {
  description: string;
  isFreePlan?: boolean;
  /** Can't buy credits or upgrade. Gets the owner-request path instead. */
  isKnownNonManager: boolean;
  /** Free orgs whose user can manage billing. A paid org gets credits only. */
  showUpgrade: boolean;
  /** Free-plan admins request an owner upgrade and retain BYOK information. */
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
  priceUnit?: string;
  isStarting: boolean;
  isLoadingPrices?: boolean;
  onUpgrade: () => void;
  onBuyCredits: () => void;
  onExplorePlans?: () => void;
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
 */
export function CreditsLimitDialogView({
  description,
  isFreePlan = false,
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
  priceUnit,
  isStarting,
  isLoadingPrices = false,
  onUpgrade,
  onBuyCredits,
  onExplorePlans,
  onUseOwnKey,
  onDismiss,
  modal = true,
}: CreditsLimitDialogViewProps) {
  return (
    <CreditLimitDialogFrame
      title="Out of MCPJam credits"
      description={description}
      onDismiss={onDismiss}
      modal={modal}
    >
      {isFreePlan && !isKnownNonManager && !showRequestUpgrade ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={onUseOwnKey}>
            Learn more about BYOK
          </Button>
          <Button onClick={onExplorePlans}>Compare plans</Button>
        </div>
      ) : isKnownNonManager || showRequestUpgrade ? (
        <>
          <RequestUpgradeButton
            recipients={requestRecipients}
            organizationName={organizationName}
            teamName={teamName}
            origin="credits"
            limitKind="credits"
            requestAction={requestAction}
            organizationId={organizationId}
          />
          {showRequestUpgrade && (
            <Button variant="link" onClick={onUseOwnKey}>
              Learn more about BYOK
            </Button>
          )}
        </>
      ) : (
        <>
          {showUpgrade ? (
            <UpgradeIntervalPicker
              priceUnit={priceUnit}
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" variant="outline" onClick={onUseOwnKey}>
              Learn more about BYOK
            </Button>
            <Button type="button" onClick={onBuyCredits}>
              Buy credits
            </Button>
          </div>
        </>
      )}
    </CreditLimitDialogFrame>
  );
}
