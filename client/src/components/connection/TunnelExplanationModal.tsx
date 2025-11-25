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
import { AlertTriangle, Cable, Copy, FlaskConical } from "lucide-react";

export const TUNNEL_EXPLANATION_DISMISSED_KEY =
  "mcpjam_tunnel_explanation_dismissed";

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
            Create Tunnel
          </DialogTitle>
          <DialogDescription className="pt-4">
            Tunneling allows you to expose your local MCP servers over HTTPS for
            remote access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-2">
              <FlaskConical className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="font-medium text-sm mb-1">Test with ChatGPT</h4>
              <p className="text-sm text-muted-foreground">
                Get an HTTPS URL to test your MCP server with ChatGPT Developer
                Mode or other remote clients.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-2">
              <Copy className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="font-medium text-sm mb-1">No Setup Required</h4>
              <p className="text-sm text-muted-foreground">
                Copy the tunnel URL and paste it directly into ChatGPT settings.
                No authentication configuration needed.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-primary/10 p-2">
              <Cable className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="font-medium text-sm mb-1">Close When Done</h4>
              <p className="text-sm text-muted-foreground">
                Close the tunnel when you're finished testing to disable remote
                access.
              </p>
            </div>
          </div>
        </div>

        <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Anyone with the tunnel URL can access your MCP servers. Close the
          tunnel when done.
        </p>

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
