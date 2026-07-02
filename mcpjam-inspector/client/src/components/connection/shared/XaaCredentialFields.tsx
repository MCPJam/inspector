import { useEffect, useId, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Info,
  Loader2,
} from "lucide-react";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

/**
 * The Cross-App Access (XAA) credential fields, shared by the /servers Connect
 * page (AuthenticationSection) and the XAA Debugger's "Configure Server to
 * Test" modal so both surfaces have identical fields, ordering, and style.
 *
 * Presentational + fully controlled. The simulated-identity binding differs by
 * surface (per-server on Connect, global run-settings in the Debugger), so the
 * caller owns those values and the help copy.
 */
export interface XaaCredentialFieldsProps {
  // Resource authorization-server credentials (jwt-bearer "leg 3").
  clientId: string;
  onClientIdChange: (value: string) => void;
  clientIdError?: string | null;
  clientSecret: string;
  onClientSecretChange: (value: string) => void;
  hasStoredClientSecret?: boolean;
  clearClientSecret?: boolean;
  onClearClientSecret?: () => void;
  onUndoClearClientSecret?: () => void;
  clientSecretError?: string | null;
  scopes: string;
  onScopesChange: (value: string) => void;

  // Advanced
  xaaAuthzIssuer: string;
  onXaaAuthzIssuerChange: (value: string) => void;
  xaaSubject: string;
  onXaaSubjectChange: (value: string) => void;
  xaaEmail: string;
  onXaaEmailChange: (value: string) => void;
  /** Shown as the simulated-identity default placeholder. */
  signedInEmail?: string;
  /** Per-surface copy under the "Simulated identity" heading. */
  identityHelpText?: string;
  /** Start the Advanced section expanded (Debugger wants identity visible). */
  defaultAdvancedOpen?: boolean;
  /**
   * Hosted-mode reveal context. When both are present and a secret is stored,
   * a "Reveal" button fetches the saved secret (same API + UX as OAuth).
   */
  projectId?: string | null;
  hostedServerId?: string | null;
}

export function XaaCredentialFields({
  clientId,
  onClientIdChange,
  clientIdError,
  clientSecret,
  onClientSecretChange,
  hasStoredClientSecret = false,
  clearClientSecret = false,
  onClearClientSecret,
  onUndoClearClientSecret,
  clientSecretError,
  scopes,
  onScopesChange,
  xaaAuthzIssuer,
  onXaaAuthzIssuerChange,
  xaaSubject,
  onXaaSubjectChange,
  xaaEmail,
  onXaaEmailChange,
  signedInEmail,
  identityHelpText,
  defaultAdvancedOpen = false,
  projectId = null,
  hostedServerId = null,
}: XaaCredentialFieldsProps) {
  const [showAdvanced, setShowAdvanced] = useState(defaultAdvancedOpen);
  const [isSecretVisible, setIsSecretVisible] = useState(false);
  // Hosted-mode reveal — mirrors the OAuth client-secret reveal exactly, using
  // the same endpoint (the secret lives in the same vault column).
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [revealedContextKey, setRevealedContextKey] = useState<string | null>(
    null,
  );
  const [isRevealedVisible, setIsRevealedVisible] = useState(false);
  const [isRevealing, setIsRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [didCopy, setDidCopy] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);

  const canReveal =
    hasStoredClientSecret &&
    !clearClientSecret &&
    !!projectId &&
    !!hostedServerId;
  const revealContextKey = canReveal ? `${projectId}:${hostedServerId}` : null;
  const visibleRevealedSecret =
    revealedContextKey === revealContextKey ? revealedSecret : null;

  // Drop any revealed value when the saved-secret context changes (replacement
  // typed, Clear toggled, or a different server selected).
  useEffect(() => {
    if (revealedContextKey !== revealContextKey) {
      setRevealedSecret(null);
      setRevealedContextKey(null);
      setIsRevealedVisible(false);
      setRevealError(null);
      setDidCopy(false);
      setIsReplacing(false);
    }
  }, [revealContextKey, revealedContextKey]);

  const handleReveal = async () => {
    if (!projectId || !hostedServerId || !revealContextKey || isRevealing)
      return;
    setIsRevealing(true);
    setRevealError(null);
    setIsReplacing(false);
    try {
      const result = await fetchOAuthClientSecret({
        projectId,
        serverId: hostedServerId,
      });
      setRevealedSecret(result.clientSecret);
      setRevealedContextKey(revealContextKey);
      setIsRevealedVisible(true);
    } catch (error) {
      setRevealedSecret(null);
      setRevealedContextKey(null);
      setIsRevealedVisible(false);
      setRevealError(
        error instanceof Error
          ? error.message
          : "Failed to reveal client secret",
      );
    } finally {
      setIsRevealing(false);
    }
  };

  const handleHideRevealed = () => {
    setRevealedSecret(null);
    setRevealedContextKey(null);
    setIsRevealedVisible(false);
    setRevealError(null);
    setDidCopy(false);
    if (isReplacing) onClientSecretChange("");
    setIsReplacing(false);
  };

  const handleCopyRevealed = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setDidCopy(true);
      setTimeout(() => setDidCopy(false), 2000);
    } catch {
      // Clipboard failures are non-fatal.
    }
  };

  // While showing the saved secret (not yet edited) render the revealed value;
  // once the user edits, track their replacement.
  const secretFieldValue = isReplacing
    ? clientSecret
    : (visibleRevealedSecret ?? "");
  const baseId = useId();
  const ids = {
    clientId: `${baseId}-client-id`,
    clientSecret: `${baseId}-client-secret`,
    scopes: `${baseId}-scopes`,
    issuer: `${baseId}-issuer`,
    subject: `${baseId}-subject`,
    email: `${baseId}-email`,
  };

  const identityPlaceholder = signedInEmail
    ? `Defaults to ${signedInEmail}`
    : "Defaults to your signed-in identity";

  return (
    <div className="space-y-3">
      {/* Identity provider — single option in v1; bring-your-own-IdP joins
          here later without a relabel. */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">
          Identity provider
        </label>
        <Select value="mcpjam" disabled>
          <SelectTrigger className="w-full h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mcpjam">
              MCPJam test identity provider
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          MCPJam signs a test identity for the cross-app access flow.
        </p>
      </div>

      {/* Authorization server credentials (resource AS, leg 3) */}
      <div className="space-y-3">
        <div className="space-y-2">
          <label
            htmlFor={ids.clientId}
            className="block text-sm font-medium text-foreground"
          >
            Client ID
            <span className="text-destructive" aria-hidden="true">
              {" *"}
            </span>
          </label>
          <Input
            id={ids.clientId}
            value={clientId}
            onChange={(e) => onClientIdChange(e.target.value)}
            placeholder="Client ID registered with the server's authorization server"
            aria-required
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            className={`h-10 ${clientIdError ? "border-red-500" : ""}`}
          />
          {clientIdError && (
            <p className="text-xs text-red-500">{clientIdError}</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor={ids.clientSecret}
              className="block text-sm font-medium text-foreground"
            >
              Client Secret (Optional)
            </label>
            <div className="flex items-center gap-1">
              {canReveal && !visibleRevealedSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => void handleReveal()}
                  disabled={isRevealing}
                >
                  {isRevealing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Reveal"
                  )}
                </Button>
              )}
              {visibleRevealedSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={handleHideRevealed}
                >
                  Hide
                </Button>
              )}
              {hasStoredClientSecret && !clearClientSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={onClearClientSecret}
                >
                  Clear
                </Button>
              )}
              {hasStoredClientSecret && clearClientSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={onUndoClearClientSecret}
                >
                  Undo
                </Button>
              )}
            </div>
          </div>
          {hasStoredClientSecret && clearClientSecret ? (
            <p className="text-xs text-muted-foreground">
              Saved client secret will be removed when you save.
            </p>
          ) : visibleRevealedSecret !== null ? (
            <>
              <div className="relative">
                <Input
                  id={ids.clientSecret}
                  type={isRevealedVisible ? "text" : "password"}
                  value={secretFieldValue}
                  onChange={(e) => {
                    if (!isReplacing) setIsReplacing(true);
                    onClientSecretChange(e.target.value);
                  }}
                  placeholder="Enter a new value to replace."
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  className={`h-10 pr-16 font-mono ${clientSecretError ? "border-red-500" : ""}`}
                />
                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  <button
                    type="button"
                    aria-label={
                      isRevealedVisible
                        ? "Hide client secret"
                        : "Show client secret"
                    }
                    title={
                      isRevealedVisible
                        ? "Hide client secret"
                        : "Show client secret"
                    }
                    onClick={() => setIsRevealedVisible((prev) => !prev)}
                    className="p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
                  >
                    {isRevealedVisible ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Copy client secret"
                    title="Copy client secret"
                    onClick={() => void handleCopyRevealed(secretFieldValue)}
                    className="p-1 text-muted-foreground/50 transition-colors hover:text-foreground cursor-pointer"
                  >
                    {didCopy ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              {!isReplacing && (
                <p className="text-xs text-muted-foreground">
                  Editing this replaces the saved secret when you save.
                </p>
              )}
            </>
          ) : canReveal ? (
            <p className="text-xs text-muted-foreground">
              A client secret is saved. Reveal it to view or replace it.
            </p>
          ) : (
            <div className="relative">
              <Input
                id={ids.clientSecret}
                type={isSecretVisible ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => onClientSecretChange(e.target.value)}
                placeholder={
                  hasStoredClientSecret
                    ? "Saved — enter a new value to replace"
                    : "Client secret (for confidential clients)"
                }
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                className="h-10 pr-10"
              />
              <button
                type="button"
                aria-label={
                  isSecretVisible ? "Hide client secret" : "Show client secret"
                }
                title={
                  isSecretVisible ? "Hide client secret" : "Show client secret"
                }
                onClick={() => setIsSecretVisible((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
              >
                {isSecretVisible ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          )}
          {clientSecretError && (
            <p className="text-xs text-red-500">{clientSecretError}</p>
          )}
          {revealError && (
            <p className="text-xs text-red-500">{revealError}</p>
          )}
        </div>

        <div className="space-y-2">
          <label
            htmlFor={ids.scopes}
            className="block text-sm font-medium text-foreground"
          >
            Scopes
          </label>
          <Input
            id={ids.scopes}
            value={scopes}
            onChange={(e) => onScopesChange(e.target.value)}
            placeholder="Optional scopes separated by spaces"
            spellCheck={false}
            autoComplete="off"
            className="h-10"
          />
        </div>
      </div>

      {/* Advanced: issuer + simulated identity */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="w-full flex items-center gap-2 py-2 hover:bg-muted/50 transition-colors cursor-pointer"
      >
        {showAdvanced ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="text-xs font-medium text-muted-foreground">
          Advanced
        </span>
      </button>

      {showAdvanced && (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={ids.issuer}
                className="block text-sm font-medium text-foreground"
              >
                Authorization Server Issuer
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="How the authorization server issuer is auto-discovered"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent variant="muted" side="top" className="max-w-xs">
                  Leave blank to auto-discover it: MCPJam reads the MCP
                  server&apos;s protected-resource metadata (
                  <code className="font-mono">
                    /.well-known/oauth-protected-resource
                  </code>
                  ) to find which authorization server protects it.
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              id={ids.issuer}
              value={xaaAuthzIssuer}
              onChange={(e) => onXaaAuthzIssuerChange(e.target.value)}
              placeholder="Auto-discovered if blank"
              spellCheck={false}
              autoComplete="off"
              className="h-10"
            />
          </div>

          <div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              {identityHelpText ??
                "Simulated identity — the test IdP mints a mock login for this user. Leave blank to use your signed-in identity; the resource server decides which subject it accepts, so override it if your server expects a specific value."}
            </p>
            <div className="space-y-1">
              <label
                htmlFor={ids.subject}
                className="block text-xs font-medium text-foreground"
              >
                Subject (sub)
              </label>
              <Input
                id={ids.subject}
                value={xaaSubject}
                onChange={(e) => onXaaSubjectChange(e.target.value)}
                placeholder={identityPlaceholder}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={ids.email}
                className="block text-xs font-medium text-foreground"
              >
                Email
              </label>
              <Input
                id={ids.email}
                value={xaaEmail}
                onChange={(e) => onXaaEmailChange(e.target.value)}
                placeholder={identityPlaceholder}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
                className="h-9"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
