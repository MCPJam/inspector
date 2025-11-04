/**
 * HTTPHistoryEntry Component
 * Displays a consolidated HTTP request/response pair in a Chrome DevTools-style format
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface HTTPHistoryEntryProps {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  duration?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: any;
  responseHeaders?: Record<string, string>;
  responseBody?: any;
}

export function HTTPHistoryEntry({
  method,
  url,
  status,
  statusText,
  duration,
  requestHeaders,
  requestBody,
  responseHeaders,
  responseBody,
}: HTTPHistoryEntryProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Determine status color
  const getStatusColor = (statusCode?: number) => {
    if (!statusCode) return "text-muted-foreground";
    if (statusCode >= 200 && statusCode < 300)
      return "text-green-600 dark:text-green-400";
    if (statusCode >= 300 && statusCode < 400)
      return "text-yellow-600 dark:text-yellow-400";
    if (statusCode >= 400 && statusCode < 500)
      return "text-red-600 dark:text-red-400";
    if (statusCode >= 500) return "text-red-700 dark:text-red-500";
    return "text-muted-foreground";
  };

  // Format duration
  const formatDuration = (ms?: number) => {
    if (ms === undefined) return "";
    return ` (${ms}ms)`;
  };

  const statusColor = getStatusColor(status);
  const isPending = status === undefined;

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={setIsExpanded}
      className="border rounded-lg bg-card shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden"
    >
      <CollapsibleTrigger className="w-full">
        <div className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors">
          <div className="flex-shrink-0">
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </div>

          <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
            <span className="text-xs font-mono font-medium text-foreground flex-shrink-0">
              {method}
            </span>
            <span className="text-xs font-mono text-muted-foreground truncate">
              {url}
            </span>
            {isPending ? (
              <span className="text-xs text-yellow-600 dark:text-yellow-400 flex-shrink-0">
                pending...
              </span>
            ) : (
              <>
                <span
                  className={cn("text-xs font-mono flex-shrink-0", statusColor)}
                >
                  {status}
                </span>
                <span
                  className={cn("text-xs font-mono flex-shrink-0", statusColor)}
                >
                  {statusText}
                </span>
                {duration !== undefined && (
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {formatDuration(duration)}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t bg-muted/20">
          <div className="p-3 space-y-3">
            {/* URL */}
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                URL
              </div>
              <div className="rounded-sm bg-background/60 p-2 max-h-[200px] overflow-auto">
                <JsonView
                  src={{ url }}
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

            {/* Request Headers */}
            {requestHeaders && Object.keys(requestHeaders).length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Request Headers
                </div>
                <div className="rounded-sm bg-background/60 p-2 max-h-[200px] overflow-auto">
                  <JsonView
                    src={requestHeaders}
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
            )}

            {/* Request Body */}
            {requestBody && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Request Body
                </div>
                <div className="rounded-sm bg-background/60 p-2 max-h-[300px] overflow-auto">
                  <JsonView
                    src={requestBody}
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
            )}

            {/* Response Headers */}
            {responseHeaders && Object.keys(responseHeaders).length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Response Headers
                </div>
                <div className="rounded-sm bg-background/60 p-2 max-h-[200px] overflow-auto">
                  <JsonView
                    src={responseHeaders}
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
            )}

            {/* Response Body */}
            {responseBody && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Response Body
                </div>
                <div className="rounded-sm bg-background/60 p-2 max-h-[300px] overflow-auto">
                  <JsonView
                    src={responseBody}
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
            )}

            {/* Pending state message */}
            {isPending && (
              <div className="text-xs text-muted-foreground italic">
                Waiting for response...
              </div>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
