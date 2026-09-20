import { CreditLimitDialogFrame } from "./CreditLimitDialogFrame";
import { Button } from "@mcpjam/design-system/button";
import {
  RequestUpgradeButton,
  type UpgradeRequestRecipient,
} from "@/components/billing/RequestUpgradeButton";

export interface AllowanceLimitDialogViewProps {
  /** Both vary by which allowance ran out; see `MCPJamLimitPeriod`. */
  title: string;
  description: string;
  isFreePlan?: boolean;
  /** Can't buy credits or upgrade. Gets the owner-request path instead. */
  isKnownNonManager: boolean;
  /** Free-plan admins must ask an owner to upgrade. */
  showRequestUpgrade?: boolean;
  requestRecipients: UpgradeRequestRecipient[];
  organizationId?: string | null;
  engagementContext?: {
    surface: string | null;
    current_plan?: string;
    effective_plan?: string;
  };
  organizationName: string;
  teamName: string;
  onLearnMore?: () => void;
  onBuyCredits: () => void;
  onExplorePlans: () => void;
  onDismiss: () => void;
  /** Dev preview only; see CreditsLimitDialogView. Production renders modal. */
  modal?: boolean;
}

/** Swarm allowance wall: Free explores plans; eligible paid organizations top up. */
export function AllowanceLimitDialogView({
  title,
  description,
  isFreePlan = false,
  isKnownNonManager,
  showRequestUpgrade = false,
  requestRecipients,
  organizationId,
  engagementContext,
  organizationName,
  teamName,
  onLearnMore,
  onBuyCredits,
  onExplorePlans,
  onDismiss,
  modal = true,
}: AllowanceLimitDialogViewProps) {
  return (
    <CreditLimitDialogFrame
      title={title}
      description={description}
      onDismiss={onDismiss}
      modal={modal}
    >
      {isFreePlan && !isKnownNonManager && !showRequestUpgrade ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={onLearnMore}>
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
            requestAction={isFreePlan ? "upgrade" : "buyCredits"}
            organizationId={organizationId}
            engagementContext={engagementContext}
          />
          {showRequestUpgrade && (
            <Button variant="link" onClick={onLearnMore}>
              Learn more about BYOK
            </Button>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button type="button" variant="outline" onClick={onExplorePlans}>
            Compare plans
          </Button>
          <Button type="button" onClick={onBuyCredits}>
            Buy credits
          </Button>
        </div>
      )}
    </CreditLimitDialogFrame>
  );
}
