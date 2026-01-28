/**
 * X-Ray Event Card Component
 *
 * Displays a single X-ray event capturing an AI request with expandable sections
 * for messages, system prompt, tools, and configuration.
 */

import { useState } from "react";
import { ChevronDown, Copy, Cpu, MessageSquare, Settings, Wrench } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { toast } from "sonner";
import type { XRayLogEvent } from "@shared/xray-types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface XRayEventCardProps {
  event: XRayLogEvent;
}

function getRoleBadgeClass(role: string): string {
  switch (role) {
    case "system":
      return "bg-purple-500/10 text-purple-600 dark:text-purple-400";
    case "user":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "assistant":
      return "bg-green-500/10 text-green-600 dark:text-green-400";
    case "tool":
      return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function copyToClipboard(data: unknown, label: string) {
  navigator.clipboard
    .writeText(typeof data === "string" ? data : JSON.stringify(data, null, 2))
    .then(() => toast.success(`${label} copied to clipboard`))
    .catch(() => toast.error(`Failed to copy ${label}`));
}

export function XRayEventCard({ event }: XRayEventCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("messages");

  const messageCount = event.messages.length;
  const toolCount = event.tools.length;
  const hasSystemPrompt = !!event.systemPrompt;

  return (
    <div className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card border-l-4 border-l-cyan-500/50">
      {/* Header */}
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <div className="flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform rotate-180" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
          )}
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Cpu className="h-3.5 w-3.5 text-cyan-500 flex-shrink-0" />
          <span className="text-xs font-mono text-foreground truncate">
            {event.model.provider}/{event.model.id}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-[9px] px-1.5 py-0",
              event.path === "mcpjam-backend"
                ? "border-purple-500/50 text-purple-500"
                : "border-blue-500/50 text-blue-500",
            )}
          >
            {event.path === "mcpjam-backend" ? "MCPJam" : "External"}
          </Badge>
          <span className="text-muted-foreground text-[10px] ml-auto whitespace-nowrap">
            {messageCount} msg{messageCount !== 1 ? "s" : ""} · {toolCount} tool
            {toolCount !== 1 ? "s" : ""}
          </span>
          <span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t bg-muted/20">
          <div className="p-3">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <div className="flex items-center justify-between mb-2">
                <TabsList className="h-7">
                  <TabsTrigger value="messages" className="text-xs h-6 px-2 gap-1">
                    <MessageSquare className="h-3 w-3" />
                    Messages
                  </TabsTrigger>
                  {hasSystemPrompt && (
                    <TabsTrigger value="system" className="text-xs h-6 px-2 gap-1">
                      <Settings className="h-3 w-3" />
                      System
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="tools" className="text-xs h-6 px-2 gap-1">
                    <Wrench className="h-3 w-3" />
                    Tools
                  </TabsTrigger>
                  <TabsTrigger value="config" className="text-xs h-6 px-2 gap-1">
                    <Cpu className="h-3 w-3" />
                    Config
                  </TabsTrigger>
                </TabsList>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyToClipboard(event, "Event");
                  }}
                  title="Copy full event"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>

              <TabsContent value="messages" className="mt-0">
                <div className="space-y-2 max-h-[50vh] overflow-auto">
                  {event.messages.map((msg, idx) => (
                    <div
                      key={idx}
                      className="rounded-md border border-border/30 bg-background/60 p-2"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[9px] px-1.5 py-0",
                            getRoleBadgeClass(msg.role),
                          )}
                        >
                          {msg.role}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyToClipboard(msg.content, `Message ${idx + 1}`);
                          }}
                          title="Copy message content"
                        >
                          <Copy className="h-2.5 w-2.5" />
                        </Button>
                      </div>
                      <div className="max-h-[200px] overflow-auto">
                        {typeof msg.content === "string" ? (
                          <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/80">
                            {msg.content}
                          </pre>
                        ) : (
                          <JsonView
                            src={msg.content as object}
                            dark={true}
                            theme="atom"
                            enableClipboard={true}
                            displaySize={false}
                            collapseStringsAfterLength={100}
                            style={{
                              fontSize: "11px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                              backgroundColor: "transparent",
                              padding: "0",
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                  {event.messages.length === 0 && (
                    <div className="text-center text-muted-foreground text-xs py-4">
                      No messages
                    </div>
                  )}
                </div>
              </TabsContent>

              {hasSystemPrompt && (
                <TabsContent value="system" className="mt-0">
                  <div className="relative rounded-md border border-border/30 bg-background/60 p-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-1 right-1 h-5 w-5"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyToClipboard(event.systemPrompt!, "System prompt");
                      }}
                      title="Copy system prompt"
                    >
                      <Copy className="h-2.5 w-2.5" />
                    </Button>
                    <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/80 max-h-[50vh] overflow-auto pr-6">
                      {event.systemPrompt}
                    </pre>
                  </div>
                </TabsContent>
              )}

              <TabsContent value="tools" className="mt-0">
                <div className="space-y-2 max-h-[50vh] overflow-auto">
                  {event.tools.map((tool, idx) => (
                    <div
                      key={idx}
                      className="rounded-md border border-border/30 bg-background/60 p-2"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs font-medium text-foreground">
                          {tool.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyToClipboard(tool, tool.name);
                          }}
                          title="Copy tool definition"
                        >
                          <Copy className="h-2.5 w-2.5" />
                        </Button>
                      </div>
                      {tool.description && (
                        <p className="text-[10px] text-muted-foreground mb-1">
                          {tool.description}
                        </p>
                      )}
                      {tool.parameters && (
                        <div className="max-h-[150px] overflow-auto">
                          <JsonView
                            src={tool.parameters as object}
                            dark={true}
                            theme="atom"
                            enableClipboard={true}
                            displaySize={false}
                            collapsed={2}
                            style={{
                              fontSize: "10px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                              backgroundColor: "transparent",
                              padding: "0",
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  {event.tools.length === 0 && (
                    <div className="text-center text-muted-foreground text-xs py-4">
                      No tools available
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="config" className="mt-0">
                <div className="rounded-md border border-border/30 bg-background/60 p-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Model:</span>
                      <span className="ml-1 font-mono">{event.model.id}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Provider:</span>
                      <span className="ml-1 font-mono">{event.model.provider}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Temperature:</span>
                      <span className="ml-1 font-mono">
                        {event.temperature !== undefined ? event.temperature : "default"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Path:</span>
                      <span className="ml-1 font-mono">{event.path}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Servers:</span>
                      <span className="ml-1 font-mono">
                        {event.selectedServers.length > 0
                          ? event.selectedServers.join(", ")
                          : "none"}
                      </span>
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      )}
    </div>
  );
}
