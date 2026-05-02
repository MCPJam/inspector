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
  ServerFormOAuthProtocolMode,
  ServerFormOAuthRegistrationMode,
} from "@/shared/types.js";
import { fetchHostedOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

interface AuthenticationSectionProps {
  serverUrl?: string;
  authType: "oauth" | "bearer" | "none";
  onAuthTypeChange: (value: "oauth" | "bearer" | "none") => void;
  showAuthSettings: boolean;
  bearerToken: string;
  onBearerTokenChange: (value: string) => void;
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
  workspaceId?: string | null;
  hostedServerId?: string | null;
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
  workspaceId = null,
  hostedServerId = null,
}: AuthenticationSectionProps) {
  const [showAdvancedOAuth, setShowAdvancedOAuth] = useState(false);
  const [revealedClientSecret, setRevealedClientSecret] = useState<
    string | null
  >(null);
  const [isRevealedSecretVisible, setIsRevealedSecretVisible] = useState(false);
  const [isRevealingClientSecret, setIsRevealingClientSecret] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [didCopyRevealedSecret, setDidCopyRevealedSecret] = useState(false);

  const canRevealClientSecret =
    hasStoredClientSecret &&
    !clearClientSecret &&
    !!workspaceId &&
    !!hostedServerId;

  // Drop any revealed value if the saved-secret context disappears (e.g.
  // user pasted a replacement, toggled Clear, or switched servers).
  useEffect(() => {
    if (!canRevealClientSecret) {
      setRevealedClientSecret(null);
      setIsRevealedSecretVisible(false);
      setRevealError(null);
      setDidCopyRevealedSecret(false);
    }
  }, [canRevealClientSecret, workspaceId, hostedServerId]);

  const handleRevealClientSecret = async () => {
    if (!workspaceId || !hostedServerId || isRevealingClientSecret) return;
    setIsRevealingClientSecret(true);
    setRevealError(null);
    try {
      const result = await fetchHostedOAuthClientSecret({
        workspaceId,
        serverId: hostedServerId,
      });
      setRevealedClientSecret(result.clientSecret);
      setIsRevealedSecretVisible(true);
    } catch (error) {
      setRevealedClientSecret(null);
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
    setIsRevealedSecretVisible(false);
    setRevealError(null);
    setDidCopyRevealedSecret(false);
  };

  const handleCopyRevealedSecret = async () => {
    if (!revealedClientSecret) return;
    try {
      await navigator.clipboard.writeText(revealedClientSecret);
      setDidCopyRevealedSecret(true);
      setTimeout(() => setDidCopyRevealedSecret(false), 2000);
    } catch {
      // Clipboard failures are non-fatal; surface nothing rather than overwrite reveal state.
    }
  };
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
            onValueChange={(value: "oauth" | "bearer" | "none") => {
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
            </SelectContent>
          </Select>
        </div>

        {/* Bearer Token Settings */}
        {showAuthSettings && authType === "bearer" && (
          <div className="px-3 pb-3 space-y-2 border-t border-border bg-muted/30">
            <label className="block text-sm font-medium text-foreground pt-3">
              Bearer Token
            </label>
            <Input
              type="password"
              value={bearerToken}
              onChange={(e) => onBearerTokenChange(e.target.value)}
              placeholder="Enter your bearer token"
              className="h-10"
            />
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
                          {canRevealClientSecret && !revealedClientSecret && (
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
                          {revealedClientSecret && (
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
                      <Input
                        type="password"
                        value={clientSecret}
                        onChange={(e) => onClientSecretChange(e.target.value)}
                        placeholder={
                          hasStoredClientSecret
                            ? "Saved in workspace Vault. Enter a new value to replace."
                            : "Your OAuth Client Secret"
                        }
                        className={`h-10 ${clientSecretError ? "border-red-500" : ""}`}
                      />
                      {clientSecretError && (
                        <p className="text-xs text-red-500">
                          {clientSecretError}
                        </p>
                      )}
                      {revealError && (
                        <p className="text-xs text-red-500">{revealError}</p>
                      )}
                      {revealedClientSecret && (
                        <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
                          <div className="flex items-start gap-2">
                            <div
                              className="min-w-0 flex-1 break-all font-mono"
                              data-testid="revealed-client-secret"
                            >
                              {isRevealedSecretVisible
                                ? revealedClientSecret
                                : "****************"}
                            </div>
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
                              className="mt-0.5 flex-shrink-0 p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
                            >
                              {isRevealedSecretVisible ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </button>
                            <button
                              type="button"
                              aria-label="Copy client secret"
                              title="Copy client secret"
                              onClick={() => void handleCopyRevealedSecret()}
                              className="mt-0.5 flex-shrink-0 p-1 text-muted-foreground/50 transition-colors hover:text-foreground cursor-pointer"
                            >
                              {didCopyRevealedSecret ? (
                                <Check className="h-3 w-3 text-green-500" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {hasStoredClientSecret && clearClientSecret
                          ? "Saved client secret will be removed when you save."
                          : hasStoredClientSecret
                            ? "Saved in workspace Vault. Enter a new value to replace it."
                            : "Optional for public clients using PKCE"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
