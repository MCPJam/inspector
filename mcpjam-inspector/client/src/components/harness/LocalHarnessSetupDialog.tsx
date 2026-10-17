import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";

/** Confirms durable setup before a first send can use this computer. */
export function LocalHarnessSetupDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent data-testid="local-harness-setup-dialog">
        <DialogHeader>
          <DialogTitle>Set up {name} on this computer?</DialogTitle>
          <DialogDescription>
            MCPJam creates a working folder for this project. {name} runs as
            your user account and can read or change files you can access. Your
            tool approval settings apply to commands and file changes. Setup can
            download the client runtime. Your message stays in the composer
            until you send it again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Set up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
