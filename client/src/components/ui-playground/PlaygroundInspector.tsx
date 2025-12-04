/**
 * PlaygroundInspector
 *
 * Right panel with five tabs:
 * 1. Output - Raw tool output (structuredContent, _meta)
 * 2. Widget State - Current window.openai.widgetState (read-only, real-time)
 * 3. Globals - Editable host globals with real-time push
 * 4. CSP - Read-only display of applied CSP + violation logs
 * 5. Logs - Filtered postMessage logs
 */

import { useState, useMemo } from "react";
import {
  FileJson,
  Database,
  Settings,
  Shield,
  ScrollText,
  Moon,
  Sun,
  Globe,
  MapPin,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ScrollArea } from "../ui/scroll-area";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Badge } from "../ui/badge";
import JsonView from "react18-json-view";
import { useUiLogStore, type UiLogEvent } from "@/stores/ui-log-store";
import type {
  PlaygroundGlobals,
  CspConfig,
  CspViolation,
} from "@/stores/ui-playground-store";

interface PlaygroundInspectorProps {
  toolOutput: unknown;
  toolResponseMetadata: Record<string, unknown> | null;
  widgetState: unknown;
  globals: PlaygroundGlobals;
  csp: CspConfig | null;
  cspViolations: CspViolation[];
  widgetId: string | null;
  onUpdateGlobal: <K extends keyof PlaygroundGlobals>(
    key: K,
    value: PlaygroundGlobals[K]
  ) => void;
}

export function PlaygroundInspector({
  toolOutput,
  toolResponseMetadata,
  widgetState,
  globals,
  csp,
  cspViolations,
  widgetId,
  onUpdateGlobal,
}: PlaygroundInspectorProps) {
  const [activeTab, setActiveTab] = useState("output");

  // Filter logs by widget ID
  const logs = useUiLogStore((s) => s.items);
  const filteredLogs = useMemo(() => {
    if (!widgetId) return [];
    return logs.filter((log) => log.widgetId === widgetId);
  }, [logs, widgetId]);

  return (
    <div className="h-full flex flex-col border-l border-border bg-background">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="w-full justify-start rounded-none border-b border-border bg-background px-2 h-auto py-1">
          <TabsTrigger value="output" className="text-xs gap-1.5 data-[state=active]:bg-muted">
            <FileJson className="h-3 w-3" />
            Output
          </TabsTrigger>
          <TabsTrigger value="state" className="text-xs gap-1.5 data-[state=active]:bg-muted">
            <Database className="h-3 w-3" />
            State
          </TabsTrigger>
          <TabsTrigger value="globals" className="text-xs gap-1.5 data-[state=active]:bg-muted">
            <Settings className="h-3 w-3" />
            Globals
          </TabsTrigger>
          <TabsTrigger value="csp" className="text-xs gap-1.5 data-[state=active]:bg-muted">
            <Shield className="h-3 w-3" />
            CSP
            {cspViolations.length > 0 && (
              <Badge variant="destructive" className="ml-1 px-1 py-0 text-[10px]">
                {cspViolations.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="logs" className="text-xs gap-1.5 data-[state=active]:bg-muted">
            <ScrollText className="h-3 w-3" />
            Logs
            {filteredLogs.length > 0 && (
              <Badge variant="secondary" className="ml-1 px-1 py-0 text-[10px]">
                {filteredLogs.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Output Tab */}
        <TabsContent value="output" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {toolOutput ? (
                <>
                  <div>
                    <h3 className="text-xs font-semibold text-foreground mb-2">
                      Tool Output
                    </h3>
                    <div className="bg-muted/50 rounded-md p-3 overflow-auto">
                      <JsonView
                        src={toolOutput as object}
                        theme="atom"
                        enableClipboard
                        collapseStringsAfterLength={100}
                        collapsed={2}
                      />
                    </div>
                  </div>
                  {toolResponseMetadata && (
                    <div>
                      <h3 className="text-xs font-semibold text-foreground mb-2">
                        Response Metadata (_meta)
                      </h3>
                      <div className="bg-muted/50 rounded-md p-3 overflow-auto">
                        <JsonView
                          src={toolResponseMetadata}
                          theme="atom"
                          enableClipboard
                          collapseStringsAfterLength={100}
                          collapsed={2}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-8">
                  <p className="text-xs text-muted-foreground">
                    No tool output yet. Execute a tool to see results.
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Widget State Tab */}
        <TabsContent value="state" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4">
              <h3 className="text-xs font-semibold text-foreground mb-2">
                Widget State
                <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                  (read-only)
                </span>
              </h3>
              {widgetState !== null && widgetState !== undefined ? (
                <div className="bg-muted/50 rounded-md p-3 overflow-auto">
                  <JsonView
                    src={widgetState as object}
                    theme="atom"
                    enableClipboard
                    collapseStringsAfterLength={100}
                    collapsed={2}
                  />
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-xs text-muted-foreground">
                    No widget state set. The widget can set state using{" "}
                    <code className="bg-muted px-1 py-0.5 rounded">
                      window.openai.setWidgetState()
                    </code>
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Globals Tab */}
        <TabsContent value="globals" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-6">
              {/* Theme */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold flex items-center gap-2">
                  {globals.theme === "dark" ? (
                    <Moon className="h-3 w-3" />
                  ) : (
                    <Sun className="h-3 w-3" />
                  )}
                  Theme
                </Label>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={globals.theme === "dark"}
                    onCheckedChange={(checked) =>
                      onUpdateGlobal("theme", checked ? "dark" : "light")
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {globals.theme === "dark" ? "Dark" : "Light"}
                  </span>
                </div>
              </div>

              {/* Locale */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold flex items-center gap-2">
                  <Globe className="h-3 w-3" />
                  Locale (BCP 47)
                </Label>
                <Input
                  value={globals.locale}
                  onChange={(e) => onUpdateGlobal("locale", e.target.value)}
                  placeholder="en-US"
                  className="h-8 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  Examples: en-US, es-MX, ja-JP, de-DE
                </p>
              </div>

              {/* User Location */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold flex items-center gap-2">
                  <MapPin className="h-3 w-3" />
                  User Location (optional)
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Country (ISO 3166-1)</Label>
                    <Input
                      value={globals.userLocation?.country || ""}
                      onChange={(e) =>
                        onUpdateGlobal("userLocation", {
                          country: e.target.value,
                          region: globals.userLocation?.region || "",
                          city: globals.userLocation?.city || "",
                          timezone: globals.userLocation?.timezone || "",
                        })
                      }
                      placeholder="US"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Region</Label>
                    <Input
                      value={globals.userLocation?.region || ""}
                      onChange={(e) =>
                        onUpdateGlobal("userLocation", {
                          country: globals.userLocation?.country || "",
                          region: e.target.value,
                          city: globals.userLocation?.city || "",
                          timezone: globals.userLocation?.timezone || "",
                        })
                      }
                      placeholder="CA"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">City</Label>
                    <Input
                      value={globals.userLocation?.city || ""}
                      onChange={(e) =>
                        onUpdateGlobal("userLocation", {
                          country: globals.userLocation?.country || "",
                          region: globals.userLocation?.region || "",
                          city: e.target.value,
                          timezone: globals.userLocation?.timezone || "",
                        })
                      }
                      placeholder="San Francisco"
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Timezone (IANA)</Label>
                    <Input
                      value={globals.userLocation?.timezone || ""}
                      onChange={(e) =>
                        onUpdateGlobal("userLocation", {
                          country: globals.userLocation?.country || "",
                          region: globals.userLocation?.region || "",
                          city: globals.userLocation?.city || "",
                          timezone: e.target.value,
                        })
                      }
                      placeholder="America/Los_Angeles"
                      className="h-7 text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Computed Values (read-only) */}
              <div className="pt-4 border-t border-border">
                <h4 className="text-xs font-semibold text-foreground mb-3">
                  Computed Values
                  <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                    (read-only)
                  </span>
                </h4>
                <div className="bg-muted/50 rounded-md p-3">
                  <JsonView
                    src={{
                      deviceType: globals.deviceType,
                      displayMode: globals.displayMode,
                      userAgent: {
                        device: { type: globals.deviceType },
                        capabilities: {
                          hover: globals.deviceType === "desktop",
                          touch: globals.deviceType !== "desktop",
                        },
                      },
                      safeArea: {
                        insets: { top: 0, right: 0, bottom: 0, left: 0 },
                      },
                    }}
                    theme="atom"
                    collapsed={1}
                  />
                </div>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* CSP Tab */}
        <TabsContent value="csp" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {/* Applied CSP */}
              <div>
                <h3 className="text-xs font-semibold text-foreground mb-2">
                  Applied CSP Rules
                </h3>
                {csp ? (
                  <div className="bg-muted/50 rounded-md p-3 space-y-3">
                    <div>
                      <Label className="text-[10px] text-muted-foreground">
                        Connect Domains (fetch/XHR)
                      </Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {csp.connectDomains.length > 0 ? (
                          csp.connectDomains.map((domain) => (
                            <Badge key={domain} variant="outline" className="text-[10px]">
                              {domain}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-[10px] text-muted-foreground">None</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground">
                        Resource Domains (script/style/img)
                      </Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {csp.resourceDomains.length > 0 ? (
                          csp.resourceDomains.map((domain) => (
                            <Badge key={domain} variant="outline" className="text-[10px]">
                              {domain}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-[10px] text-muted-foreground">None</span>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No CSP rules applied. Execute a widget tool to see CSP configuration.
                  </p>
                )}
              </div>

              {/* Violations */}
              <div>
                <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-2">
                  CSP Violations
                  {cspViolations.length > 0 && (
                    <Badge variant="destructive" className="text-[10px]">
                      {cspViolations.length}
                    </Badge>
                  )}
                </h3>
                {cspViolations.length > 0 ? (
                  <div className="space-y-2">
                    {cspViolations.map((violation, i) => (
                      <div
                        key={`${violation.timestamp}-${i}`}
                        className="bg-destructive/10 border border-destructive/20 rounded-md p-2 text-xs"
                      >
                        <div className="flex items-center gap-2 text-destructive">
                          <Shield className="h-3 w-3" />
                          <span className="font-mono">{violation.directive}</span>
                        </div>
                        <p className="text-muted-foreground mt-1 break-all">
                          Blocked: {violation.blockedUri}
                        </p>
                        {violation.sourceFile && (
                          <p className="text-muted-foreground/70 text-[10px]">
                            at {violation.sourceFile}:{violation.lineNumber}
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground/50 mt-1">
                          {new Date(violation.timestamp).toLocaleTimeString()}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No CSP violations detected.
                  </p>
                )}
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4">
              <h3 className="text-xs font-semibold text-foreground mb-2">
                postMessage Logs
                {filteredLogs.length > 0 && (
                  <span className="ml-2 text-muted-foreground font-normal">
                    ({filteredLogs.length})
                  </span>
                )}
              </h3>
              {filteredLogs.length > 0 ? (
                <div className="space-y-2">
                  {filteredLogs.map((log) => (
                    <LogEntry key={log.id} log={log} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No messages logged yet. Execute a widget tool to see communication logs.
                </p>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LogEntry({ log }: { log: UiLogEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded-md border text-xs cursor-pointer ${
        log.direction === "host-to-ui"
          ? "bg-blue-500/5 border-blue-500/20"
          : "bg-green-500/5 border-green-500/20"
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Badge
          variant="outline"
          className={`text-[10px] px-1 py-0 ${
            log.direction === "host-to-ui"
              ? "border-blue-500/50 text-blue-600 dark:text-blue-400"
              : "border-green-500/50 text-green-600 dark:text-green-400"
          }`}
        >
          {log.direction === "host-to-ui" ? "OUT" : "IN"}
        </Badge>
        <code className="font-mono text-foreground">{log.method}</code>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
      </div>
      {expanded && (
        <div className="px-2 pb-2 border-t border-border/50">
          <div className="bg-background/50 rounded p-2 mt-2 overflow-auto max-h-48">
            <JsonView
              src={log.message as object}
              theme="atom"
              enableClipboard
              collapseStringsAfterLength={50}
              collapsed={2}
            />
          </div>
        </div>
      )}
    </div>
  );
}
