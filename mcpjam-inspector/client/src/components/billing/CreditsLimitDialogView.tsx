import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { JamIllustration } from "./JamIllustration";
import {
  RequestUpgradeButton,
  type CreditEngagementContext,
  type UpgradeRequestRecipient,
} from "./RequestUpgradeButton";

export interface CreditsLimitDialogViewProps {
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
  onBuyCredits: () => void;
  onExplorePlans: () => void;
  onUseOwnKey: () => void;
  onDismiss: () => void;
  modal?: boolean;
}

/** Shared Eval/Swarm presentation; billing data and navigation stay in the caller. */
export function CreditsLimitDialogView({
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
          <DialogTitle>Out of MCPJam credits</DialogTitle>
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
