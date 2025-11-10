import { useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerTransportLabel,
} from "@/components/connection/server-card-utils";

interface ServerSelectionCardProps {
  server: ServerWithName;
  selected: boolean;
  onToggle: (serverName: string) => void;
}

export function ServerSelectionCard({
  server,
  selected,
  onToggle,
}: ServerSelectionCardProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isConfigExpanded, setIsConfigExpanded] = useState(true);
  const {
    label: connectionStatusLabel,
    Icon: ConnectionStatusIcon,
    iconClassName,
    indicatorColor,
  } = getConnectionStatusMeta(server.connectionStatus);
  const transportLabel = getServerTransportLabel(server.config);
  const commandDisplay = getServerCommandDisplay(server.config);
  const serverConfigJson = JSON.stringify(server.config, null, 2);

  const handleToggle = () => {
    onToggle(server.name);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleToggle();
    }
  };

  const copyToClipboard = async (
    event: MouseEvent<HTMLButtonElement>,
    text: string,
    fieldName: string,
  ) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  };

  const totalRetriesLabel =
    server.connectionStatus === "failed"
      ? `${connectionStatusLabel} (${server.retryCount} retries)`
      : connectionStatusLabel;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={handleToggle}
      onKeyDown={handleCardKeyDown}
      className={cn(
        "border bg-card/50 backdrop-blur-sm hover:border-primary/50 hover:shadow-md hover:bg-card/70 transition-all duration-200 cursor-pointer relative",
        selected
          ? "border-primary/60 ring-2 ring-primary/30 shadow-lg"
          : "border-border/50",
      )}
    >
      <div className="p-4 space-y-3 py-0">
        {/* Header Row */}
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-3 flex-1">
            <div
              className="h-2 w-2 rounded-full flex-shrink-0 mt-1"
              style={{
                backgroundColor: indicatorColor,
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-sm text-foreground">
                  {server.name}
                </h3>
                <div className="flex items-center gap-1 leading-none">
                  <ConnectionStatusIcon className={iconClassName} />
                  <p className="text-xs text-muted-foreground leading-none">
                    {totalRetriesLabel}
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {transportLabel}
              </p>
            </div>
          </div>

          {selected && (
            <Badge variant="secondary" className="h-5 px-1 text-[11px]">
              <Check className="mr-1 h-3 w-3" />
              Selected
            </Badge>
          )}
        </div>

        {/* Command Display */}
        <div
          className="font-mono text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/30 break-all relative group"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pr-8">{commandDisplay}</div>
          <button
            type="button"
            onClick={(event) =>
              copyToClipboard(event, commandDisplay, "command")
            }
            className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
          >
            {copiedField === "command" ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>

        {/* Config Display */}
        {isConfigExpanded && (
          <div
            className="relative rounded border border-border/20 bg-muted/20 p-2 font-mono text-xs text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <pre className="max-h-40 overflow-auto pr-8 whitespace-pre-wrap">
              {serverConfigJson}
            </pre>
            <button
              type="button"
              onClick={(event) =>
                copyToClipboard(event, serverConfigJson, "config")
              }
              className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
            >
              {copiedField === "config" ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
        )}

        {/* Toggle Config Button */}
        <div className="flex justify-end pt-0.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIsConfigExpanded((previous) => !previous);
            }}
            aria-label={isConfigExpanded ? "Hide config" : "Show config"}
            className="rounded-full border border-border/50 bg-background/70 p-1 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
          >
            {isConfigExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </Card>
  );
}
