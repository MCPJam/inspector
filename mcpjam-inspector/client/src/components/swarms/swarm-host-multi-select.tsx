/**
 * Shared compact host ("client") multi-select pill for Swarm forms.
 *
 * Extracted from NewJourneyButton so the journey form and the AI-generate
 * dialog present the identical picker: swarm-owned clients sorted first,
 * "shared" badge for hosts owned by other products, checkbox rows inside a
 * popover that doesn't dismiss between toggles.
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown, Info, Users } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { JourneyHostLogoMark } from "@/components/swarms/journey-host-logo";

export type SwarmHostItem = {
  hostId: string;
  name: string;
  // Enriched by `hosts:listHosts` (additive) — powers the journey host chips.
  modelId?: string;
  serverCount?: number;
  hasComputer?: boolean;
  ownerScope?: { type: string } | null;
};

// A journey may target ANY project host, including chatbox/suite-owned ones
// (the backend validates only project ownership). But surface the Swarms' own
// clients first and badge the "shared" ones so it's clear which hosts are
// managed elsewhere. (Deliberately NOT filtered — that would break
// cross-product journey targeting.)
export const isSwarmClient = (h: SwarmHostItem) =>
  !h.ownerScope || h.ownerScope.type === "journeys";

export function sortSwarmHosts(hosts: SwarmHostItem[]): SwarmHostItem[] {
  return [...hosts].sort((a, b) => {
    const rank = (h: SwarmHostItem) => (isSwarmClient(h) ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

export function SwarmHostMultiSelect({
  hosts,
  hostIds,
  onToggle,
}: {
  hosts: SwarmHostItem[];
  hostIds: string[];
  onToggle: (hostId: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const sortedHosts = useMemo(() => sortSwarmHosts(hosts), [hosts]);
  const selectedHosts = useMemo(
    () => sortedHosts.filter((h) => hostIds.includes(h.hostId)),
    [sortedHosts, hostIds]
  );
  const triggerLabel =
    selectedHosts.length === 0
      ? "No clients · pick one"
      : selectedHosts[0]?.name ?? "Clients";
  const extra = selectedHosts.length > 1 ? selectedHosts.length - 1 : 0;

  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            // Keyboard users get no indicator otherwise — `outline-none` above
            // strips the browser default.
            "focus-visible:ring-2 focus-visible:ring-ring",
            hostIds.length === 0
              ? "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45"
              : "border-border/60 bg-muted/40 hover:bg-muted/60"
          )}
          aria-label="Attached clients"
        >
          {selectedHosts[0] ? (
            <JourneyHostLogoMark label={selectedHosts[0].name} />
          ) : (
            <Users className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          {extra > 0 ? (
            <span className="text-[10px] text-muted-foreground">+{extra}</span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-1"
        align="start"
        sideOffset={4}
        // Multi-select: don't dismiss when focus moves between rows
        // (Radix otherwise treats the click as "outside" the trigger).
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="space-y-0.5" role="group" aria-label="Clients">
          <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Clients
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="What is a client?"
                  className="rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px]">
                <p className="text-xs leading-snug">
                  Pick one or more. Each selected client fans out into its own
                  sessions for this journey.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          {hosts.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No clients in this project.
            </p>
          ) : (
            sortedHosts.map((h) => {
              const selected = hostIds.includes(h.hostId);
              const shared = !isSwarmClient(h);
              const meta = [
                h.modelId || null,
                h.hasComputer ? "computer" : null,
              ].filter(Boolean);
              return (
                <button
                  key={h.hostId}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  // Prevent focus steal from closing the multi-select popover
                  // before the toggle applies (same pattern as evals).
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => onToggle(h.hostId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded py-1.5 pl-2 pr-2 text-left text-sm",
                    "hover:bg-accent hover:text-accent-foreground",
                    selected && "bg-accent/50"
                  )}
                >
                  <Check
                    className={cn(
                      "size-3.5 shrink-0",
                      selected ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <JourneyHostLogoMark label={h.name} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{h.name}</span>
                    {shared ? (
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                        shared
                      </span>
                    ) : null}
                    {meta.length > 0 ? (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {meta.join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
