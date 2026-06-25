import { useId, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
} from "lucide-react";
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
}: XaaCredentialFieldsProps) {
  const [showAdvanced, setShowAdvanced] = useState(defaultAdvancedOpen);
  const [isSecretVisible, setIsSecretVisible] = useState(false);
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
