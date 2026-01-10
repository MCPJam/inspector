import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { AlertTriangle } from "lucide-react";

interface RefreshTokensConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  onConfirm: () => void;
  isLoading?: boolean;
}

export function RefreshTokensConfirmModal({
  open,
  onOpenChange,
  serverName,
  onConfirm,
  isLoading = false,
}: RefreshTokensConfirmModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Refresh Tokens for {serverName}?
          </DialogTitle>
          <DialogDescription className="pt-2">
            This will replace the current OAuth tokens for this server with the
            new tokens from this OAuth flow. The server will be reconnected with
            the new credentials.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isLoading}>
            {isLoading ? "Refreshing..." : "Replace Tokens"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
