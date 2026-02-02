import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";
import { decodeJWT } from "@/lib/oauth/jwt-decoder";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { JsonEditor } from "@/components/ui/json-editor";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

interface ServerInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  server: ServerWithName;
  toolsData: ListToolsResultWithMetadata | null;
}

export function ServerInfoModal({
  isOpen,
  onClose,
  server,
  toolsData,
}: ServerInfoModalProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedTokens, setExpandedTokens] = useState<Set<string>>(new Set());

  const oauthTokens = server.oauthTokens || getStoredTokens(server.name);
  const isHttpServer = "url" in server.config;

  useEffect(() => {
    if (!isOpen) {
      setCopiedField(null);
      setExpandedTokens(new Set());
    }
  }, [isOpen, server.name]);

  const initializationInfo = server.initializationInfo;

  // Extract server info
  const serverName = initializationInfo?.serverVersion?.name;
  const serverTitle = initializationInfo?.serverVersion?.title;
  const version = initializationInfo?.serverVersion?.version;
  const websiteUrl = initializationInfo?.serverVersion?.websiteUrl;
  const serverIcon = initializationInfo?.serverVersion?.icons?.[0];
  const protocolVersion = initializationInfo?.protocolVersion;
  const transport = initializationInfo?.transport;
  const instructions = initializationInfo?.instructions;
  const serverCapabilities = initializationInfo?.serverCapabilities;
  const clientCapabilities = initializationInfo?.clientCapabilities;

  // Build capabilities list
  const capabilities: string[] = [];
  if (serverCapabilities?.tools) capabilities.push("Tools");
  if (serverCapabilities?.prompts) capabilities.push("Prompts");
  if (serverCapabilities?.resources) capabilities.push("Resources");

  // Check if this is an MCP App (has tools with ui.resourceUri metadata)
  const isMCPAppServer = isMCPApp(toolsData);

  // Check if this is an OpenAI app (has tools with openai/outputTemplate metadata)
  const isOpenAIAppServer = isOpenAIApp(toolsData);

  // Check if this is an OpenAI app and MCP app (has tools with openai/outputTemplate and ui.resourceUri metadata)
  const isOpenAIAppAndMCPAppServer = isOpenAIAppAndMCPApp(toolsData);

  // Has any widget metadata (either MCP App or OpenAI App)
  const hasWidgetMetadata =
    isMCPAppServer || isOpenAIAppServer || isOpenAIAppAndMCPAppServer;
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
              <div className="mt-1">
                <JsonEditor value={decoded} readOnly showToolbar={false} />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderOAuthTokensSection = () => {
    if (!isHttpServer || !oauthTokens) return null;

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
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {server.name}
            {version && (
              <span className="text-sm text-muted-foreground font-normal">
                v{version}
              </span>
            )}
            {(isOpenAIAppServer || isOpenAIAppAndMCPAppServer) && (
              <img
                src="/openai_logo.png"
                alt="OpenAI App"
                className="h-5 w-5 flex-shrink-0"
                title="OpenAI App"
              />
            )}
            {(isMCPAppServer || isOpenAIAppAndMCPAppServer) && (
              <img
                src="/mcp.svg"
                alt="MCP App"
                className="h-5 w-5 flex-shrink-0 dark:invert"
                title="MCP App"
              />
            )}
          </DialogTitle>
        </DialogHeader>

        {hasWidgetMetadata ? (
          <Tabs defaultValue="info" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Server Info</TabsTrigger>
              <TabsTrigger value="metadata">Tools Metadata</TabsTrigger>
            </TabsList>

            <TabsContent value="info" className="space-y-4 mt-4">
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
                  <JsonEditor
                    value={serverCapabilities}
                    readOnly
                    showToolbar={false}
                    maxHeight="384px"
                  />
                </div>
              )}

              {clientCapabilities && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2">
                    Client Capabilities
                  </div>
                  <JsonEditor
                    value={clientCapabilities}
                    readOnly
                    showToolbar={false}
                    maxHeight="384px"
                  />
                </div>
              )}

              {websiteUrl && (
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
            </TabsContent>

            <TabsContent value="metadata" className="space-y-4 mt-4">
              {(toolsData?.tools ?? []).some(
                (tool) =>
                  (tool as Tool)?._meta ||
                  toolsData?.toolsMetadata?.[tool.name],
              ) ? (
                <div className="space-y-4">
                  {(toolsData?.tools ?? [])
                    .map((tool: Tool) => {
                      const metadata =
                        tool._meta ?? toolsData?.toolsMetadata?.[tool.name];
                      const annotations = tool.annotations;

                      if (!metadata) return null;
                      return (
                        <div
                          key={tool.name}
                          className="bg-muted/30 rounded-lg p-4 space-y-3"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <h4 className="font-medium text-sm">
                                  {tool.name}
                                </h4>
                                {metadata?.write !== undefined && (
                                  <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded uppercase">
                                    {metadata?.write ? "WRITE" : "READ"}
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                {tool.description || "No description available"}
                              </p>
                            </div>
                          </div>

                          {/* Metadata Section */}
                          {metadata && (
                            <div className="pt-3 border-t border-border/50">
                              <div className="text-xs text-muted-foreground font-medium mb-3">
                                METADATA
                              </div>

                              {Object.entries(metadata ?? {}).map(
                                ([key, value]) => {
                                  if (key === "write") return null;

                                  return (
                                    <div key={key} className="space-y-1 mt-2">
                                      <div className="text-xs text-muted-foreground">
                                        {key.replace(/([A-Z])/g, " $1").trim()}
                                      </div>
                                      <div
                                        className={`text-xs rounded px-2 py-1 ${
                                          typeof value === "string" &&
                                          value.includes("://")
                                            ? "font-mono bg-muted/50"
                                            : "bg-muted/50"
                                        }`}
                                      >
                                        {typeof value === "object"
                                          ? JSON.stringify(value, null, 2)
                                          : String(value)}
                                      </div>
                                    </div>
                                  );
                                },
                              )}
                            </div>
                          )}

                          {annotations && (
                            <div className="pt-3 border-t border-border/50">
                              <div className="text-xs text-muted-foreground font-medium mb-3">
                                ANNOTATIONS
                              </div>
                              <JsonEditor value={annotations} viewOnly />
                            </div>
                          )}
                        </div>
                      );
                    })
                    .filter(Boolean)}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground text-center py-8">
                  No widget metadata available
                </div>
              )}
            </TabsContent>
          </Tabs>
        ) : (
          <div className="space-y-4">
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
                <JsonEditor
                  value={serverCapabilities}
                  readOnly
                  showToolbar={false}
                  maxHeight="384px"
                />
              </div>
            )}

            {clientCapabilities && (
              <div>
                <div className="text-sm font-medium text-muted-foreground mb-2">
                  Client Capabilities
                </div>
                <JsonEditor
                  value={clientCapabilities}
                  readOnly
                  showToolbar={false}
                  maxHeight="384px"
                />
              </div>
            )}

            {websiteUrl && (
              <div>
                <a
                  href={websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                >
                  Website URL
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}

            {renderOAuthTokensSection()}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
