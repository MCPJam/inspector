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
import { Plus, X } from "lucide-react";

export interface CustomHeader {
  key: string;
  value: string;
}

interface OAuthAdvancedConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customScopes: string;
  onCustomScopesChange: (scopes: string) => void;
  customHeaders: CustomHeader[];
  onCustomHeadersChange: (headers: CustomHeader[]) => void;
}

export const OAuthAdvancedConfigModal = ({
  open,
  onOpenChange,
  customScopes,
  onCustomScopesChange,
  customHeaders,
  onCustomHeadersChange,
}: OAuthAdvancedConfigModalProps) => {
  const [localScopes, setLocalScopes] = useState(customScopes);
  const [localHeaders, setLocalHeaders] = useState<CustomHeader[]>(customHeaders);

  // Sync with prop when modal opens
  useEffect(() => {
    if (open) {
      setLocalScopes(customScopes);
      setLocalHeaders(customHeaders);
    }
  }, [open, customScopes, customHeaders]);

  const handleSave = () => {
    onCustomScopesChange(localScopes);
    onCustomHeadersChange(localHeaders.filter(h => h.key.trim() !== ""));
    onOpenChange(false);
  };

  const handleCancel = () => {
    setLocalScopes(customScopes); // Reset to original
    setLocalHeaders(customHeaders);
    onOpenChange(false);
  };

  const handleReset = () => {
    setLocalScopes("");
    setLocalHeaders([]);
  };

  const addHeader = () => {
    setLocalHeaders([...localHeaders, { key: "", value: "" }]);
  };

  const updateHeader = (index: number, field: "key" | "value", value: string) => {
    const updated = [...localHeaders];
    updated[index][field] = value;
    setLocalHeaders(updated);
  };

  const removeHeader = (index: number) => {
    setLocalHeaders(localHeaders.filter((_, i) => i !== index));
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

        <div className="space-y-6 py-4 max-h-[60vh] overflow-y-auto">
          {/* OAuth Scopes */}
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

          {/* Custom Headers */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Custom Headers</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addHeader}
                className="h-8"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Header
              </Button>
            </div>

            {localHeaders.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Add custom HTTP headers for OAuth flow requests (e.g., API-Key, X-Custom-Header).
                Headers from your server configuration are automatically included.
              </p>
            ) : (
              <div className="space-y-2">
                {localHeaders.map((header, index) => (
                  <div key={index} className="flex gap-2 items-start">
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <Input
                        type="text"
                        placeholder="Header name"
                        value={header.key}
                        onChange={(e) => updateHeader(index, "key", e.target.value)}
                        className="font-mono text-xs"
                      />
                      <Input
                        type="text"
                        placeholder="Header value"
                        value={header.value}
                        onChange={(e) => updateHeader(index, "value", e.target.value)}
                        className="font-mono text-xs"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeHeader(index)}
                      className="h-9 w-9 p-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground mt-2">
                  These headers will be sent with OAuth flow requests. Pre-populated from your server configuration.
                </p>
              </div>
            )}
          </div>
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
