import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { resolveAuthorizationPlan } from "@mcpjam/sdk/browser";
import type {
  ServerFormAuthType,
  ServerFormOAuthProtocolMode,
  ServerFormOAuthRegistrationMode,
} from "@/shared/types.js";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

interface AuthenticationSectionProps {
  serverUrl?: string;
  authType: ServerFormAuthType;
  onAuthTypeChange: (value: ServerFormAuthType) => void;
  showAuthSettings: boolean;
  bearerToken: string;
  onBearerTokenChange: (value: string) => void;
  /** True when a saved bearer token exists but its value is hidden. */
  hasStoredBearerToken?: boolean;
  /** Hosted-mode reveal for the saved bearer token. */
  onRevealBearerToken?: () => void;
  isRevealingBearerToken?: boolean;
  bearerRevealError?: string | null;
  oauthScopesInput: string;
  onOauthScopesChange: (value: string) => void;
  oauthProtocolMode: ServerFormOAuthProtocolMode;
  onOauthProtocolModeChange: (value: ServerFormOAuthProtocolMode) => void;
  oauthRegistrationMode: ServerFormOAuthRegistrationMode;
  onOauthRegistrationModeChange: (
    value: ServerFormOAuthRegistrationMode,
  ) => void;
  useCustomClientId: boolean;
  onUseCustomClientIdChange: (value: boolean) => void;
  clientId: string;
  onClientIdChange: (value: string) => void;
  clientSecret: string;
  onClientSecretChange: (value: string) => void;
  hasStoredClientSecret?: boolean;
  clearClientSecret?: boolean;
  onClearClientSecret?: () => void;
  onUndoClearClientSecret?: () => void;
  clientIdError: string | null;
  clientSecretError: string | null;
  /** Hosted-mode reveal context. Both must be provided to enable the Reveal button. */
  projectId?: string | null;
  hostedServerId?: string | null;
  // Cross-App Access (XAA) fields. Client id / secret / scopes reuse the props
  // above; these are XAA-specific.
  xaaAuthzIssuer?: string;
  onXaaAuthzIssuerChange?: (value: string) => void;
  xaaSubject?: string;
  onXaaSubjectChange?: (value: string) => void;
  xaaEmail?: string;
  onXaaEmailChange?: (value: string) => void;
}

const PROTOCOL_OPTIONS: Array<{
  value: ServerFormOAuthProtocolMode;
  label: string;
}> = [
  { value: "2025-11-25", label: "2025-11-25 (Latest)" },
  { value: "2025-06-18", label: "2025-06-18" },
  { value: "2025-03-26", label: "2025-03-26 (Legacy)" },
];

const REGISTRATION_OPTIONS: Array<{
  value: ServerFormOAuthRegistrationMode;
  label: string;
}> = [
  { value: "auto", label: "Automatic" },
  { value: "preregistered", label: "Preregistration (Client Credentials)" },
  { value: "cimd", label: "Client ID Metadata Documents (CIMD)" },
  { value: "dcr", label: "Dynamic Client Registration (DCR)" },
];

export function AuthenticationSection({
  serverUrl,
  authType,
  onAuthTypeChange,
  showAuthSettings,
  bearerToken,
  onBearerTokenChange,
  hasStoredBearerToken = false,
  onRevealBearerToken,
  isRevealingBearerToken = false,
  bearerRevealError = null,
  oauthScopesInput,
  onOauthScopesChange,
  oauthProtocolMode,
  onOauthProtocolModeChange,
  oauthRegistrationMode,
  onOauthRegistrationModeChange,
  useCustomClientId,
  onUseCustomClientIdChange,
  clientId,
  onClientIdChange,
  clientSecret,
  onClientSecretChange,
  hasStoredClientSecret = false,
  clearClientSecret = false,
  onClearClientSecret,
  onUndoClearClientSecret,
  clientIdError,
  clientSecretError,
  projectId = null,
  hostedServerId = null,
  xaaAuthzIssuer = "",
  onXaaAuthzIssuerChange,
  xaaSubject = "",
  onXaaSubjectChange,
  xaaEmail = "",
  onXaaEmailChange,
}: AuthenticationSectionProps) {
  const [showAdvancedOAuth, setShowAdvancedOAuth] = useState(false);
  const [showAdvancedXaa, setShowAdvancedXaa] = useState(false);
  const [isXaaSecretVisible, setIsXaaSecretVisible] = useState(false);
  const [revealedClientSecret, setRevealedClientSecret] = useState<
    string | null
  >(null);
  const [revealedClientSecretContextKey, setRevealedClientSecretContextKey] =
    useState<string | null>(null);
  const [isRevealedSecretVisible, setIsRevealedSecretVisible] = useState(false);
  const [isRevealingClientSecret, setIsRevealingClientSecret] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [didCopyRevealedSecret, setDidCopyRevealedSecret] = useState(false);
  // True once the user edits the revealed value, so the field switches from
  // showing the saved secret to showing their replacement (and won't refill
  // itself if they clear it back to empty).
  const [isReplacingSecret, setIsReplacingSecret] = useState(false);
  const [isBearerTokenVisible, setIsBearerTokenVisible] = useState(false);

  const canRevealClientSecret =
    hasStoredClientSecret &&
    !clearClientSecret &&
    !!projectId &&
    !!hostedServerId;
  const revealContextKey = canRevealClientSecret
    ? `${projectId}:${hostedServerId}`
    : null;
  const visibleRevealedClientSecret =
    revealedClientSecretContextKey === revealContextKey
      ? revealedClientSecret
      : null;

  const canRevealBearerToken =
    hasStoredBearerToken &&
    !bearerToken &&
    !!projectId &&
    !!hostedServerId &&
    !!onRevealBearerToken;

  // Drop any revealed value if the saved-secret context disappears (e.g.
  // user pasted a replacement, toggled Clear, or switched servers).
  useEffect(() => {
    if (revealedClientSecretContextKey !== revealContextKey) {
      setRevealedClientSecret(null);
      setRevealedClientSecretContextKey(null);
      setIsRevealedSecretVisible(false);
      setRevealError(null);
      setDidCopyRevealedSecret(false);
      setIsReplacingSecret(false);
    }
  }, [revealContextKey, revealedClientSecretContextKey]);

  const handleRevealClientSecret = async () => {
    if (
      !projectId ||
      !hostedServerId ||
      !revealContextKey ||
      isRevealingClientSecret
    )
      return;
    setIsRevealingClientSecret(true);
    setRevealError(null);
    setIsReplacingSecret(false);
    try {
      const result = await fetchOAuthClientSecret({
        projectId,
        serverId: hostedServerId,
      });
      setRevealedClientSecret(result.clientSecret);
      setRevealedClientSecretContextKey(revealContextKey);
      setIsRevealedSecretVisible(true);
    } catch (error) {
      setRevealedClientSecret(null);
      setRevealedClientSecretContextKey(null);
      setIsRevealedSecretVisible(false);
      setRevealError(
        error instanceof Error
          ? error.message
          : "Failed to reveal client secret",
      );
    } finally {
      setIsRevealingClientSecret(false);
    }
  };

  const handleHideRevealedSecret = () => {
    setRevealedClientSecret(null);
    setRevealedClientSecretContextKey(null);
    setIsRevealedSecretVisible(false);
    setRevealError(null);
    setDidCopyRevealedSecret(false);
    // Collapsing back to the idle state removes the only input, so discard any
    // in-progress replacement rather than leaving a hidden pending change.
    if (isReplacingSecret) {
      onClientSecretChange("");
    }
    setIsReplacingSecret(false);
  };

  const handleClearClientSecret = () => {
    onClientSecretChange("");
    setRevealedClientSecret(null);
    setRevealedClientSecretContextKey(null);
    setIsRevealedSecretVisible(false);
    setRevealError(null);
    setDidCopyRevealedSecret(false);
    setIsReplacingSecret(false);
    onClearClientSecret?.();
  };

  const handleCopyRevealedSecret = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setDidCopyRevealedSecret(true);
      setTimeout(() => setDidCopyRevealedSecret(false), 2000);
    } catch {
      // Clipboard failures are non-fatal; surface nothing rather than overwrite reveal state.
    }
  };

  // While the field is showing the saved secret (not yet edited) it renders the
  // revealed value; once the user starts editing it tracks their replacement.
  const secretFieldValue = isReplacingSecret
    ? clientSecret
    : (visibleRevealedClientSecret ?? "");
  const showClientCredentials =
    oauthRegistrationMode === "preregistered" || useCustomClientId;
  const effectiveOauthProtocolMode =
    oauthProtocolMode === "auto" ? "2025-11-25" : oauthProtocolMode;
  const oauthPlan =
    authType === "oauth"
      ? resolveAuthorizationPlan({
          serverUrl,
          protocolMode: effectiveOauthProtocolMode,
          registrationMode: oauthRegistrationMode,
          clientId: showClientCredentials ? clientId : undefined,
          clientSecret: showClientCredentials ? clientSecret : undefined,
          hasClientSecret: showClientCredentials
            ? hasStoredClientSecret && !clearClientSecret
            : undefined,
          authMode: "interactive",
        })
      : null;

  const oauthPlanVisibleBlockers =
    oauthPlan?.status === "blocked"
      ? (oauthPlan.blockerDetails ?? []).filter(
          (blocker) =>
            !(
              oauthRegistrationMode === "preregistered" &&
              clientId.trim() === "" &&
              blocker.code === "PREREGISTERED_MISSING_CLIENT_ID"
            ),
        )
      : [];
  const showOauthPlanBanner =
    oauthPlan != null &&
    (oauthPlanVisibleBlockers.length > 0 || oauthPlan.warnings.length > 0);

  return (
    <div className="space-y-4">
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="p-3 space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Authentication
          </label>
          <Select
            value={authType}
            onValueChange={(value: ServerFormAuthType) => {
              if (value !== "oauth") {
                setShowAdvancedOAuth(false);
              }
              onAuthTypeChange(value);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Authentication</SelectItem>
              <SelectItem value="bearer">Bearer Token</SelectItem>
              <SelectItem value="oauth">OAuth</SelectItem>
              <SelectItem value="xaa">Cross-App Access (XAA)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Bearer Token Settings */}
        {showAuthSettings && authType === "bearer" && (
          <div className="px-3 pb-3 space-y-2 border-t border-border bg-muted/30">
            <div className="flex items-center justify-between gap-3 pt-3">
              <label className="block text-sm font-medium text-foreground">
                Bearer Token
              </label>
              {canRevealBearerToken && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => onRevealBearerToken?.()}
                  disabled={isRevealingBearerToken}
                >
                  {isRevealingBearerToken ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Reveal"
                  )}
                </Button>
              )}
            </div>
            <div className="relative">
              <Input
                type={isBearerTokenVisible ? "text" : "password"}
                value={bearerToken}
                onChange={(e) => onBearerTokenChange(e.target.value)}
                placeholder={
                  hasStoredBearerToken && !bearerToken
                    ? "Saved — enter a new value to replace"
                    : "Enter your bearer token"
                }
                className="h-10 pr-10"
              />
              <button
                type="button"
                aria-label={
                  isBearerTokenVisible ? "Hide bearer token" : "Show bearer token"
                }
                title={
                  isBearerTokenVisible ? "Hide bearer token" : "Show bearer token"
                }
                onClick={() => setIsBearerTokenVisible((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
              >
                {isBearerTokenVisible ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {hasStoredBearerToken && !bearerToken && (
              <p className="text-xs text-muted-foreground">
                A saved token is hidden. Leave blank to keep it, or enter a new
                value to replace it.
              </p>
            )}
            {bearerRevealError && (
              <p className="text-xs text-red-500">{bearerRevealError}</p>
            )}
          </div>
        )}

        {/* OAuth Settings */}
        {showAuthSettings && authType === "oauth" && (
          <div className="border-t border-border bg-muted/30">
            {oauthPlan && showOauthPlanBanner && (
              <div className="px-3 py-3 space-y-2 border-b border-border bg-background/60">
                {oauthPlanVisibleBlockers.length > 0 && (
                  <p className="text-sm text-destructive">
                    {oauthPlanVisibleBlockers[0]?.message}
                  </p>
                )}
                {oauthPlan.warnings.length > 0 && (
                  <p className="text-xs text-amber-700">
                    {oauthPlan.warnings[0]}
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowAdvancedOAuth(!showAdvancedOAuth)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors cursor-pointer"
            >
              {showAdvancedOAuth ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className="text-xs font-medium text-muted-foreground">
                Advanced Settings
              </span>
            </button>

            {showAdvancedOAuth && (
              <div className="px-3 pb-3 space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-foreground">
                      Protocol
                    </label>
                    <Select
                      value={effectiveOauthProtocolMode}
                      onValueChange={(value: ServerFormOAuthProtocolMode) =>
                        onOauthProtocolModeChange(value)
                      }
                    >
                      <SelectTrigger className="w-full h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROTOCOL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-foreground">
                      Registration Strategy
                    </label>
                    <Select
                      value={oauthRegistrationMode}
                      onValueChange={(
                        value: ServerFormOAuthRegistrationMode,
                      ) => {
                        onOauthRegistrationModeChange(value);
                        onUseCustomClientIdChange(
                          value === "preregistered",
                        );
                      }}
                    >
                      <SelectTrigger className="w-full h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {REGISTRATION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {oauthRegistrationMode === "cimd" &&
                      oauthPlan?.clientIdMetadataUrl && (
                        <p className="text-xs text-muted-foreground break-all">
                          SDK client metadata URL:{" "}
                          {oauthPlan.clientIdMetadataUrl}
                        </p>
                      )}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
                    Scope Override
                  </label>
                  <Input
                    value={oauthScopesInput}
                    onChange={(e) => onOauthScopesChange(e.target.value)}
                    placeholder="Optional scopes separated by spaces"
                    className="h-10"
                  />
                </div>

                {showClientCredentials && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-foreground">
                        Client ID
                        {oauthRegistrationMode === "preregistered" ? (
                          <span className="text-destructive" aria-hidden="true">
                            {" *"}
                          </span>
                        ) : null}
                      </label>
                      <Input
                        value={clientId}
                        onChange={(e) => onClientIdChange(e.target.value)}
                        placeholder="Your OAuth Client ID"
                        aria-required={
                          oauthRegistrationMode === "preregistered"
                            ? true
                            : undefined
                        }
                        className={`h-10 ${clientIdError ? "border-red-500" : ""}`}
                      />
                      {clientIdError && (
                        <p className="text-xs text-red-500">{clientIdError}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <label className="block text-sm font-medium text-foreground">
                          Client Secret (Optional)
                        </label>
                        <div className="flex items-center gap-1">
                          {canRevealClientSecret &&
                            !visibleRevealedClientSecret && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs"
                                onClick={() => void handleRevealClientSecret()}
                                disabled={isRevealingClientSecret}
                              >
                                {isRevealingClientSecret ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  "Reveal"
                                )}
                              </Button>
                            )}
                          {visibleRevealedClientSecret && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={handleHideRevealedSecret}
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
                              onClick={handleClearClientSecret}
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
                      ) : visibleRevealedClientSecret !== null ? (
                        <>
                          <div className="relative">
                            <Input
                              type={
                                isRevealedSecretVisible ? "text" : "password"
                              }
                              value={secretFieldValue}
                              onChange={(e) => {
                                if (!isReplacingSecret)
                                  setIsReplacingSecret(true);
                                onClientSecretChange(e.target.value);
                              }}
                              placeholder="Enter a new value to replace."
                              data-testid="revealed-client-secret"
                              className={`h-10 pr-16 font-mono ${clientSecretError ? "border-red-500" : ""}`}
                            />
                            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                              <button
                                type="button"
                                aria-label={
                                  isRevealedSecretVisible
                                    ? "Hide client secret"
                                    : "Show client secret"
                                }
                                title={
                                  isRevealedSecretVisible
                                    ? "Hide client secret"
                                    : "Show client secret"
                                }
                                onClick={() =>
                                  setIsRevealedSecretVisible((prev) => !prev)
                                }
                                className="p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
                              >
                                {isRevealedSecretVisible ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                aria-label="Copy client secret"
                                title="Copy client secret"
                                onClick={() =>
                                  void handleCopyRevealedSecret(secretFieldValue)
                                }
                                className="p-1 text-muted-foreground/50 transition-colors hover:text-foreground cursor-pointer"
                              >
                                {didCopyRevealedSecret ? (
                                  <Check className="h-4 w-4 text-green-500" />
                                ) : (
                                  <Copy className="h-4 w-4" />
                                )}
                              </button>
                            </div>
                          </div>
                          {!isReplacingSecret && (
                            <p className="text-xs text-muted-foreground">
                              Editing this replaces the saved secret when you
                              save.
                            </p>
                          )}
                        </>
                      ) : canRevealClientSecret ? (
                        <p className="text-xs text-muted-foreground">
                          A client secret is saved. Reveal it to view or replace
                          it.
                        </p>
                      ) : (
                        <Input
                          type="password"
                          value={clientSecret}
                          onChange={(e) => onClientSecretChange(e.target.value)}
                          placeholder={
                            hasStoredClientSecret
                              ? "Enter a new value to replace."
                              : "Your OAuth Client Secret"
                          }
                          className={`h-10 ${clientSecretError ? "border-red-500" : ""}`}
                        />
                      )}
                      {clientSecretError && (
                        <p className="text-xs text-red-500">
                          {clientSecretError}
                        </p>
                      )}
                      {revealError && (
                        <p className="text-xs text-red-500">{revealError}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Cross-App Access (XAA) Settings */}
        {showAuthSettings && authType === "xaa" && (
          <div className="px-3 pb-3 space-y-3 border-t border-border bg-muted/30">
            {/* Identity provider — single option in v1; bring-your-own-IdP joins
                here later without a relabel. */}
            <div className="space-y-2 pt-3">
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
                <label className="block text-sm font-medium text-foreground">
                  Client ID
                  <span className="text-destructive" aria-hidden="true">
                    {" *"}
                  </span>
                </label>
                <Input
                  value={clientId}
                  onChange={(e) => onClientIdChange(e.target.value)}
                  placeholder="Client ID registered with the server's authorization server"
                  aria-required
                  className={`h-10 ${clientIdError ? "border-red-500" : ""}`}
                />
                {clientIdError && (
                  <p className="text-xs text-red-500">{clientIdError}</p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="block text-sm font-medium text-foreground">
                    Client Secret (Optional)
                  </label>
                  <div className="flex items-center gap-1">
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
                ) : (
                  <div className="relative">
                    <Input
                      type={isXaaSecretVisible ? "text" : "password"}
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
                        isXaaSecretVisible
                          ? "Hide client secret"
                          : "Show client secret"
                      }
                      title={
                        isXaaSecretVisible
                          ? "Hide client secret"
                          : "Show client secret"
                      }
                      onClick={() => setIsXaaSecretVisible((prev) => !prev)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
                    >
                      {isXaaSecretVisible ? (
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
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  Scopes
                </label>
                <Input
                  value={oauthScopesInput}
                  onChange={(e) => onOauthScopesChange(e.target.value)}
                  placeholder="Optional scopes separated by spaces"
                  className="h-10"
                />
              </div>
            </div>

            {/* Advanced: issuer + simulated identity */}
            <button
              type="button"
              onClick={() => setShowAdvancedXaa(!showAdvancedXaa)}
              className="w-full flex items-center gap-2 py-2 hover:bg-muted/50 transition-colors cursor-pointer"
            >
              {showAdvancedXaa ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className="text-xs font-medium text-muted-foreground">
                Advanced
              </span>
            </button>

            {showAdvancedXaa && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
                    Authorization Server Issuer
                  </label>
                  <Input
                    value={xaaAuthzIssuer}
                    onChange={(e) => onXaaAuthzIssuerChange?.(e.target.value)}
                    placeholder="Auto-discovered if blank"
                    spellCheck={false}
                    autoComplete="off"
                    className="h-10"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to auto-discover it from the server&apos;s
                    protected-resource metadata.
                  </p>
                </div>

                <div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Simulated identity — the test IdP mints a mock login for this
                    user before the flow runs. Leave blank to use a test
                    identity.
                  </p>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-foreground">
                      Subject (sub)
                    </label>
                    <Input
                      value={xaaSubject}
                      onChange={(e) => onXaaSubjectChange?.(e.target.value)}
                      placeholder="user-12345"
                      spellCheck={false}
                      autoComplete="off"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-foreground">
                      Email
                    </label>
                    <Input
                      value={xaaEmail}
                      onChange={(e) => onXaaEmailChange?.(e.target.value)}
                      placeholder="demo.user@example.com"
                      spellCheck={false}
                      autoComplete="off"
                      className="h-9"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
