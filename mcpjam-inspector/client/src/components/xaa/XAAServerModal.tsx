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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { validateServerFormData } from "@/lib/server-form-validation";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  DEFAULT_XAA_REGISTRATION_STRATEGY,
  normalizeXaaRegistrationStrategy,
  type XaaRegistrationStrategy,
} from "@/shared/xaa.js";
import {
  XAA_STRATEGY_HINTS,
  XAA_STRATEGY_OPTIONS,
} from "@/lib/xaa/registration-strategy";
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
  /**
   * Signed-in user's email — the default simulated identity when the per-server
   * subject/email fields are left blank. Same default as the /servers Connect
   * page so the two surfaces stay in sync.
   */
  signedInEmail?: string;
  /** Hosted secret context used to reveal an existing saved client secret. */
  projectId?: string | null;
  hostedServerId?: string | null;
}

export function XAAServerModal({
  open,
  onOpenChange,
  server,
  existingServerNames,
  onSave,
  signedInEmail,
  projectId,
  hostedServerId,
}: XAAServerModalProps) {
  const derived = useMemo(
    () => deriveOAuthProfileFromServer(server),
    [server],
  );
  const hasSavedSecret = Boolean(server?.hasClientSecret);
  const isEditing = Boolean(server);

  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  // Registration strategy (Client↔Resource-AS leg). Persisted per-server; the
  // modal is the source of truth. Pre-registered requires a Client ID; DCR/CIMD
  // mint or URL-address the client identity instead.
  const [registrationStrategy, setRegistrationStrategy] =
    useState<XaaRegistrationStrategy>(DEFAULT_XAA_REGISTRATION_STRATEGY);
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState("");
  const [authzIssuer, setAuthzIssuer] = useState("");
  const [allowPathScopedIssuer, setAllowPathScopedIssuer] = useState(false);
  // Client-secret state mirrors the Connect-page model (shared component):
  // a typed value replaces the saved secret, the Clear toggle removes it.
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientSecret, setClearClientSecret] = useState(false);
  // Per-server simulated identity — the single source of truth shared with the
  // /servers Connect page (saved on the server, used by both the debugger run
  // and the connect mint). Editing it here syncs to /servers and vice versa.
  const [xaaSubject, setXaaSubject] = useState("");
  const [xaaEmail, setXaaEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setServerName(server?.name ?? "");
    setServerUrl(derived.serverUrl ?? "");
    setRegistrationStrategy(
      normalizeXaaRegistrationStrategy(server?.xaaRegistrationStrategy) ??
        DEFAULT_XAA_REGISTRATION_STRATEGY,
    );
    setClientId(derived.clientId ?? "");
    // Scopes can be stored comma- or space-separated upstream; normalize to
    // the space-separated form this modal edits.
    setScopes((derived.scopes ?? "").replace(/,/g, " ").trim());
    setAuthzIssuer(server?.xaaAuthzIssuer ?? "");
    setAllowPathScopedIssuer(server?.xaaAllowPathScopedIssuer === true);
    setClientSecret("");
    setClearClientSecret(false);
    setXaaSubject(server?.xaaSubject ?? "");
    setXaaEmail(server?.xaaEmail ?? "");
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
    // Client ID is only required for pre-registered clients. DCR mints one and
    // CIMD addresses the client via a metadata URL, so both leave it optional.
    if (registrationStrategy === "pre_registered" && !trimmedClientId) {
      setError("Client ID is required for pre-registered clients.");
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
      xaaAllowPathScopedIssuer: allowPathScopedIssuer,
      // Per-server simulated identity, defaulting to the signed-in user when
      // blank — identical to the Connect page so the two surfaces stay synced.
      xaaSubject: xaaSubject.trim() || signedInEmail || undefined,
      xaaEmail: xaaEmail.trim() || signedInEmail || undefined,
      // Debugger-owned registration strategy (Client↔Resource-AS leg).
      xaaRegistrationStrategy: registrationStrategy,
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

            {/* Registration strategy (Client↔Resource-AS leg). Debugger-only —
                not part of the shared Connect-page fields below. */}
            <div className="space-y-2">
              <Label htmlFor="xaa-registration-strategy">Registration</Label>
              <Select
                value={registrationStrategy}
                onValueChange={(value) =>
                  setRegistrationStrategy(value as XaaRegistrationStrategy)
                }
              >
                <SelectTrigger id="xaa-registration-strategy" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {XAA_STRATEGY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {XAA_STRATEGY_HINTS[registrationStrategy]}
              </p>
            </div>

            {/* Shared with the /servers Connect page so both surfaces present
                identical fields, ordering, and style. */}
            <XaaCredentialFields
              clientId={clientId}
              onClientIdChange={setClientId}
              clientIdRequired={registrationStrategy === "pre_registered"}
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
              xaaAllowPathScopedIssuer={allowPathScopedIssuer}
              onXaaAllowPathScopedIssuerChange={setAllowPathScopedIssuer}
              xaaSubject={xaaSubject}
              onXaaSubjectChange={setXaaSubject}
              xaaEmail={xaaEmail}
              onXaaEmailChange={setXaaEmail}
              signedInEmail={signedInEmail}
              projectId={projectId}
              hostedServerId={hostedServerId}
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
