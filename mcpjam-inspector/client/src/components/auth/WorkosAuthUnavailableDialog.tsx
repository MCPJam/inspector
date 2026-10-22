import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";

export function WorkosAuthUnavailableDialog() {
  const open = useWorkosAuthUnavailableStore((state) => state.open);
  const dismiss = useWorkosAuthUnavailableStore((state) => state.dismiss);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const { open, returnFocus } = useWorkosAuthUnavailableStore.getState();
          if (open) return;
          if (returnFocus?.isConnected) returnFocus.focus();
          useWorkosAuthUnavailableStore.setState({ returnFocus: null });
        }}
      >
        <DialogHeader>
          <DialogTitle>Sign in on app.mcpjam.com</DialogTitle>
          <DialogDescription>
            Sign-in isn’t available at this HTTP address. Use app.mcpjam.com to
            create an account or sign in.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            Cancel
          </Button>
          <Button asChild>
            <a
              href="https://app.mcpjam.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open app.mcpjam.com
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
