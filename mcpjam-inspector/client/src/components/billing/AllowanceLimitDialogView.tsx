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
  /** Can't buy credits or upgrade. Gets the owner-request path instead. */
  isKnownNonManager: boolean;
  requestRecipients: UpgradeRequestRecipient[];
  organizationId?: string | null;
  organizationName: string;
  teamName: string;
  onBuyCredits: () => void;
  onExplorePlans: () => void;
  onDismiss: () => void;
  /** Dev preview only; see CreditsLimitDialogView. Production renders modal. */
  modal?: boolean;
}

/**
 * The MCPJam model-allowance wall for a swarm. Deliberately the same shape as
 * `CreditsLimitDialogView` — full-width primary, then a footer with the link
 * left — so the two walls read as one pattern.
 *
 * Separate from it because two of that wall's actions dead-end here: no swarm
 * screen mounts the model picker its "use your own API key" link drives, and
 * an own key would not lift this limit anyway, since swarm generation and
 * persona turns are always MCPJam-billed.
 */
export function AllowanceLimitDialogView({
  title,
  description,
  isKnownNonManager,
  requestRecipients,
  organizationId,
  organizationName,
  teamName,
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
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
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
            requestAction="buyCredits"
            organizationId={organizationId}
          />
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
