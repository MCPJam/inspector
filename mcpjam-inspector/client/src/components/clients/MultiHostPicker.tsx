import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns2, X } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import type { HostListItem } from "@/hooks/useClients";

/**
 * MultiHostPicker — playground "Compare" affordance that lets the user
 * stack 2–N clients side-by-side. The navbar `ClientOverlayBar` is the
 * canonical lead-client picker; this component is exclusively for
 * entering/leaving compare mode and managing the comparison lineup.
 *
 *   - Trigger button shows "Compare" by default; once the user has >1
 *     client selected it flips to "<Lead> +N" so the compare badge is
 *     legible at a glance.
 *   - Popover contains: search input, chip strip (only when >1
 *     selected; clicking a non-lead chip promotes it to lead), and a
 *     flat client list with always-on checkboxes. `multiHostEnabled` is
 *     derived from `selectedHostIds.length > 1` — there is no separate
 *     toggle, since clicking "Compare" already signals the intent.
 *
 * This component is intentionally dumb about WHERE the data comes from.
 * The wrapper (`PlaygroundHostPicker`) calls all hooks (`useHostList`,
 * `usePersistedHost`, `usePreviewedHostId`) and threads the values in.
 * The only promotion primitive the picker uses is `onPromoteLead`,
 * which the wrapper implements as `replaceLeadHostId(projectId,
 * hostId)` per the canonical-write contract from Phase 1
 * (`selected-host-storage.ts`).
 */

export interface MultiHostPickerProps {
  projectId: string | null;
  hosts: HostListItem[];
  /** Lead host id (from `usePreviewedHostId`). */
  currentHostId: string | null;
  /** Persisted compare-column line-up (from `usePersistedHost`). */
  selectedHostIds: string[];
  multiHostEnabled: boolean;
  onMultiHostEnabledChange: (enabled: boolean) => void;
  onSelectedHostIdsChange: (ids: string[]) => void;
  /**
   * Wraps `replaceLeadHostId(projectId, hostId)`. The ONLY promotion path
   * the picker may use; do NOT pass a `setPreviewedHostId` directly.
   */
  onPromoteLead: (hostId: string) => void;
  disabled?: boolean;
  isLoading?: boolean;
  maxSelectedHosts?: number;
}

type PendingHostSelectionChange = {
  type: "multi";
  enabled: boolean;
  selectedHostIds: string[];
};

function sameHostIdOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function compactHostLabel(name: string): string {
  if (!name) return "Host";
  return name;
}

const PLAYGROUND_HEADER_TOOLTIP = {
  variant: "muted" as const,
  sideOffset: 6,
  collisionPadding: 12,
};

export function MultiHostPicker({
  projectId: _projectId,
  hosts,
  currentHostId,
  selectedHostIds,
  multiHostEnabled,
  onMultiHostEnabledChange,
  onSelectedHostIdsChange,
  onPromoteLead,
  disabled,
  isLoading,
  maxSelectedHosts = 3,
}: MultiHostPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const keepPopoverOpenRef = useRef(false);
  const keepPopoverOpenTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (
        typeof window !== "undefined" &&
        keepPopoverOpenTimeoutRef.current !== null
      ) {
        window.clearTimeout(keepPopoverOpenTimeoutRef.current);
      }
    };
  }, []);

  // Same pattern as model-selector.tsx:143-159. Clicks in the switch row /
  // chip strip flip this ref on; the next `onOpenChange(false)` is then
  // suppressed. The 0-timeout clears the ref on the next tick so subsequent
  // outside clicks close the popover normally.
  const requestPopoverStayOpen = () => {
    keepPopoverOpenRef.current = true;
    setIsOpen(true);

    if (typeof window === "undefined") return;

    if (keepPopoverOpenTimeoutRef.current !== null) {
      window.clearTimeout(keepPopoverOpenTimeoutRef.current);
    }

    keepPopoverOpenTimeoutRef.current = window.setTimeout(() => {
      keepPopoverOpenRef.current = false;
      keepPopoverOpenTimeoutRef.current = null;
    }, 0);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && keepPopoverOpenRef.current) return;

    if (
      typeof window !== "undefined" &&
      keepPopoverOpenTimeoutRef.current !== null
    ) {
      window.clearTimeout(keepPopoverOpenTimeoutRef.current);
      keepPopoverOpenTimeoutRef.current = null;
    }
    keepPopoverOpenRef.current = false;
    setIsOpen(nextOpen);
  };

  // Effective selected ids: when the multi-host array is empty (e.g. before
  // the user has ever toggled multi-host on) we use the lead as the single
  // implicit selection. Mirrors `selectedModelsData` in model-selector.tsx:187-190.
  const effectiveSelectedHostIds = useMemo(() => {
    if (selectedHostIds.length > 0) return selectedHostIds;
    return currentHostId ? [currentHostId] : [];
  }, [selectedHostIds, currentHostId]);

  const selectedIds = useMemo(
    () => new Set(effectiveSelectedHostIds),
    [effectiveSelectedHostIds],
  );

  const hostsById = useMemo(() => {
    const map = new Map<string, HostListItem>();
    for (const host of hosts) map.set(host.hostId, host);
    return map;
  }, [hosts]);

  const leadHostId = effectiveSelectedHostIds[0] ?? currentHostId ?? null;
  const leadHost = leadHostId ? (hostsById.get(leadHostId) ?? null) : null;
  const leadHostName = leadHost?.name ?? "Select host";

  // When NOT actively comparing (single-host, or multi-host enabled but
  // only the lead is selected), the navbar `ClientOverlayBar` already
  // shows the lead host name + cycle controls. Surfacing the same name
  // here is pure duplication, so collapse the trigger into a "Compare"
  // affordance whose only job is to open the multi-host popover. The
  // pill earns the host name back the moment we're actually comparing
  // (≥2 hosts selected) — that's the state the navbar can't represent.
  const isActiveCompareMode =
    multiHostEnabled && effectiveSelectedHostIds.length > 1;
  const triggerLabel = isActiveCompareMode
    ? `${compactHostLabel(leadHostName)} +${effectiveSelectedHostIds.length - 1}`
    : "Compare";

  // Two or more clients in the project are required to enter compare
  // mode. Used for an empty-state hint inside the popover.
  const canUseMultiHost = hosts.length > 1;
  const selectedLimitReached =
    effectiveSelectedHostIds.length >= maxSelectedHosts;

  const requestSelectionChange = (nextChange: PendingHostSelectionChange) => {
    const isMultiNoOp =
      nextChange.enabled === multiHostEnabled &&
      sameHostIdOrder(nextChange.selectedHostIds, effectiveSelectedHostIds);
    if (isMultiNoOp) return;

    onSelectedHostIdsChange(nextChange.selectedHostIds);
    onMultiHostEnabledChange(nextChange.enabled);
  };

  // The trigger is now a "Compare" affordance, so every popover
  // interaction is implicitly about compare mode. Adding a second
  // client enters compare; removing back to one client exits.
  // `multiHostEnabled` is derived from `nextIds.length > 1` instead
  // of being driven by a separate toggle.
  const posthog = usePostHog();
  const captureCompare = useCallback(
    (event: string, props?: Record<string, unknown>) => {
      posthog?.capture(event, {
        ...standardEventProps("playground_multi_host_picker"),
        ...props,
      });
    },
    [posthog],
  );

  const handleHostRowToggle = (hostId: string) => {
    requestPopoverStayOpen();

    const isSelected = selectedIds.has(hostId);
    const nextSelectedHostIds = isSelected
      ? effectiveSelectedHostIds.filter((id) => id !== hostId)
      : [...effectiveSelectedHostIds, hostId];

    // Never collapse to empty — at least the lead has to stay. Clicking
    // the only selected client (the lead) is a no-op.
    if (nextSelectedHostIds.length === 0) return;

    const prevCount = effectiveSelectedHostIds.length;
    const nextCount = nextSelectedHostIds.length;
    const nextEnabled = nextCount > 1;
    captureCompare(
      isSelected
        ? "playground_compare_host_removed"
        : "playground_compare_host_added",
      {
        selected_count: nextCount,
        compare_active: nextEnabled,
        // Derive transitions from the host count crossing 1 ↔ 2 rather than
        // the persisted `multiHostEnabled` flag, which can drift from the
        // count (e.g. if the wrapper toggles the flag without changing the
        // selection). Bugbot 2026-05-20.
        entered_compare: !isSelected && prevCount <= 1 && nextEnabled,
        exited_compare: isSelected && prevCount > 1 && !nextEnabled,
      },
    );

    requestSelectionChange({
      type: "multi",
      enabled: nextEnabled,
      selectedHostIds: nextSelectedHostIds,
    });
  };

  const handlePromoteLeadFromChip = (hostId: string) => {
    if (!multiHostEnabled || hostId === leadHostId) return;
    requestPopoverStayOpen();
    captureCompare("playground_compare_lead_promoted", {
      selected_count: effectiveSelectedHostIds.length,
    });
    onPromoteLead(hostId);
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || isLoading}
              className="h-7 max-w-[200px] shrink-0 gap-1.5 border bg-background px-2 text-xs shadow-xs"
              data-testid="multi-host-picker-trigger"
              data-compare-mode={isActiveCompareMode ? "active" : "idle"}
            >
              <Columns2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate whitespace-nowrap @max-[820px]/playground-header:sr-only">
                {triggerLabel}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
          <p className="font-medium">
            {isActiveCompareMode ? "Hosts" : "Compare hosts"}
          </p>
          {isActiveCompareMode ? (
            <p className="text-xs font-light text-muted-foreground">
              {effectiveSelectedHostIds
                .map((id) => hostsById.get(id)?.name ?? id)
                .join(", ")}
            </p>
          ) : (
            <p className="text-xs font-light text-muted-foreground">
              Run multiple hosts side by side
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-[280px] p-0" sideOffset={8}>
        <Command shouldFilter={true}>
          <CommandInput placeholder="Search hosts" />

          {effectiveSelectedHostIds.length > 1 ? (
            <div
              className="flex flex-wrap gap-1 border-b px-2.5 py-1.5"
              title="First chip is the lead host. Click a chip to promote it."
              data-testid="multi-host-chip-strip"
            >
              {effectiveSelectedHostIds.map((hostId, index) => {
                const host = hostsById.get(hostId);
                const isLead = index === 0;
                const name = host?.name ?? hostId;
                return (
                  <button
                    key={hostId}
                    type="button"
                    data-testid={`multi-host-chip-${hostId}`}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                      isLead
                        ? "border-primary/25 bg-primary/5 text-foreground"
                        : "border-border/50 bg-muted/30 text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => handlePromoteLeadFromChip(hostId)}
                  >
                    <span className="truncate">{compactHostLabel(name)}</span>
                    {!isLead ? (
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Remove ${name}`}
                        data-testid={`multi-host-chip-remove-${hostId}`}
                        className="inline-flex size-3.5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleHostRowToggle(hostId);
                        }}
                      >
                        <X className="h-2.5 w-2.5" />
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {selectedLimitReached ? (
                <span className="w-full text-[10px] text-muted-foreground">
                  Max {maxSelectedHosts}. Remove one to add another.
                </span>
              ) : null}
            </div>
          ) : null}

          <CommandList className="max-h-[min(320px,45vh)]">
            <CommandEmpty>No matching hosts.</CommandEmpty>

            {!canUseMultiHost ? (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                Add a second host to start comparing.
              </div>
            ) : null}

            {hosts.map((host) => {
              const isSelected = selectedIds.has(host.hostId);
              const isLimitedOut =
                !isSelected && selectedLimitReached;
              const isDisabled = isLimitedOut;
              const disabledReason = isLimitedOut
                ? `You can compare up to ${maxSelectedHosts} hosts at once`
                : undefined;

              const row = (
                <CommandItem
                  key={host.hostId}
                  value={`${host.name} ${host.hostId}`}
                  onSelect={() => handleHostRowToggle(host.hostId)}
                  disabled={isDisabled}
                  className="cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed"
                  data-testid={`multi-host-row-${host.hostId}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {compactHostLabel(host.name)}
                  </span>
                  <div
                    className={cn(
                      "ml-auto flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.33,1,0.68,1)]",
                      isSelected
                        ? "border-primary bg-primary shadow-sm"
                        : "border-border/60 bg-transparent hover:border-border",
                    )}
                    aria-hidden
                    data-testid={`multi-host-checkbox-${host.hostId}`}
                    data-checked={isSelected ? "true" : "false"}
                  >
                    {isSelected ? (
                      <Check
                        strokeWidth={3}
                        className="size-2.5 animate-in zoom-in-95 fade-in duration-200 fill-none text-primary-foreground"
                      />
                    ) : null}
                  </div>
                </CommandItem>
              );

              return disabledReason ? (
                <Tooltip key={host.hostId}>
                  <TooltipTrigger asChild>
                    <div className="rounded-sm transition-colors hover:bg-accent/60">
                      {row}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right">{disabledReason}</TooltipContent>
                </Tooltip>
              ) : (
                row
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
