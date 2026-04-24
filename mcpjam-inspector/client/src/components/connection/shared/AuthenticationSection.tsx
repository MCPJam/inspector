import { useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import { ChevronDown, ChevronRight } from "lucide-react";
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
  clientIdError: string | null;
  clientSecretError: string | null;
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

/** Shown inline via Client ID label + submit guard; hide duplicate banner from the SDK planner. */
const PREREGISTERED_MISSING_CLIENT_ID_BLOCKER =
  /requires a client ID before the flow can start/i;

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
  clientIdError,
  clientSecretError,
}: AuthenticationSectionProps) {
  const [showAdvancedOAuth, setShowAdvancedOAuth] = useState(false);
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
          authMode: "interactive",
        })
      : null;

  const oauthPlanVisibleBlockers =
    oauthPlan?.status === "blocked"
      ? (oauthPlan.blockers ?? []).filter(
          (message) =>
            !(
              oauthRegistrationMode === "preregistered" &&
              clientId.trim() === "" &&
              PREREGISTERED_MISSING_CLIENT_ID_BLOCKER.test(message)
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
                    {oauthPlanVisibleBlockers[0]}
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
                      <label className="block text-sm font-medium text-foreground">
                        Client Secret (Optional)
                      </label>
                      <Input
                        type="password"
                        value={clientSecret}
                        onChange={(e) => onClientSecretChange(e.target.value)}
                        placeholder="Your OAuth Client Secret"
                        className={`h-10 ${clientSecretError ? "border-red-500" : ""}`}
                      />
                      {clientSecretError && (
                        <p className="text-xs text-red-500">
                          {clientSecretError}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Optional for public clients using PKCE
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
