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
import { XaaCredentialFields } from "../connection/shared/XaaCredentialFields";

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
  // Client-secret state mirrors the Connect-page model (shared component):
  // a typed value replaces the saved secret, the Clear toggle removes it.
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientSecret, setClearClientSecret] = useState(false);
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
    setClientSecret("");
    setClearClientSecret(false);
    setError(null);
    setSaving(false);
  }, [open, server, derived]);

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

    // A typed value replaces the saved secret; the Clear toggle removes it. A
    // typed replacement always wins over Clear (the save path rejects both).
    const trimmedSecret = clientSecret.trim();
    const submittedClearSecret = clearClientSecret && !trimmedSecret;

    setError(null);

    const formData: ServerFormData = {
      name: trimmedName,
      type: "http",
      url: trimmedUrl,
      // Cross-App Access discriminator — identical to the /servers Connect
      // page so a server configured in either surface is unambiguously XAA and
      // editing it in one place never flips it back to plain OAuth.
      useXaa: true,
      useOAuth: false,
      authServerMode: "mcpjam",
      clientId: trimmedClientId,
      ...(trimmedSecret ? { clientSecret: trimmedSecret } : {}),
      ...(submittedClearSecret ? { clearClientSecret: true } : {}),
      hasClientSecret: server?.hasClientSecret,
      oauthScopes: scopesArray,
      // Always send the issuer (possibly empty) so clearing it persists.
      xaaAuthzIssuer: trimmedIssuer,
      // Simulated identity is NOT persisted per-server here — it's a global run
      // setting owned by XAAFlowTab (see props) and applied to every target.
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

            {/* Shared with the /servers Connect page so both surfaces present
                identical fields, ordering, and style. */}
            <XaaCredentialFields
              clientId={clientId}
              onClientIdChange={setClientId}
              clientSecret={clientSecret}
              onClientSecretChange={(value) => {
                setClientSecret(value);
                if (value.trim()) setClearClientSecret(false);
              }}
              hasStoredClientSecret={hasSavedSecret}
              clearClientSecret={clearClientSecret}
              onClearClientSecret={() => setClearClientSecret(true)}
              onUndoClearClientSecret={() => setClearClientSecret(false)}
              scopes={scopes}
              onScopesChange={setScopes}
              xaaAuthzIssuer={authzIssuer}
              onXaaAuthzIssuerChange={setAuthzIssuer}
              xaaSubject={simulatedUserId}
              onXaaSubjectChange={(value) =>
                onIdentityChange({ userId: value })
              }
              xaaEmail={simulatedEmail}
              onXaaEmailChange={(value) => onIdentityChange({ email: value })}
              identityHelpText="The IdP mints a mock login for this user before the flow runs. Applies to every server you test — not just this one."
              defaultAdvancedOpen
            />
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
