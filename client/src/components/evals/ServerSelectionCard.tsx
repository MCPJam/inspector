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
  const [isConfigExpanded, setIsConfigExpanded] = useState(false);
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
        "relative gap-3 p-3 border border-border/40 bg-card/40 transition-colors",
        "hover:border-border cursor-pointer",
        selected && "border-primary/60 ring-2 ring-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: indicatorColor }}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-medium text-foreground truncate">
                {server.name}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <ConnectionStatusIcon className={iconClassName} />
                <span>{totalRetriesLabel}</span>
              </div>
            </div>
          </div>
        </div>
        {selected && (
          <Badge variant="secondary" className="h-5 px-1 text-[11px]">
            <Check className="mr-1 h-3 w-3" />
            Selected
          </Badge>
        )}
      </div>
      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {transportLabel}
      </p>
      <div className="relative break-all rounded border border-border/30 bg-muted/30 p-1.5 font-mono text-[11px] text-muted-foreground">
        <div className="pr-6">{commandDisplay}</div>
        <button
          type="button"
          onClick={(event) => copyToClipboard(event, commandDisplay, "command")}
          className="absolute right-1 top-1 cursor-pointer p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          {copiedField === "command" ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>

      {isConfigExpanded && (
        <div className="relative rounded border border-border/20 bg-muted/20 p-1.5 font-mono text-[11px] text-muted-foreground">
          <pre className="max-h-40 overflow-auto pr-6 whitespace-pre-wrap">
            {serverConfigJson}
          </pre>
          <button
            type="button"
            onClick={(event) =>
              copyToClipboard(event, serverConfigJson, "config")
            }
            className="absolute right-1 top-1 cursor-pointer p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            {copiedField === "config" ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      )}

      <div className="flex justify-end pt-0.5">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setIsConfigExpanded((previous) => !previous);
          }}
          aria-label={isConfigExpanded ? "Hide config" : "Show config"}
          className="rounded-full border border-border/50 bg-background/70 p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {isConfigExpanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
      </div>
    </Card>
  );
}
