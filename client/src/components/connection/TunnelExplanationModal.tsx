import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Cable, Lock, Shield, X } from "lucide-react";

export const TUNNEL_EXPLANATION_DISMISSED_KEY = "mcpjam_tunnel_explanation_dismissed";

interface TunnelExplanationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isCreating?: boolean;
}

export function TunnelExplanationModal({
  isOpen,
  onClose,
  onConfirm,
  isCreating = false,
}: TunnelExplanationModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleConfirm = () => {
    if (dontShowAgain) {
      localStorage.setItem(TUNNEL_EXPLANATION_DISMISSED_KEY, "true");
    }
    onConfirm();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cable className="h-5 w-5" />
            Create Secure Tunnel
          </DialogTitle>
          <DialogDescription className="pt-4">
            Tunneling allows you to expose your local MCP servers over HTTPS for
            remote access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-2">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="font-medium text-sm mb-1">HTTPS Access</h4>
              <p className="text-sm text-muted-foreground">
                Your servers will be available via a secure HTTPS URL that you
                can share with clients and applications.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-2">
              <Lock className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="font-medium text-sm mb-1">No Authentication Required</h4>
              <p className="text-sm text-muted-foreground">
                Connect to a server, copy the tunnel url and add it to your favorite client with no authentication required.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-2">
              <X className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="font-medium text-sm mb-1">Close Anytime</h4>
              <p className="text-sm text-muted-foreground">
                You have full control - close the tunnel at any time to stop
                remote access to your servers.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="dont-show-again"
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(checked === true)}
              disabled={isCreating}
            />
            <label
              htmlFor="dont-show-again"
              className="text-sm text-muted-foreground cursor-pointer select-none"
            >
              Don't show this again
            </label>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={isCreating}>
              {isCreating ? "Creating..." : "Create Tunnel"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
