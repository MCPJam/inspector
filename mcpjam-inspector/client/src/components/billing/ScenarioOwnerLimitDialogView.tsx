import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";

export interface ScenarioOwnerLimitDialogViewProps {
  onDismiss: () => void;
}

/**
 * The wall a User Testing tester sees when the scenario owner's allowance is
 * spent. The owner pays for these turns, so nothing the tester could buy,
 * upgrade, or sign in to would lift it — the dialog only explains.
 */
export function ScenarioOwnerLimitDialogView({
  onDismiss,
}: ScenarioOwnerLimitDialogViewProps) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>This test is paused</DialogTitle>
          <DialogDescription
            className="text-pretty"
            data-testid="limit-dialog-description"
          >
            The owner of this test is out of MCPJam credits. Let them know, or
            try again later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={onDismiss}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
