import { JamIllustration } from "./JamIllustration";
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
  organizationName,
  teamName,
  onLearnMore,
  onBuyCredits,
  onExplorePlans,
  onDismiss,
  modal = true,
}: AllowanceLimitDialogViewProps) {
  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {isFreePlan && <JamIllustration />}
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription
            className="text-pretty"
            data-testid="limit-dialog-description"
          >
            {description}
          </DialogDescription>
        </DialogHeader>
        {isFreePlan && !isKnownNonManager && !showRequestUpgrade ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={onLearnMore}>
              Learn more about BYOK
            </Button>
            <Button onClick={onExplorePlans}>Explore plans</Button>
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
            />
            {showRequestUpgrade && (
              <Button variant="link" onClick={onLearnMore}>
                Learn more about BYOK
              </Button>
            )}
          </>
        ) : (
          <>
            <Button type="button" className="w-full" onClick={onBuyCredits}>
              Buy MCPJam credits
            </Button>
            <DialogFooter className="sm:justify-start">
              <Button
                type="button"
                variant="link"
                className="px-0 text-muted-foreground"
                onClick={onExplorePlans}
              >
                Explore MCPJam plans
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
