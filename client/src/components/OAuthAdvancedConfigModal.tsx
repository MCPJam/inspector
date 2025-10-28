import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OAuthAdvancedConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customScopes: string;
  onCustomScopesChange: (scopes: string) => void;
}

export const OAuthAdvancedConfigModal = ({
  open,
  onOpenChange,
  customScopes,
  onCustomScopesChange,
}: OAuthAdvancedConfigModalProps) => {
  const [localScopes, setLocalScopes] = useState(customScopes);

  // Sync with prop when modal opens
  useEffect(() => {
    if (open) {
      setLocalScopes(customScopes);
    }
  }, [open, customScopes]);

  const handleSave = () => {
    onCustomScopesChange(localScopes);
    onOpenChange(false);
  };

  const handleCancel = () => {
    setLocalScopes(customScopes); // Reset to original
    onOpenChange(false);
  };

  const handleReset = () => {
    setLocalScopes("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Advanced OAuth Configuration</DialogTitle>
          <DialogDescription>
            Customize OAuth flow parameters for testing different scenarios.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="scopes">OAuth Scopes</Label>
            <Input
              id="scopes"
              type="text"
              placeholder="mcp:* or custom scopes separated by spaces"
              value={localScopes}
              onChange={(e) => setLocalScopes(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to use automatic discovery: <br />
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                openid profile email offline_access
              </code>{" "}
              + server-advertised scopes
            </p>
          </div>

          {/* Future advanced settings can be added here */}
          {/* Example:
          <div className="space-y-2">
            <Label htmlFor="redirect">Custom Redirect URI</Label>
            <Input
              id="redirect"
              type="text"
              placeholder="https://..."
              disabled
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Coming soon
            </p>
          </div>
          */}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleReset}>
            Reset to Default
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
