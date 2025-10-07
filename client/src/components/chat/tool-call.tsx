import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  Clock,
  Copy,
  Check,
} from "lucide-react";
import { ToolCall, ToolResult } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { MCPIcon } from "../ui/mcp-icon";
import { UIResourceRenderer } from "@mcp-ui/client";
import { MastraMCPServerDefinition } from "@mastra/mcp";
import { OpenAIComponentRenderer } from "./openai-component-renderer";

interface ToolCallDisplayProps {
  toolCall: ToolCall;
  toolResult?: ToolResult;
  className?: string;
  serverConfigs?: Record<string, MastraMCPServerDefinition>;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
  onSendFollowup?: (message: string) => void;
}

// JSON syntax highlighting component
function JsonDisplay({ data, className }: { data: any; className?: string }) {
  const [copied, setCopied] = useState(false);
  const jsonString = JSON.stringify(data, null, 2);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const formatJson = (str: string) => {
    return str
      .replace(
        /"([^"]+)":/g,
        '<span class="text-blue-600/70 dark:text-blue-400/70">"$1"</span>:',
      )
      .replace(/: "([^"]*)"/g, ': <span class="text-foreground">"$1"</span>')
      .replace(
        /: (true|false)/g,
        ': <span class="text-purple-600/70 dark:text-purple-400/70">$1</span>',
      )
      .replace(
        /: (null)/g,
        ': <span class="text-muted-foreground/60">$1</span>',
      )
      .replace(
        /: (-?\d+(?:\.\d+)?)/g,
        ': <span class="text-orange-600/70 dark:text-orange-400/70">$1</span>',
      );
  };

  return (
    <div className={cn("relative group", className)}>
      <button
        onClick={copyToClipboard}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
        title="Copy JSON"
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-600/70 dark:text-green-400/70" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-3 bg-muted/20 rounded-md border">
        <code
          dangerouslySetInnerHTML={{
            __html: formatJson(jsonString),
          }}
        />
      </pre>
    </div>
  );
}

// Collapsible JSON tree view for complex objects
function JsonTree({ data, depth = 0 }: { data: any; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);

  if (typeof data !== "object" || data === null) {
    return (
      <span
        className={cn(
          "text-sm",
          typeof data === "string" && "text-foreground",
          typeof data === "number" &&
            "text-orange-600/70 dark:text-orange-400/70",
          typeof data === "boolean" &&
            "text-purple-600/70 dark:text-purple-400/70",
          data === null && "text-muted-foreground/60",
        )}
      >
        {typeof data === "string" ? `"${data}"` : String(data)}
      </span>
    );
  }

  const isArray = Array.isArray(data);
  const entries = isArray
    ? data.map((item, i) => [i, item])
    : Object.entries(data);
  const bracketOpen = isArray ? "[" : "{";
  const bracketClose = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        {bracketOpen}
        {bracketClose}
      </span>
    );
  }

  return (
    <div className="text-sm">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 hover:bg-muted/50 rounded px-1 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="text-muted-foreground">
          {bracketOpen} {!isExpanded && `${entries.length} items`}
        </span>
      </button>
      {isExpanded && (
        <div className="ml-4 border-l border-border pl-2 space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <span className="text-blue-600/70 dark:text-blue-400/70 font-medium min-w-0 flex-shrink-0">
                {isArray ? `[${key}]` : `"${key}"`}:
              </span>
              <div className="min-w-0 flex-1">
                <JsonTree data={value} depth={depth + 1} />
              </div>
            </div>
          ))}
        </div>
      )}
      {isExpanded && (
        <span className="text-muted-foreground ml-4">{bracketClose}</span>
      )}
    </div>
  );
}

export function ToolCallDisplay({
  toolCall,
  toolResult,
  className,
  serverConfigs,
  onCallTool,
  onSendFollowup,
}: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showJsonTree, setShowJsonTree] = useState(false);

  // Determine the effective status based on toolResult presence
  const getEffectiveStatus = () => {
    if (toolResult) {
      return toolResult.error ? "error" : "completed";
    }
    return toolCall.status;
  };

  const effectiveStatus = getEffectiveStatus();

  const getStatusIcon = () => {
    switch (effectiveStatus) {
      case "completed":
        return (
          <div className="relative">
            <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70" />
            <div className="absolute inset-0 animate-ping">
              <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70 opacity-20" />
            </div>
          </div>
        );
      case "error":
        return (
          <div className="relative">
            <XCircle className="h-4 w-4 text-red-600/70 dark:text-red-400/70" />
            <div className="absolute inset-0 animate-pulse">
              <XCircle className="h-4 w-4 text-red-600/70 dark:text-red-400/70 opacity-30" />
            </div>
          </div>
        );
      case "executing":
        return (
          <div className="relative">
            <Clock className="h-4 w-4 text-blue-600/70 dark:text-blue-400/70 animate-spin" />
            <div className="absolute inset-0 animate-ping">
              <div className="h-4 w-4 bg-blue-600/30 dark:bg-blue-400/30 rounded-full" />
            </div>
          </div>
        );
      default:
        return <Clock className="h-4 w-4 text-muted-foreground/60" />;
    }
  };

  return (
    <div
      className={cn(
        "border rounded-lg bg-gradient-to-br from-muted/20 to-muted/40 backdrop-blur-sm shadow-sm hover:shadow-md transition-all duration-200",
        effectiveStatus === "completed" &&
          "border-green-200/50 dark:border-green-800/50",
        effectiveStatus === "error" &&
          "border-red-200/50 dark:border-red-800/50",
        effectiveStatus === "executing" &&
          "border-blue-200/50 dark:border-blue-800/50 shadow-md animate-pulse",
        className,
      )}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-all duration-200 rounded-t-lg"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-background/50 border">
            <MCPIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex items-center gap-3">
            <span className="font-semibold text-sm">{toolCall.name}</span>
            {effectiveStatus === "executing" && (
              <span className="text-xs text-blue-600/70 dark:text-blue-400/70 font-medium">
                Running...
              </span>
            )}
            {getStatusIcon()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t bg-background/30 backdrop-blur-sm">
          {/* Parameters */}
          {Object.keys(toolCall.parameters).length > 0 && (
            <div className="p-4 border-b border-border/50">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-600/70 dark:bg-blue-400/70"></div>
                  Parameters
                </h4>
                <button
                  onClick={() => setShowJsonTree(!showJsonTree)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded bg-muted/50 hover:bg-muted"
                >
                  {showJsonTree ? "Raw JSON" : "Tree View"}
                </button>
              </div>
              {showJsonTree ? (
                <JsonTree data={toolCall.parameters} />
              ) : (
                <JsonDisplay data={toolCall.parameters} />
              )}
            </div>
          )}

          {/* Result */}
          {toolResult && (
            <div className="p-4">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <div
                  className={cn(
                    "w-2 h-2 rounded-full",
                    toolResult.error
                      ? "bg-red-600/70 dark:bg-red-400/70"
                      : "bg-green-600/70 dark:bg-green-400/70",
                  )}
                ></div>
                {toolResult.error ? "Error" : "Result"}
              </h4>
              <div>
                {toolResult.error ? (
                  <div className="bg-red-50/30 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/50 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-red-600/70 dark:text-red-400/70 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium text-foreground mb-1">
                          Tool execution failed
                        </p>
                        <p className="text-muted-foreground text-sm">
                          {toolResult.error}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-green-50/30 dark:bg-green-950/20 border border-green-200/50 dark:border-green-800/50 rounded-lg">
                    <div className="flex items-center gap-2 px-4 py-2 bg-green-100/30 dark:bg-green-900/20 border-b border-green-200/50 dark:border-green-800/50">
                      <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70" />
                      <span className="text-sm font-medium text-foreground">
                        Tool executed successfully
                      </span>
                    </div>
                    <div className="p-4">
                      {(() => {
                        // Check for OpenAI Apps SDK component URL in _meta
                        const extractOpenAIComponent = (
                          payload: any,
                        ): { url: string; htmlBlob?: string } | null => {
                          if (!payload) return null;

                          // If payload is an array, try the first element
                          const actualPayload = Array.isArray(payload) ? payload[0] : payload;
                          if (!actualPayload) return null;

                          const meta = actualPayload?._meta;
                          if (meta && typeof meta === "object") {
                            const outputTemplate = meta["openai/outputTemplate"];
                            if (
                              outputTemplate &&
                              typeof outputTemplate === "string"
                            ) {
                              // For ui:// URIs, we need to extract the HTML blob
                              if (outputTemplate.startsWith("ui://")) {
                                // Look for the resource content in the payload
                                // Check if there's a resource with matching URI
                                const findResource = (obj: any): any => {
                                  if (!obj) return null;

                                  // Check direct resource
                                  if (obj.resource?.uri === outputTemplate) {
                                    return obj.resource;
                                  }

                                  // Check content array
                                  if (Array.isArray(obj.content)) {
                                    for (const item of obj.content) {
                                      if (item?.type === "resource" && item?.resource?.uri === outputTemplate) {
                                        return item.resource;
                                      }
                                    }
                                  }

                                  return null;
                                };

                                const resource = findResource(actualPayload);
                                if (resource?.blob || resource?.text) {
                                  return {
                                    url: outputTemplate,
                                    htmlBlob: resource.blob || resource.text,
                                  };
                                }

                                // If no blob found, return URL anyway - the HTTP endpoint will fetch it
                                console.log(
                                  `[Tool Call] OpenAI component ui:// URI will be fetched via HTTP: ${outputTemplate}`
                                );
                                return { url: outputTemplate };
                              }

                              // Return HTTP(S) URLs as-is
                              return { url: outputTemplate };
                            }
                          }
                          return null;
                        };

                        const extractUIResource = (
                          payload: any,
                        ): any | null => {
                          if (!payload) return null;

                          // If payload is an array, try the first element
                          const actualPayload = Array.isArray(payload) ? payload[0] : payload;
                          if (!actualPayload) return null;

                          const direct = actualPayload?.resource;
                          if (
                            direct &&
                            typeof direct === "object" &&
                            typeof direct.uri === "string" &&
                            direct.uri.startsWith("ui://")
                          ) {
                            return direct;
                          }
                          const content = actualPayload?.content;
                          if (Array.isArray(content)) {
                            for (const item of content) {
                              if (
                                item?.type === "resource" &&
                                item?.resource?.uri &&
                                typeof item.resource.uri === "string" &&
                                item.resource.uri.startsWith("ui://")
                              ) {
                                return item.resource;
                              }
                            }
                          }
                          return null;
                        };

                        // 1. Check for OpenAI component first
                        // toolResult.result now contains the full MCP response: { result: {...}, _meta: {...} }
                        console.log("[Tool Call] DEBUG - Raw toolResult:", toolResult);
                        console.log("[Tool Call] DEBUG - toolResult.result:", (toolResult as any)?.result);
                        const fullResult = (toolResult as any)?.result;
                        console.log("[Tool Call] DEBUG - fullResult:", fullResult);
                        console.log("[Tool Call] DEBUG - fullResult._meta:", (fullResult as any)?._meta);
                        const openaiComponent = extractOpenAIComponent(fullResult);
                        console.log("[Tool Call] OpenAI component detected:", openaiComponent, "from fullResult:", fullResult);

                        if (openaiComponent) {
                          // Extract serverId from tool name if it has a prefix (e.g., "pizzaz:pizza-map")
                          let serverId: string | undefined;
                          console.log("[Tool Call] Tool name:", toolCall.name);

                          if (toolCall.name.includes(":")) {
                            const [prefix] = toolCall.name.split(":", 2);
                            serverId = prefix;
                            console.log("[Tool Call] Extracted serverId from tool name:", serverId);
                          } else {
                            // Fallback: find server that likely has this tool
                            // Skip numeric keys (like '3') and prefer named servers
                            console.log("[Tool Call] serverConfigs:", serverConfigs);
                            const serverKeys = serverConfigs ? Object.keys(serverConfigs) : [];
                            console.log("[Tool Call] serverConfigs keys:", serverKeys);

                            // Filter out numeric keys and prefer the first valid server name
                            const validServerKeys = serverKeys.filter(key => isNaN(Number(key)));

                            // Try to match tool name with server name
                            // e.g., "pizza-map" might be from "pizzaz" server
                            const toolNameLower = toolCall.name.toLowerCase();
                            const matchingServer = validServerKeys.find(key =>
                              toolNameLower.includes(key.toLowerCase()) ||
                              key.toLowerCase().includes(toolNameLower.split('-')[0])
                            );

                            serverId = matchingServer ||
                              (validServerKeys.length > 0 ? validServerKeys[0] :
                                (serverKeys.length > 0 ? serverKeys[0] : undefined));
                          }

                          console.log("[Tool Call] Rendering OpenAI component with serverId:", serverId);

                          return (
                            <OpenAIComponentRenderer
                              componentUrl={openaiComponent.url}
                              toolCall={toolCall}
                              toolResult={toolResult}
                              onCallTool={onCallTool}
                              onSendFollowup={onSendFollowup}
                              uiResourceBlob={openaiComponent.htmlBlob}
                              serverId={serverId}
                            />
                          );
                        }

                        // 2. Check for MCP-UI resource
                        const uiRes = extractUIResource(fullResult);
                        if (uiRes) {
                          return (
                            <UIResourceRenderer
                              resource={uiRes}
                              htmlProps={{
                                autoResizeIframe: true,
                                style: { width: "100%", overflow: "visible" },
                              }}
                              onUIAction={async (evt) => {
                                if (
                                  evt.type === "tool" &&
                                  evt.payload?.toolName
                                ) {
                                  const serverIdToUse = (():
                                    | string
                                    | undefined => {
                                    if (
                                      serverConfigs &&
                                      typeof serverConfigs === "object" &&
                                      Object.keys(serverConfigs).length === 1
                                    ) {
                                      const onlyKey =
                                        Object.keys(serverConfigs)[0];
                                      return onlyKey;
                                    }
                                    return undefined;
                                  })();

                                  fetch("/api/mcp/tools/execute", {
                                    method: "POST",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      toolName: evt.payload.toolName,
                                      parameters: evt.payload.params || {},
                                      ...(serverIdToUse
                                        ? { serverId: serverIdToUse }
                                        : {}),
                                    }),
                                  }).catch(() => {});
                                } else if (
                                  evt.type === "link" &&
                                  evt.payload?.url
                                ) {
                                  window.open(
                                    evt.payload.url,
                                    "_blank",
                                    "noopener,noreferrer",
                                  );
                                }
                                return { status: "handled" } as any;
                              }}
                            />
                          );
                        }

                        // 3. Fallback to JSON display
                        // Display the actual result content, not the wrapper
                        const displayData = fullResult?.result || fullResult;
                        return typeof displayData === "object" ? (
                          <JsonDisplay data={displayData} />
                        ) : (
                          <div className="text-sm text-foreground bg-muted/30 p-3 rounded border">
                            {String(displayData)}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
