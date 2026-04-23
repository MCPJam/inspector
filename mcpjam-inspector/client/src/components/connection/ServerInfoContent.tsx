import { useState } from "react";
import {
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { getStoredTokensState } from "@/lib/oauth/mcp-oauth";
import { getOAuthTraceFailureStep } from "@/lib/oauth/oauth-trace";
import { decodeJWT } from "@/lib/oauth/jwt-decoder";
import { ScrollableJsonView } from "@/components/ui/json-editor";

interface ServerInfoContentProps {
  server: ServerWithName;
  needsReconnect?: boolean;
}

export function ServerInfoContent({
  server,
  needsReconnect = false,
}: ServerInfoContentProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedTokens, setExpandedTokens] = useState<Set<string>>(new Set());

  const storedTokensState = server.oauthTokens
    ? { tokens: undefined, isInvalid: false }
    : getStoredTokensState(server.name);
  const oauthTokens = server.oauthTokens ?? storedTokensState.tokens;
  const hasInvalidStoredAuthData =
    server.oauthTokens == null && storedTokensState.isInvalid;
  const isHttpServer = "url" in server.config;

  const initializationInfo = server.initializationInfo;

  // Extract server info
  const serverName = initializationInfo?.serverVersion?.name;
  const serverTitle = initializationInfo?.serverVersion?.title;
  const serverIcon = initializationInfo?.serverVersion?.icons?.[0];
  const websiteUrl = initializationInfo?.serverVersion?.websiteUrl;
  const protocolVersion = initializationInfo?.protocolVersion;
  const transport = initializationInfo?.transport;
  const instructions = initializationInfo?.instructions;
  const serverCapabilities = initializationInfo?.serverCapabilities;
  const clientCapabilities = initializationInfo?.clientCapabilities;
  const oauthTrace = server.lastOAuthTrace;
  const oauthFailureStep = getOAuthTraceFailureStep(oauthTrace);

  // Build capabilities list
  const capabilities: string[] = [];
  if (serverCapabilities?.tools) capabilities.push("Tools");
  if (serverCapabilities?.prompts) capabilities.push("Prompts");
  if (serverCapabilities?.resources) capabilities.push("Resources");

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  };

  const toggleTokenExpansion = (tokenName: string) => {
    setExpandedTokens((prev) => {
      const next = new Set(prev);
      if (next.has(tokenName)) {
        next.delete(tokenName);
      } else {
        next.add(tokenName);
      }
      return next;
    });
  };

  const renderToken = (
    label: string,
    tokenValue: string | undefined,
    tokenKey: string,
  ) => {
    if (!tokenValue) return null;
    const decoded = decodeJWT(tokenValue);

    return (
      <div>
        <span className="text-muted-foreground font-medium">{label}:</span>
        <div
          className="font-mono text-foreground break-all bg-background/50 p-2 rounded mt-1 relative group cursor-pointer hover:bg-background/70 transition-colors"
          onClick={() => toggleTokenExpansion(tokenKey)}
        >
          <div className="pr-8">
            {expandedTokens.has(tokenKey) || tokenValue.length <= 50
              ? tokenValue
              : `${tokenValue.substring(0, 50)}...`}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(tokenValue, tokenKey);
            }}
            className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
          >
            {copiedField === tokenKey ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
        {decoded && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => toggleTokenExpansion(`${tokenKey}Decoded`)}
              className="text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
            >
              {expandedTokens.has(`${tokenKey}Decoded`) ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              View Decoded JWT
            </button>
            {expandedTokens.has(`${tokenKey}Decoded`) && (
              <ScrollableJsonView
                value={decoded}
                showLineNumbers={false}
                containerClassName="mt-1 max-h-96 rounded-lg"
              />
            )}
          </div>
        )}
      </div>
    );
  };

  const renderOAuthTokensSection = () => {
    if (!isHttpServer) return null;

    if (hasInvalidStoredAuthData) {
      return (
        <div className="space-y-3 text-xs pt-2">
          <div className="text-sm font-medium text-muted-foreground">
            OAuth Tokens
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            Saved auth data is invalid. Reconnect this server to refresh tokens.
          </div>
        </div>
      );
    }

    if (!oauthTokens) return null;

    return (
      <div className="space-y-3 text-xs pt-2">
        <div className="text-sm font-medium text-muted-foreground">
          OAuth Tokens
        </div>
        <div className="space-y-3 rounded-md bg-muted/40 p-3">
          {renderToken("Access Token", oauthTokens.access_token, "accessToken")}
          {renderToken(
            "Refresh Token",
            oauthTokens.refresh_token,
            "refreshToken",
          )}
          {renderToken("ID Token", (oauthTokens as any).id_token, "idToken")}

          <div className="flex flex-wrap gap-4 text-muted-foreground pt-1">
            <span>Type: {oauthTokens.token_type || "Bearer"}</span>
            {oauthTokens.expires_in && (
              <span>Expires in: {oauthTokens.expires_in}s</span>
            )}
            {oauthTokens.scope && <span>Scope: {oauthTokens.scope}</span>}
          </div>
        </div>
      </div>
    );
  };

  const renderOAuthTraceSection = () => {
    if (!oauthTrace) {
      return null;
    }

    return (
      <div className="space-y-3 text-xs pt-2">
        <div className="text-sm font-medium text-muted-foreground">
          Last OAuth Trace
        </div>
        <div className="space-y-3 rounded-md bg-muted/40 p-3">
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span>Source: {oauthTrace.source.replaceAll("_", " ")}</span>
            <span>Current step: {oauthTrace.currentStep}</span>
            {oauthFailureStep?.error ? (
              <span className="text-destructive">
                Failure: {oauthFailureStep.title}
              </span>
            ) : null}
          </div>

          <div className="space-y-2">
            {oauthTrace.steps.map((step, index) => (
              <div
                key={`${step.step}-${index}-${step.startedAt}`}
                className="rounded-md border border-border/40 bg-background/60 p-2"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    {step.title}
                  </span>
                  <span
                    className={
                      step.status === "error"
                        ? "text-destructive"
                        : step.status === "success"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-amber-600 dark:text-amber-400"
                    }
                  >
                    {step.status}
                  </span>
                </div>
                {step.message ? (
                  <div className="mt-1 text-sm text-muted-foreground">
                    {step.message}
                  </div>
                ) : null}
                {step.error ? (
                  <div className="mt-1 break-all text-sm text-destructive">
                    {step.error}
                  </div>
                ) : null}
                {step.details ? (
                  <ScrollableJsonView
                    value={step.details}
                    showLineNumbers={false}
                    containerClassName="mt-2 max-h-48 rounded-lg"
                  />
                ) : null}
              </div>
            ))}
          </div>

          {oauthTrace.httpHistory.length > 0 ? (
            <div>
              <div className="mb-2 text-sm font-medium text-muted-foreground">
                HTTP History
              </div>
              <ScrollableJsonView
                value={oauthTrace.httpHistory}
                showLineNumbers={false}
                containerClassName="max-h-96 rounded-lg"
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const renderIconRow = () => (
    <div>
      <div className="text-sm font-medium text-muted-foreground mb-1">Icon</div>
      {serverIcon?.src ? (
        <img
          src={serverIcon.src}
          alt={serverTitle || serverName || "Server icon"}
          className="h-10 w-10 rounded border border-border/40 bg-muted object-contain"
        />
      ) : (
        <div className="text-sm text-muted-foreground italic">
          No icon provided
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {server.lastError ? (
        <div className="rounded-md border border-red-300/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          <div className="font-medium">
            {oauthFailureStep
              ? `OAuth failed during ${oauthFailureStep.title}`
              : "Last connection error"}
          </div>
          <div className="mt-1 break-all">{server.lastError}</div>
        </div>
      ) : null}
      {needsReconnect ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
          Saved client capabilities differ from this server's last initialize
          payload. Reconnect the server to apply the workspace client profile.
        </div>
      ) : null}
      {serverName && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Server Name
          </div>
          <div className="text-sm font-mono">{serverName}</div>
        </div>
      )}

      {serverTitle && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Server Title
          </div>
          <div className="text-sm">{serverTitle}</div>
        </div>
      )}

      {renderIconRow()}

      {protocolVersion && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-1">
            MCP Protocol Version
          </div>
          <div className="text-sm">{protocolVersion}</div>
        </div>
      )}

      {transport && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Transport
          </div>
          <div className="text-sm font-mono">{transport}</div>
        </div>
      )}

      {capabilities.length > 0 && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-1">
            Capabilities
          </div>
          <div className="text-sm">{capabilities.join(", ")}</div>
        </div>
      )}

      {instructions && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-2">
            Instructions
          </div>
          <div className="text-sm whitespace-pre-wrap bg-muted/30 p-3 rounded border border-border/20">
            {instructions}
          </div>
        </div>
      )}

      {serverCapabilities && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-2">
            Server Capabilities
          </div>
          <ScrollableJsonView
            value={serverCapabilities}
            showLineNumbers={false}
            containerClassName="max-h-96 rounded-lg"
          />
        </div>
      )}

      {clientCapabilities && (
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-2">
            Client Capabilities
          </div>
          <ScrollableJsonView
            value={clientCapabilities}
            showLineNumbers={false}
            containerClassName="max-h-96 rounded-lg"
          />
        </div>
      )}

      {websiteUrl && websiteUrl.startsWith("https://") && (
        <div>
          <a
            href={websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline inline-flex items-center gap-1"
          >
            Visit documentation
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      )}

      {renderOAuthTokensSection()}
      {renderOAuthTraceSection()}
    </div>
  );
}
