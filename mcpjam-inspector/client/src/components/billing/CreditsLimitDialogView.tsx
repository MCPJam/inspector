import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { LegalConsentNotice } from "@/components/legal/LegalConsentNotice";
import { JamIllustration } from "./JamIllustration";
import {
  UpgradeIntervalPicker,
  type UpgradeIntervalPickerProps,
} from "./UpgradeIntervalPicker";
import {
  RequestUpgradeButton,
  type CreditEngagementContext,
  type UpgradeRequestRecipient,
} from "./RequestUpgradeButton";

export interface CreditsCheckoutOffer {
  picker: Omit<UpgradeIntervalPickerProps, "className">;
  failed: boolean;
}

export interface CreditsLimitDialogViewProps {
  title?: string;
  description: string;
  isFreePlan?: boolean;
  isSwarm?: boolean;
  isKnownNonManager: boolean;
  showRequestUpgrade?: boolean;
  requestRecipients: UpgradeRequestRecipient[];
  organizationId?: string | null;
  organizationName: string;
  teamName: string;
  engagementContext?: CreditEngagementContext;
  /** Set only when this viewer can buy the plan on offer from the wall. */
  checkout?: CreditsCheckoutOffer | null;
  onBuyCredits: () => void;
  onExplorePlans: () => void;
  onUseOwnKey: () => void;
  onDismiss: () => void;
  modal?: boolean;
}

/** Shared Eval/Swarm presentation; billing data and navigation stay in the caller. */
export function CreditsLimitDialogView({
  title = "Out of MCPJam credits",
  description,
  isFreePlan = false,
  isSwarm = false,
  isKnownNonManager,
  showRequestUpgrade = false,
  requestRecipients,
  organizationId,
  organizationName,
  teamName,
  engagementContext,
  checkout,
  onBuyCredits,
  onExplorePlans,
  onUseOwnKey,
  onDismiss,
  modal = true,
}: CreditsLimitDialogViewProps) {
  const showPlansSecondary = isSwarm && !isFreePlan;
  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <JamIllustration />
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription
            className="text-pretty"
            data-testid="limit-dialog-description"
          >
            {description}
          </DialogDescription>
        </DialogHeader>
        {isKnownNonManager || showRequestUpgrade ? (
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
              <Button variant="link" onClick={onUseOwnKey}>
                Learn more about BYOK
              </Button>
            )}
          </>
        ) : checkout ? (
          <div className="space-y-3">
            <UpgradeIntervalPicker {...checkout.picker} />
            {checkout.failed && (
              <p role="alert" className="text-sm text-destructive">
                Couldn't open checkout. Try again or compare plans.
              </p>
            )}
            <LegalConsentNotice />
            {/* A started checkout redirects to Stripe when it returns, which
                would replace any page these links opened in the meantime. */}
            <div className="flex flex-wrap justify-center gap-x-4">
              <Button
                variant="link"
                onClick={onUseOwnKey}
                disabled={checkout.picker.isStarting}
              >
                Use my own API key
              </Button>
              <Button
                variant="link"
                onClick={onExplorePlans}
                disabled={checkout.picker.isStarting}
              >
                Compare plans
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              variant="outline"
              onClick={showPlansSecondary ? onExplorePlans : onUseOwnKey}
            >
              {showPlansSecondary ? "Compare plans" : "Learn more about BYOK"}
            </Button>
            <Button onClick={isFreePlan ? onExplorePlans : onBuyCredits}>
              {isFreePlan ? "Compare plans" : "Buy credits"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
