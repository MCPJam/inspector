/**
 * InfoLogEntry Component
 * Displays an informational log entry in a Chrome DevTools-style format
 */

import { useState, type ComponentType } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Octagon,
} from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type {
  InfoLogLevel,
  LogErrorDetails,
} from "@/lib/oauth/state-machines/types";

interface InfoLogEntryProps {
  label: string;
  timestamp: number;
  data: any;
  level?: InfoLogLevel;
  error?: LogErrorDetails;
  defaultOpen?: boolean;
}

export function InfoLogEntry({
  label,
  timestamp,
  data,
  level = "info",
  error,
  defaultOpen = false,
}: InfoLogEntryProps) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen);

  // Format timestamp
  const formatTimestamp = (ts: number) => {
    return new Date(ts).toLocaleTimeString();
  };

  const severity = level ?? "info";

  const severityConfig: Record<
    InfoLogLevel,
    { icon: ComponentType<any>; accent: string; text: string }
  > = {
    info: {
      icon: Info,
      accent: "border-blue-300 dark:border-blue-600",
      text: "text-blue-600 dark:text-blue-300",
    },
    warning: {
      icon: AlertTriangle,
      accent: "border-yellow-300 dark:border-yellow-500",
      text: "text-yellow-700 dark:text-yellow-300",
    },
    error: {
      icon: Octagon,
      accent: "border-red-400 dark:border-red-500",
      text: "text-red-600 dark:text-red-300",
    },
  };

  const { icon: Icon, accent, text } = severityConfig[severity];

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={setIsExpanded}
      className={`border rounded-lg bg-card shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden ${accent}`}
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
            <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${text}`} />
            <span className="text-xs font-medium text-foreground">{label}</span>
            {error?.message && (
              <span className={`text-[11px] truncate max-w-[140px] ${text}`}>
                {error.message}
              </span>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground flex-shrink-0">
              {formatTimestamp(timestamp)}
            </span>
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t bg-muted/20">
          <div className="p-3">
            {error?.message && (
              <div className={`mb-2 text-xs flex items-center gap-1 ${text}`}>
                <Icon className="h-3.5 w-3.5" />
                <span>{error.message}</span>
              </div>
            )}
            <div className="rounded-sm bg-background/60 p-2 max-h-[36vh] overflow-auto">
              <JsonView
                src={data}
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
      </CollapsibleContent>
    </Collapsible>
  );
}
