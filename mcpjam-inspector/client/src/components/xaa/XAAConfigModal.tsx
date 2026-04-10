import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HOSTED_MODE } from "@/lib/config";
import { copyToClipboard } from "@/lib/clipboard";
import type { XAADebugProfile } from "@/lib/xaa/profile";
import {
  NEGATIVE_TEST_MODES,
  NEGATIVE_TEST_MODE_DETAILS,
} from "@/shared/xaa.js";

interface XAAConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: XAADebugProfile;
  onSave: (profile: XAADebugProfile) => void;
}

function getIssuerBaseUrl(): string {
  if (typeof window === "undefined") {
    return HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";
  }

  return `${window.location.origin}${HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa"}`;
}

export function XAAConfigModal({
  open,
  onOpenChange,
  value,
  onSave,
}: XAAConfigModalProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const issuerBaseUrl = useMemo(() => getIssuerBaseUrl(), []);
  const jwksUrl = `${issuerBaseUrl}/.well-known/jwks.json`;

  useEffect(() => {
    if (open) {
      setDraft(value);
      setError(null);
    }
  }, [open, value]);

  const handleCopy = async (text: string) => {
    await copyToClipboard(text);
  };

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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure XAA Debugger</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
            <div className="space-y-6">
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Target configuration</h3>
                  <p className="text-xs text-muted-foreground">
                    These values describe the real MCP and authorization servers
                    you want to validate against.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="xaa-server-url">MCP Server URL</Label>
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
                    placeholder="https://auth.example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Leave blank to discover it from MCP resource metadata.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="xaa-client-id">Client ID</Label>
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
                  <Textarea
                    id="xaa-scope"
                    value={draft.scope}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        scope: event.target.value,
                      }))
                    }
                    placeholder="read:tools read:resources"
                    rows={2}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Test configuration</h3>
                  <p className="text-xs text-muted-foreground">
                    This controls the simulated user identity and the negative test
                    mode used to mint the ID-JAG.
                  </p>
                </div>

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

                <div className="space-y-2">
                  <Label>Negative test mode</Label>
                  <Select
                    value={draft.negativeTestMode}
                    onValueChange={(nextValue) =>
                      setDraft((current) => ({
                        ...current,
                        negativeTestMode: nextValue as XAADebugProfile["negativeTestMode"],
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NEGATIVE_TEST_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {NEGATIVE_TEST_MODE_DETAILS[mode].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {NEGATIVE_TEST_MODE_DETAILS[draft.negativeTestMode].description}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
              <div>
                <h3 className="text-sm font-semibold">Trust bootstrap</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  The target authorization server must trust the synthetic issuer
                  before the JWT bearer step can succeed.
                </p>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    Synthetic issuer URL
                  </div>
                  <div className="rounded-md bg-background border border-border px-3 py-2 text-xs break-all">
                    {issuerBaseUrl}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(issuerBaseUrl)}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Copy issuer URL
                  </Button>
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    Synthetic JWKS URL
                  </div>
                  <div className="rounded-md bg-background border border-border px-3 py-2 text-xs break-all">
                    {jwksUrl}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(jwksUrl)}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    Copy JWKS URL
                  </Button>
                </div>
              </div>

              <Alert>
                <AlertDescription className="text-xs space-y-2">
                  <p>1. Register the synthetic issuer or JWKS with your authorization server.</p>
                  <p>2. Make sure the ID-JAG `aud` value matches the authorization server issuer.</p>
                  <p>3. Make sure the ID-JAG `resource` value matches the MCP server resource identifier.</p>
                  <p>4. Register MCPJam with the target authorization server using the client ID above.</p>
                </AlertDescription>
              </Alert>

              {!HOSTED_MODE && (
                <p className="text-xs text-muted-foreground">
                  Local desktop URLs are only usable if the target authorization
                  server can reach this machine or a public tunnel in front of it.
                </p>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save configuration</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
