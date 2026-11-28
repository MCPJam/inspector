import { useState } from "react";
import { Check, ChevronDown, EyeOff, Plus, RefreshCw, Server } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  getConnectionStatusMeta,
  isConnectionStatus,
  UNKNOWN_CONNECTION_STATUS,
} from "./connection/server-card-utils";
import type { ServerWithName } from "@/hooks/use-app-state";
import { cn } from "@/lib/utils";

interface ActiveServerPickerProps {
  label: string;
  inBreadcrumb?: boolean;
  servers: [string, ServerWithName][];
  selectedServer: string;
  onSelect: (name: string) => void;
  onAdd: () => void;
  addLabel: string;
  onReconnect?: (name: string) => Promise<void>;
  onHide?: (name: string) => void;
  reconnectBlocked: (server: ServerWithName) => boolean;
  reconnectBlockedHint: string;
}

export function ActiveServerPicker({
  label,
  inBreadcrumb,
  servers,
  selectedServer,
  onSelect,
  onAdd,
  addLabel,
  onReconnect,
  onHide,
  reconnectBlocked,
  reconnectBlockedHint,
}: ActiveServerPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = servers.find(([name]) => name === selectedServer);
  const currentName = selected?.[0] ?? "Choose server";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={inBreadcrumb ? "chrome" : "outline"}
          size="sm"
          aria-label={`${label}: ${currentName}`}
          className="max-w-full min-w-0 gap-1.5"
        >
          <Server className={cn("size-3.5 text-muted-foreground", inBreadcrumb && "max-sm:hidden")} aria-hidden />
          <span className={cn(
            "shrink-0 text-xs text-muted-foreground",
            inBreadcrumb && (label === "Server" ? "sr-only" : "max-lg:sr-only"),
          )}>
            {label}
          </span>
          <span className="min-w-0 max-w-52 truncate">{currentName}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={`${label} options`}
        className="w-80 max-w-[calc(100vw-1.5rem)] p-1.5"
      >
        <ul className="max-h-64 space-y-0.5 overflow-y-auto">
          {servers.map(([name, server]) => {
            const status = isConnectionStatus(server.connectionStatus)
              ? getConnectionStatusMeta(server.connectionStatus)
              : UNKNOWN_CONNECTION_STATUS;
            const isSelected = name === selectedServer;
            const blocked = reconnectBlocked(server);
            return (
              <li key={name} className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  aria-current={isSelected || undefined}
                  className={cn(
                    "h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left",
                    isSelected && "bg-accent text-accent-foreground",
                  )}
                  onClick={() => {
                    onSelect(name);
                    setOpen(false);
                  }}
                >
                  <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-full", status.indicatorClassName)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {status.label} · {server.config.command ? "STDIO" : "HTTP"}
                    </span>
                  </span>
                  {isSelected && <Check className="size-3.5" aria-hidden />}
                </Button>
                {onReconnect && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Reconnect ${name}`}
                    title={blocked ? reconnectBlockedHint : "Reconnect"}
                    disabled={blocked}
                    onClick={() => void onReconnect(name)}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                )}
                {onHide && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Hide ${name} from this debugger`}
                    title="Hide from this debugger"
                    onClick={() => onHide(name)}
                  >
                    <EyeOff className="size-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <div className={cn(servers.length > 0 && "mt-1 border-t pt-1")}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            <Plus className="size-3.5" />
            {addLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
