import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AuthenticationSectionProps {
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

export function AuthenticationSection({
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
  return (
    <div className="space-y-4">
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="p-3 space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Authentication
          </label>
          <Select value={authType} onValueChange={onAuthTypeChange}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Authentication</SelectItem>
              <SelectItem value="bearer">Bearer Token</SelectItem>
              <SelectItem value="oauth">OAuth 2.0</SelectItem>
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
          <div className="px-3 pb-3 space-y-3 border-t border-border bg-muted/30">
            <div className="space-y-2 pt-3">
              <label className="block text-sm font-medium text-foreground">
                OAuth Scopes
              </label>
              <Input
                value={oauthScopesInput}
                onChange={(e) => onOauthScopesChange(e.target.value)}
                placeholder="mcp:* or custom scopes separated by spaces"
                className="h-10"
              />
              <p className="text-xs text-muted-foreground">
                Default: mcp:* (space-separated for multiple scopes)
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="useCustomClientId"
                  checked={useCustomClientId}
                  onChange={(e) => onUseCustomClientIdChange(e.target.checked)}
                  className="rounded"
                />
                <label
                  htmlFor="useCustomClientId"
                  className="text-sm font-medium text-foreground"
                >
                  Use custom OAuth credentials
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave unchecked to use the server's default OAuth flow
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
                    <p className="text-xs text-red-500">{clientSecretError}</p>
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
    </div>
  );
}
