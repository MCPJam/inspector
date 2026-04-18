import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  getHostedTransportLabel,
  HOSTED_LOCAL_ONLY_TOOLTIP,
} from "@/lib/hosted-ui";
import { cn } from "@/lib/utils";

interface HostedConnectionTypeControlProps {
  transportType: "stdio" | "http";
  children: ReactNode;
}

export function HostedConnectionTypeControl({
  transportType,
  children,
}: HostedConnectionTypeControlProps) {
  const selectedLabel = getHostedTransportLabel(transportType);
  const options =
    transportType === "http"
      ? [
          { label: "HTTPS", selected: true, disabled: false },
          { label: "HTTP", selected: false, disabled: true },
          { label: "STDIO", selected: false, disabled: true },
        ]
      : [
          { label: "HTTPS", selected: false, disabled: true },
          { label: "HTTP", selected: false, disabled: true },
          { label: "STDIO", selected: true, disabled: false },
        ];

  return (
    <div className="flex">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label="Connection Type"
            className="w-22 justify-between rounded-r-none border-r-0 px-3 text-xs font-medium"
          >
            <span>{selectedLabel}</span>
            <ChevronDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-36 p-1"
          data-testid="hosted-connection-type-options"
        >
          <div className="space-y-1">
            {options.map((option) => {
              const row = (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                    option.disabled
                      ? "cursor-not-allowed text-muted-foreground opacity-50"
                      : "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="flex size-3.5 items-center justify-center">
                    {option.selected && <Check className="size-4" />}
                  </span>
                  <span>{option.label}</span>
                </div>
              );

              if (!option.disabled) {
                return <div key={option.label}>{row}</div>;
              }

              return (
                <Tooltip key={option.label}>
                  <TooltipTrigger asChild>
                    <div title={HOSTED_LOCAL_ONLY_TOOLTIP} aria-disabled="true">
                      {row}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center">
                    {HOSTED_LOCAL_ONLY_TOOLTIP}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {children}
    </div>
  );
}
