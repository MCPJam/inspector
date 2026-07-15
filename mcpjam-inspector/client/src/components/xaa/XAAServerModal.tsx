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
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  DEFAULT_REGISTRATION_STRATEGY,
  DEFAULT_XAA_CLIENT_AUTH,
  IDENTITY_ASSERTION_FORMATS,
  normalizeIdentityAssertionFormat,
  normalizeRegistrationStrategy,
  normalizeXaaClientAuth,
  type IdentityAssertionFormat,
  type RegistrationStrategy,
  type XaaClientAuthMethod,
} from "@/shared/xaa.js";
import { XAA_STRATEGY_OPTIONS } from "@/lib/registration-strategy";
import { deriveOAuthProfileFromServer } from "../oauth/utils";
import { XaaCredentialFields } from "../connection/shared/XaaCredentialFields";

// UI copy for the identity-assertion preset (input axis of the ID-JAG draft).
// One selector sets both axes at flow time: "saml" mints a SAML assertion AND
// asks for a saml-nameid `sub_id` on the ID-JAG; "oidc" keeps both defaults.
const IDENTITY_ASSERTION_FORMAT_LABELS: Record<
  IdentityAssertionFormat,
  string
> = {
  oidc: "OIDC ID token",
  saml: "SAML assertion",
};

const IDENTITY_ASSERTION_FORMAT_HINTS: Record<IdentityAssertionFormat, string> =
  {
    oidc: "The MCPJam IdP mints an OIDC ID token as the identity assertion.",
    saml: "The MCPJam IdP mints a signed SAML 2.0 assertion; the ID-JAG carries a saml-nameid subject identifier.",
  };

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
  const derived = useMemo(() => deriveOAuthProfileFromServer(server), [server]);
  const hasSavedSecret = Boolean(server?.hasClientSecret);
  const isEditing = Boolean(server);

  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  // Registration strategy (Client↔Resource-AS leg), read from the UNIFIED
  // per-server `registrationMode` shared with the OAuth flows. Pre-registered
  // requires a Client ID; DCR/CIMD mint or URL-address the client identity.
  const [registrationStrategy, setRegistrationStrategy] =
    useState<RegistrationStrategy>(DEFAULT_REGISTRATION_STRATEGY);
  // Auto-clobber guard: the selector DISPLAYS the resolved strategy (a stored
  // "auto" shows as pre-registered), but only an explicit user edit may write
  // it back — otherwise saving this modal would silently rewrite a stored
  // "auto" to "preregistered" and change the OAuth flow's behavior for the
  // same server. Untouched selector ⇒ the save omits `registrationMode` and
  // the `?? existing` merge preserves the raw stored value.
  const [registrationStrategyDirty, setRegistrationStrategyDirty] =
    useState(false);
  // Identity assertion preset (debugger-only, persisted per-server). Unlike
  // registrationMode there is no "auto" shared with other flows, so the save
  // always sends the displayed value.
  const [identityAssertionFormat, setIdentityAssertionFormat] =
    useState<IdentityAssertionFormat>(DEFAULT_IDENTITY_ASSERTION_FORMAT);
  // CIMD client authentication: public (none) or confidential (private_key_jwt).
  // Only surfaced/sent for the cimd strategy.
  const [clientAuth, setClientAuth] = useState<XaaClientAuthMethod>(
    DEFAULT_XAA_CLIENT_AUTH
  );
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
      normalizeRegistrationStrategy(server?.registrationMode) ??
        DEFAULT_REGISTRATION_STRATEGY
    );
    setRegistrationStrategyDirty(false);
    setIdentityAssertionFormat(
      normalizeIdentityAssertionFormat(server?.xaaIdentityAssertionFormat) ??
        DEFAULT_IDENTITY_ASSERTION_FORMAT
    );
    setClientAuth(
      normalizeXaaClientAuth(server?.xaaClientAuth) ?? DEFAULT_XAA_CLIENT_AUTH
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
    if (registrationStrategy === "preregistered" && !trimmedClientId) {
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
      // Identity assertion preset — always sent (absent stored value = oidc).
      xaaIdentityAssertionFormat: identityAssertionFormat,
      // CIMD client-auth — sent only for the cimd strategy so switching away
      // preserves the stored value (the save-path `?? existing` merge).
      ...(registrationStrategy === "cimd"
        ? { xaaClientAuth: clientAuth }
        : {}),
      // Unified registration mode — written ONLY on explicit user edit (see
      // the auto-clobber guard above); an untouched selector omits the field
      // so the save-path `?? existing` merge preserves the stored value
      // (which may be "auto", shared with the OAuth flow).
      ...(registrationStrategyDirty
        ? { registrationMode: registrationStrategy }
        : {}),
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
          : "Couldn't save this server. Your changes were kept — try again."
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

            {/* Registration strategy (Client↔Resource-AS leg). Shares the
                per-server registrationMode with the OAuth flow — an edit here
                changes what the Connect page's OAuth flow reads too. */}
            <div className="space-y-2">
              <Label htmlFor="xaa-registration-strategy">Registration</Label>
              <Select
                value={registrationStrategy}
                onValueChange={(value) => {
                  setRegistrationStrategy(value as RegistrationStrategy);
                  setRegistrationStrategyDirty(true);
                }}
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
            </div>

            {/* CIMD client authentication. Public presents the metadata URL and
                proves nothing; confidential signs a private_key_jwt assertion
                with a server-held client key (published via the reflector doc)
                so an authorization server that requires a confidential client
                accepts the run. Only meaningful for the cimd strategy. */}
            {registrationStrategy === "cimd" && (
              <div className="space-y-2">
                <Label htmlFor="xaa-client-auth">Client authentication</Label>
                <Select
                  value={clientAuth}
                  onValueChange={(value) =>
                    setClientAuth(value as XaaClientAuthMethod)
                  }
                >
                  <SelectTrigger id="xaa-client-auth" className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Public (no client auth)</SelectItem>
                    <SelectItem value="private_key_jwt">
                      Confidential (private_key_jwt)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {clientAuth === "private_key_jwt"
                    ? "MCPJam holds a client key and signs a client_assertion; the client_id is a reflector document publishing the matching public key. Use when the server requires a confidential client."
                    : "Presents MCPJam's hosted metadata URL as the client_id with no client authentication (requires advertised CIMD support)."}
                </p>
              </div>
            )}

            {/* Identity assertion format (input axis). A per-server preset the
                debugger flow reads; changing it resets the current run. */}
            <div className="space-y-2">
              <Label htmlFor="xaa-identity-assertion">Identity assertion</Label>
              <Select
                value={identityAssertionFormat}
                onValueChange={(value) =>
                  setIdentityAssertionFormat(value as IdentityAssertionFormat)
                }
              >
                <SelectTrigger id="xaa-identity-assertion" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IDENTITY_ASSERTION_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {IDENTITY_ASSERTION_FORMAT_LABELS[format]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {IDENTITY_ASSERTION_FORMAT_HINTS[identityAssertionFormat]}
              </p>
            </div>

            {/* Shared with the /servers Connect page so both surfaces present
                identical fields, ordering, and style. */}
            <XaaCredentialFields
              clientId={clientId}
              onClientIdChange={setClientId}
              clientIdRequired={registrationStrategy === "preregistered"}
              showClientCredentials={registrationStrategy === "preregistered"}
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
