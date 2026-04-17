import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { XAADebugProfile } from "@/lib/xaa/profile";

interface XAAConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: XAADebugProfile;
  onSave: (profile: XAADebugProfile) => void;
}

export function XAAConfigModal({
  open,
  onOpenChange,
  value,
  onSave,
}: XAAConfigModalProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(value);
      setError(null);
      // Open the advanced section if the user has previously customized it.
      const hasCustomIdentity =
        Boolean(value.userId?.trim()) || Boolean(value.email?.trim());
      setIdentityOpen(hasCustomIdentity);
    }
  }, [open, value]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedServerUrl = draft.serverUrl.trim();
    const trimmedIssuer = draft.authzServerIssuer.trim();
    const trimmedClientId = draft.clientId.trim();
    const trimmedScope = draft.scope.trim();
    const trimmedUserId = draft.userId.trim();
    const trimmedEmail = draft.email.trim();

    if (!trimmedServerUrl) {
      setError("MCP Server URL is required.");
      return;
    }

    if (!trimmedClientId) {
      setError("Client ID is required.");
      return;
    }

    try {
      new URL(trimmedServerUrl);
      if (trimmedIssuer) {
        new URL(trimmedIssuer);
      }
    } catch {
      setError("Enter valid HTTPS or HTTP URLs for the configured endpoints.");
      return;
    }

    setError(null);
    onSave({
      serverUrl: trimmedServerUrl,
      authzServerIssuer: trimmedIssuer,
      clientId: trimmedClientId,
      scope: trimmedScope,
      userId: trimmedUserId || value.userId,
      email: trimmedEmail || value.email,
      negativeTestMode: draft.negativeTestMode,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>Configure XAA Debugger</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="xaa-server-url">
                  MCP Server URL <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="xaa-server-url"
                  value={draft.serverUrl}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      serverUrl: event.target.value,
                    }))
                  }
                  placeholder="https://mcp.example.com"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="xaa-authz-issuer">
                  Authorization Server Issuer
                </Label>
                <Input
                  id="xaa-authz-issuer"
                  value={draft.authzServerIssuer}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      authzServerIssuer: event.target.value,
                    }))
                  }
                  placeholder="Auto-discovered from MCP resource metadata"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="xaa-client-id">
                  Client ID <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="xaa-client-id"
                  value={draft.clientId}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      clientId: event.target.value,
                    }))
                  }
                  placeholder="mcpjam-debugger"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="xaa-scope">Scope</Label>
                <Input
                  id="xaa-scope"
                  value={draft.scope}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      scope: event.target.value,
                    }))
                  }
                  placeholder="read:tools read:resources"
                />
              </div>
            </div>

            <Collapsible open={identityOpen} onOpenChange={setIdentityOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                <span className="font-medium">Simulated identity</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {identityOpen ? "Hide" : "Customize"}
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 transition-transform",
                      identityOpen && "rotate-180",
                    )}
                  />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-3">
                <p className="text-xs text-muted-foreground">
                  The MCPJam issuer mints a mock ID token for this user.
                  Defaults work for most flows.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="xaa-user-id">User ID</Label>
                    <Input
                      id="xaa-user-id"
                      value={draft.userId}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          userId: event.target.value,
                        }))
                      }
                      placeholder="user-12345"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="xaa-email">Email</Label>
                    <Input
                      id="xaa-email"
                      value={draft.email}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          email: event.target.value,
                        }))
                      }
                      placeholder="demo.user@example.com"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600 flex-shrink-0">{error}</p>
          )}

          <DialogFooter className="mt-4 flex-shrink-0 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Save configuration</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
