import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import { validateServerFormData } from "@/lib/server-form-validation";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import { deriveOAuthProfileFromServer } from "../oauth/utils";

interface XAAServerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: ServerWithName;
  existingServerNames: string[];
  // May be async. The modal stays open (preserving the entered values) if this
  // rejects, so a downstream save failure never discards the form.
  onSave: (payload: { formData: ServerFormData }) => void | Promise<void>;
  // Global simulated identity (sub/email). Owned by XAAFlowTab's run settings
  // and edited here because it applies to every target, not just this server —
  // editing it updates the live run immediately (it is not part of the form
  // save). Single source of truth, so the running flow always sees the change.
  simulatedUserId: string;
  simulatedEmail: string;
  onIdentityChange: (patch: { userId?: string; email?: string }) => void;
}

// "keep" the saved secret untouched, "replace" it with a new value, or
// "clear" it (turn the target back into a public client). Only meaningful
// when editing a server that already has a stored secret.
type SecretAction = "keep" | "replace" | "clear";

export function XAAServerModal({
  open,
  onOpenChange,
  server,
  existingServerNames,
  onSave,
  simulatedUserId,
  simulatedEmail,
  onIdentityChange,
}: XAAServerModalProps) {
  const derived = useMemo(
    () => deriveOAuthProfileFromServer(server),
    [server],
  );
  const hasSavedSecret = Boolean(server?.hasClientSecret);
  const isEditing = Boolean(server);

  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState("");
  const [authzIssuer, setAuthzIssuer] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [secretAction, setSecretAction] = useState<SecretAction>("keep");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setServerName(server?.name ?? "");
    setServerUrl(derived.serverUrl ?? "");
    setClientId(derived.clientId ?? "");
    // Scopes can be stored comma- or space-separated upstream; normalize to
    // the space-separated form this modal edits.
    setScopes((derived.scopes ?? "").replace(/,/g, " ").trim());
    setAuthzIssuer(server?.xaaAuthzIssuer ?? "");
    setSecretInput("");
    setSecretAction(hasSavedSecret ? "keep" : "replace");
    setError(null);
    setSaving(false);
  }, [open, server, derived, hasSavedSecret]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedName = serverName.trim();
    if (!trimmedName) {
      setError("Server name is required.");
      return;
    }
    if (
      !isEditing &&
      existingServerNames.some((name) => name === trimmedName)
    ) {
      setError(`A server named "${trimmedName}" already exists.`);
      return;
    }

    const trimmedUrl = serverUrl.trim();
    if (!trimmedUrl) {
      setError("Server URL is required.");
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(trimmedUrl);
    } catch {
      setError("Enter a valid server URL (e.g. https://staging.example.com).");
      return;
    }

    const trimmedClientId = clientId.trim();
    if (!trimmedClientId) {
      setError("Client ID is required.");
      return;
    }

    const trimmedIssuer = authzIssuer.trim();
    if (trimmedIssuer) {
      try {
        // eslint-disable-next-line no-new
        new URL(trimmedIssuer);
      } catch {
        setError("Authorization Server Issuer must be a valid URL, or blank.");
        return;
      }
    }

    const scopesArray = scopes
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);

    // Resolve the secret operation. A new server (or one without a saved
    // secret) takes whatever was typed; an edit only changes the secret when
    // the user explicitly replaces or clears it.
    const trimmedSecret = secretInput.trim();
    let clientSecret: string | undefined;
    let clearClientSecret: boolean | undefined;
    if (hasSavedSecret) {
      if (secretAction === "replace" && trimmedSecret) {
        clientSecret = trimmedSecret;
      } else if (secretAction === "clear") {
        clearClientSecret = true;
      }
    } else if (trimmedSecret) {
      clientSecret = trimmedSecret;
    }

    setError(null);

    const formData: ServerFormData = {
      name: trimmedName,
      type: "http",
      url: trimmedUrl,
      useOAuth: true,
      clientId: trimmedClientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(clearClientSecret ? { clearClientSecret: true } : {}),
      hasClientSecret: server?.hasClientSecret,
      oauthScopes: scopesArray,
      // Always send the issuer (possibly empty) so clearing it persists.
      xaaAuthzIssuer: trimmedIssuer,
    };

    // Final gate: the exact validator the save path runs. Any rule added there
    // is enforced here too, so a new rule can never pass this form and then be
    // rejected downstream — which would close the dialog and discard everything
    // entered. The field-level messages above stay for nicer UX; this keeps the
    // form and the save path in lockstep.
    const validationError = validateServerFormData(formData);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Keep the modal open until the save resolves. If it throws, surface the
    // reason inline and preserve every entered value instead of closing.
    setSaving(true);
    try {
      await onSave({ formData });
      onOpenChange(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Couldn't save this server. Your changes were kept — try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>Configure Server to Test</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="xaa-server-name">
                Server Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="xaa-server-name"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                placeholder="staging-mcp"
                autoFocus={!isEditing}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="xaa-server-url">
                Server URL <span className="text-red-500">*</span>
              </Label>
              <Input
                id="xaa-server-url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://staging.mcp.example.com"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="xaa-client-id">
                Client ID <span className="text-red-500">*</span>
              </Label>
              <Input
                id="xaa-client-id"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="mcpjam-debugger"
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="xaa-client-secret">Client Secret</Label>
              {hasSavedSecret && secretAction === "keep" ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    •••••••• saved
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSecretAction("replace")}
                  >
                    Replace
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSecretAction("clear")}
                  >
                    Clear
                  </Button>
                </div>
              ) : hasSavedSecret && secretAction === "clear" ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    Secret will be cleared on save.
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSecretAction("keep")}
                  >
                    Keep
                  </Button>
                </div>
              ) : (
                <Input
                  id="xaa-client-secret"
                  type="password"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  value={secretInput}
                  onChange={(event) => setSecretInput(event.target.value)}
                  placeholder={
                    hasSavedSecret
                      ? "Enter a new client secret"
                      : "Required by confidential-client auth servers"
                  }
                />
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="xaa-scopes">Scopes</Label>
              <Input
                id="xaa-scopes"
                value={scopes}
                onChange={(event) => setScopes(event.target.value)}
                placeholder="read:tools read:resources"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="xaa-authz-issuer">
                Authorization Server Issuer
              </Label>
              <Input
                id="xaa-authz-issuer"
                value={authzIssuer}
                onChange={(event) => setAuthzIssuer(event.target.value)}
                placeholder="Auto-discovered if blank"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <p className="text-xs text-muted-foreground">
              Client ID, secret, and scopes are this server's OAuth credentials
              (shared with the OAuth Debugger).
            </p>

            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
              <div className="space-y-0.5">
                <Label htmlFor="xaa-identity-sub">Simulated identity</Label>
                <p className="text-xs text-muted-foreground">
                  The IdP mints a mock login for this user before the flow runs.
                  Applies to every server you test — not just this one.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="xaa-identity-sub"
                  className="text-xs text-muted-foreground"
                >
                  Subject (sub)
                </Label>
                <Input
                  id="xaa-identity-sub"
                  value={simulatedUserId}
                  onChange={(event) =>
                    onIdentityChange({ userId: event.target.value })
                  }
                  placeholder="user-12345"
                  spellCheck={false}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="xaa-identity-email"
                  className="text-xs text-muted-foreground"
                >
                  Email
                </Label>
                <Input
                  id="xaa-identity-email"
                  value={simulatedEmail}
                  onChange={(event) =>
                    onIdentityChange({ email: event.target.value })
                  }
                  placeholder="demo.user@example.com"
                  spellCheck={false}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600 flex-shrink-0" role="alert">
              {error}
            </p>
          )}

          <DialogFooter className="mt-4 flex-shrink-0 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save configuration"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
