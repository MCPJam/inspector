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
import {
  resolveAuthorizationPlan,
  type ResolvedAuthorizationPlan,
} from "@mcpjam/sdk/browser";

interface AuthenticationSectionProps {
  serverUrl?: string;
  authType: "oauth" | "bearer" | "none";
  onAuthTypeChange: (value: "oauth" | "bearer" | "none") => void;
  showAuthSettings: boolean;
  bearerToken: string;
  onBearerTokenChange: (value: string) => void;
  oauthScopesInput: string;
  onOauthScopesChange: (value: string) => void;
  useCustomClientId: boolean;
  onUseCustomClientIdChange: (value: boolean) => void;
  clientId: string;
  onClientIdChange: (value: string) => void;
  clientSecret: string;
  onClientSecretChange: (value: string) => void;
  clientIdError: string | null;
  clientSecretError: string | null;
}

function getPlanStatusLabel(plan: ResolvedAuthorizationPlan): string {
  if (plan.status === "blocked") {
    return "Action needed";
  }

  if (plan.status === "discovery_required") {
    return "Automatic";
  }

  switch (plan.registrationStrategy) {
    case "preregistered":
      return "Pre-registered";
    case "cimd":
      return "CIMD";
    case "dcr":
      return "DCR";
    default:
      return "Ready";
  }
}

export function AuthenticationSection({
  serverUrl,
  authType,
  onAuthTypeChange,
  showAuthSettings,
  bearerToken,
  onBearerTokenChange,
  oauthScopesInput,
  onOauthScopesChange,
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
  const oauthPlan =
    authType === "oauth"
      ? resolveAuthorizationPlan({
          serverUrl,
          protocolMode: "auto",
          registrationMode: useCustomClientId ? "preregistered" : "auto",
          clientId: useCustomClientId ? clientId : undefined,
          clientSecret: useCustomClientId ? clientSecret : undefined,
          authMode: "interactive",
        })
      : null;
  const planDetails = oauthPlan
    ? [
        `Protocol ${oauthPlan.protocolVersion}`,
        oauthPlan.canonicalResource
          ? `Resource ${oauthPlan.canonicalResource}`
          : undefined,
        useCustomClientId
          ? "Registration pre-registered"
          : "Automatic order: preregistered -> CIMD -> DCR",
      ].filter(Boolean)
    : [];

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
              <SelectItem value="oauth">MCP Authorization</SelectItem>
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
            {oauthPlan && (
              <div className="px-3 py-3 space-y-2 border-b border-border bg-background/60">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      MCP Authorization
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Uses the SDK planner to resolve pre-registered
                      credentials, Client ID Metadata Documents (CIMD), or
                      Dynamic Client Registration (DCR).
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    {getPlanStatusLabel(oauthPlan)}
                  </span>
                </div>

                <p
                  className={`text-sm ${
                    oauthPlan.status === "blocked"
                      ? "text-destructive"
                      : "text-foreground"
                  }`}
                >
                  {oauthPlan.summary}
                </p>

                <div className="flex flex-wrap gap-2">
                  {planDetails.map((detail) => (
                    <span
                      key={detail}
                      className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground"
                    >
                      {detail}
                    </span>
                  ))}
                </div>

                {oauthPlan.blockers.length > 0 && (
                  <p className="text-xs text-destructive">
                    {oauthPlan.blockers[0]}
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
                Manual Overrides
              </span>
            </button>

            {showAdvancedOAuth && (
              <div className="px-3 pb-3 space-y-3">
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
                  <p className="text-xs text-muted-foreground">
                    Leave empty to let the SDK use 401 challenge scopes first,
                    then protected resource metadata.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="useCustomClientId"
                      checked={useCustomClientId}
                      onChange={(e) =>
                        onUseCustomClientIdChange(e.target.checked)
                      }
                      className="rounded"
                    />
                    <label
                      htmlFor="useCustomClientId"
                      className="text-sm font-medium text-foreground"
                    >
                      Use pre-registered OAuth credentials
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Leave unchecked to let the SDK discover preregistered,
                    CIMD, or DCR automatically.
                  </p>
                </div>

                {useCustomClientId && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-foreground">
                        Client ID
                      </label>
                      <Input
                        value={clientId}
                        onChange={(e) => onClientIdChange(e.target.value)}
                        placeholder="Your OAuth Client ID"
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
