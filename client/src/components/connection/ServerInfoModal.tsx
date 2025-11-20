import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Copy, Check, ExternalLink } from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import type { ListToolsResultWithMetadata } from "@/lib/mcp-tools-api";

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

  const initializationInfo = server.initializationInfo;

  // Extract server info
  const serverName = initializationInfo?.serverVersion?.name;
  const serverTitle = initializationInfo?.serverVersion?.title;
  const version = initializationInfo?.serverVersion?.version;
  const websiteUrl = initializationInfo?.serverVersion?.websiteUrl;
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

  // Check if this is an OpenAI app
  const isOpenAIApp =
    toolsData?.toolsMetadata && Object.keys(toolsData.toolsMetadata).length > 0;

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  };

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
            {isOpenAIApp && (
              <img
                src="/openai_logo.png"
                alt="OpenAI App"
                className="h-5 w-5 flex-shrink-0"
                title="OpenAI App"
              />
            )}
          </DialogTitle>
        </DialogHeader>

        {isOpenAIApp ? (
          <Tabs defaultValue="info" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Server Info</TabsTrigger>
              <TabsTrigger value="metadata">OpenAI Metadata</TabsTrigger>
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
                    Server Capabilities (Raw)
                  </div>
                  <div className="relative">
                    <pre className="text-sm font-mono bg-muted/30 p-3 rounded border border-border/20 overflow-x-auto max-h-96 overflow-y-auto">
                      {JSON.stringify(serverCapabilities, null, 2)}
                    </pre>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        copyToClipboard(
                          JSON.stringify(serverCapabilities, null, 2),
                          "serverCapabilities",
                        );
                      }}
                      className="absolute top-2 right-2 p-2 text-muted-foreground hover:text-foreground transition-colors bg-muted/50 rounded"
                    >
                      {copiedField === "serverCapabilities" ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {clientCapabilities && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2">
                    Client Capabilities (Raw)
                  </div>
                  <div className="relative">
                    <pre className="text-sm font-mono bg-muted/30 p-3 rounded border border-border/20 overflow-x-auto max-h-96 overflow-y-auto">
                      {JSON.stringify(clientCapabilities, null, 2)}
                    </pre>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        copyToClipboard(
                          JSON.stringify(clientCapabilities, null, 2),
                          "clientCapabilities",
                        );
                      }}
                      className="absolute top-2 right-2 p-2 text-muted-foreground hover:text-foreground transition-colors bg-muted/50 rounded"
                    >
                      {copiedField === "clientCapabilities" ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
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
            </TabsContent>

            <TabsContent value="metadata" className="space-y-4 mt-4">
              {toolsData?.tools && toolsData.toolsMetadata ? (
                <div className="space-y-4">
                  {toolsData.tools
                    .filter((tool: any) => toolsData.toolsMetadata?.[tool.name])
                    .map((tool: any) => {
                      const metadata = toolsData.toolsMetadata?.[tool.name];

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
                                {metadata.write !== undefined && (
                                  <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded uppercase">
                                    {metadata.write ? "WRITE" : "READ"}
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                {tool.description || "No description available"}
                              </p>
                            </div>
                          </div>

                          {/* Metadata Section */}
                          <div className="pt-3 border-t border-border/50">
                            <div className="text-xs text-muted-foreground font-medium mb-3">
                              METADATA
                            </div>

                            {Object.entries(metadata).map(([key, value]) => {
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
                            })}
                          </div>
                        </div>
                      );
                    })}
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
                  Server Capabilities (Raw)
                </div>
                <div className="relative">
                  <pre className="text-sm font-mono bg-muted/30 p-3 rounded border border-border/20 overflow-x-auto max-h-96 overflow-y-auto">
                    {JSON.stringify(serverCapabilities, null, 2)}
                  </pre>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(
                        JSON.stringify(serverCapabilities, null, 2),
                        "serverCapabilities",
                      );
                    }}
                    className="absolute top-2 right-2 p-2 text-muted-foreground hover:text-foreground transition-colors bg-muted/50 rounded"
                  >
                    {copiedField === "serverCapabilities" ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {clientCapabilities && (
              <div>
                <div className="text-sm font-medium text-muted-foreground mb-2">
                  Client Capabilities (Raw)
                </div>
                <div className="relative">
                  <pre className="text-sm font-mono bg-muted/30 p-3 rounded border border-border/20 overflow-x-auto max-h-96 overflow-y-auto">
                    {JSON.stringify(clientCapabilities, null, 2)}
                  </pre>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(
                        JSON.stringify(clientCapabilities, null, 2),
                        "clientCapabilities",
                      );
                    }}
                    className="absolute top-2 right-2 p-2 text-muted-foreground hover:text-foreground transition-colors bg-muted/50 rounded"
                  >
                    {copiedField === "clientCapabilities" ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                </div>
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
