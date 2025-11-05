import { useState } from "react";
import { ChevronDown, ChevronRight, Trash2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { HTTPHistoryEntry } from "@/components/HTTPHistoryEntry";
import { OAuthFlowState } from "@/lib/oauth/state-machines/types";

interface OAuthFlowLoggerProps {
  oauthFlowState: OAuthFlowState;
  onClearLogs: () => void;
  onClearHttpHistory: () => void;
}

export function OAuthFlowLogger({
  oauthFlowState,
  onClearLogs,
  onClearHttpHistory,
}: OAuthFlowLoggerProps) {
  console.log("oauthFlowState", oauthFlowState);
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
  const [deletedInfoLogs, setDeletedInfoLogs] = useState<Set<string>>(
    new Set(),
  );

  const toggleExpanded = (id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClearAll = () => {
    onClearLogs();
    onClearHttpHistory();
    setExpandedBlocks(new Set());
    setDeletedInfoLogs(new Set());
  };

  return (
    <div className="h-full border-l border-border flex flex-col">
      <div className="h-full bg-muted/30 overflow-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Console Output</h3>
          <button
            onClick={handleClearAll}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="Clear all logs"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
          </button>
        </div>

        {/* Console Output - Merged chronologically */}
        <div className="p-4 space-y-3">
          {/* Error Display */}
          {oauthFlowState.error && (
            <Alert variant="destructive" className="py-2">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                {oauthFlowState.error}
              </AlertDescription>
            </Alert>
          )}

          {/* Merged Console Output - Chronologically sorted */}
          {(() => {
            const infoLogs = oauthFlowState.infoLogs || [];
            const httpHistory = oauthFlowState.httpHistory || [];

            // Create unified array with type markers
            type ConsoleEntry =
              | {
                  type: "info";
                  timestamp: number;
                  data: (typeof infoLogs)[0];
                }
              | {
                  type: "http";
                  timestamp: number;
                  data: (typeof httpHistory)[0];
                  index: number;
                };

            const allEntries: ConsoleEntry[] = [
              ...infoLogs
                .filter((log: any) => !deletedInfoLogs.has(log.id))
                .map((log: any) => ({
                  type: "info" as const,
                  timestamp: log.timestamp,
                  data: log,
                })),
              ...httpHistory.map((entry: any, index: number) => ({
                type: "http" as const,
                timestamp: entry.timestamp,
                data: entry,
                index,
              })),
            ];

            // Sort by timestamp (newest first)
            allEntries.sort((a, b) => b.timestamp - a.timestamp);

            return allEntries.map((entry) => {
              if (entry.type === "info") {
                const log = entry.data;
                const isExpanded = expandedBlocks.has(log.id);
                return (
                  <div
                    key={log.id}
                    className="group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card"
                  >
                    <div
                      className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => toggleExpanded(log.id)}
                    >
                      <div className="flex-shrink-0">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform" />
                        )}
                      </div>
                      <span className="text-xs font-medium text-foreground">
                        {log.label}
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="border-t bg-muted/20">
                        <div className="p-3">
                          <div className="max-h-[40vh] overflow-auto rounded-sm bg-background/60 p-2">
                            <JsonView
                              src={log.data}
                              dark={true}
                              theme="atom"
                              enableClipboard={true}
                              displaySize={false}
                              collapsed={false}
                              style={{
                                fontSize: "11px",
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                backgroundColor: "transparent",
                                padding: "0",
                                borderRadius: "0",
                                border: "none",
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              } else {
                // HTTP entry
                const httpEntry = entry.data;
                return (
                  <HTTPHistoryEntry
                    key={`http-${entry.index}-${entry.timestamp}`}
                    method={httpEntry.request.method}
                    url={httpEntry.request.url}
                    status={httpEntry.response?.status}
                    statusText={httpEntry.response?.statusText}
                    duration={httpEntry.duration}
                    requestHeaders={httpEntry.request.headers}
                    requestBody={httpEntry.request.body}
                    responseHeaders={httpEntry.response?.headers}
                    responseBody={httpEntry.response?.body}
                  />
                );
              }
            });
          })()}

          {/* Empty state */}
          {(!oauthFlowState.infoLogs || oauthFlowState.infoLogs.length === 0) &&
            (!oauthFlowState.httpHistory ||
              oauthFlowState.httpHistory.length === 0) &&
            !oauthFlowState.error && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No console output yet
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
