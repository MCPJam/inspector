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
  type UpgradeRequestRecipient,
} from "./RequestUpgradeButton";

export interface NativeHarnessLimitDialogViewProps {
  /** The trial's size: the turns the organization has used. */
  granted: number;
  /**
   * The project's clients on a native harness that this person can switch:
   * zero for anyone who is not a project admin. Zero offers no switch.
   */
  switchCount?: number;
  /** Billing managers upgrade; everyone else asks an owner. */
  canUpgrade: boolean;
  requestRecipients: UpgradeRequestRecipient[];
  organizationId?: string | null;
  organizationName: string;
  teamName: string;
  isUpgrading?: boolean;
  isSwitching?: boolean;
  onUpgrade: () => void;
  onSwitch?: () => void;
  onDismiss: () => void;
  modal?: boolean;
}

function clientCount(count: number): string {
  return `${count} ${count === 1 ? "client" : "clients"}`;
}

export function nativeHarnessLimitDescription(
  granted: number,
  switchCount: number,
): string {
  const used = `Your organization has used its ${granted} free native harness turns.`;
  return switchCount > 0
    ? `${used} Upgrade to keep using native harnesses across MCPJam, or switch ${clientCount(switchCount)} in this project to MCPJam Harness.`
    : `${used} Upgrade to keep using native harnesses across MCPJam.`;
}

/**
 * The limit dialog's view for a native turn refused once a Free organization
 * has used its trial. Two actions, stacked: "Switch 3 clients to MCPJam
 * Harness" does not fit half of the dialog's width.
 */
export function NativeHarnessLimitDialogView({
  granted,
  switchCount = 0,
  canUpgrade,
  requestRecipients,
  organizationId,
  organizationName,
  teamName,
  isUpgrading = false,
  isSwitching = false,
  onUpgrade,
  onSwitch,
  onDismiss,
  modal = true,
}: NativeHarnessLimitDialogViewProps) {
  const canSwitch = onSwitch !== undefined && switchCount > 0;
  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <JamIllustration />
        <DialogHeader>
          <DialogTitle>Keep using native harnesses</DialogTitle>
          <DialogDescription
            className="text-pretty"
            data-testid="native-harness-limit-description"
          >
            {nativeHarnessLimitDescription(granted, canSwitch ? switchCount : 0)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {canUpgrade ? (
            <Button onClick={onUpgrade} disabled={isUpgrading}>
              Upgrade
            </Button>
          ) : (
            <RequestUpgradeButton
              recipients={requestRecipients}
              organizationName={organizationName}
              teamName={teamName}
              origin="native_harness"
              limitKind="native_harness_turns"
              organizationId={organizationId}
            />
          )}
          {canSwitch ? (
            <Button variant="outline" onClick={onSwitch} disabled={isSwitching}>
              {`Switch ${clientCount(switchCount)} to MCPJam Harness`}
            </Button>
          ) : (
            <Button variant="outline" onClick={onDismiss}>
              Not now
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
