import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Server, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";
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
 * MultiHostPicker — playground host pill that supports comparing up to N
 * hosts side-by-side. Structurally mirrors `chat-v2/chat-input/model-selector.tsx`:
 *
 *   - Trigger button shows the lead host name; when multi-host is enabled
 *     with more than one host selected, appends "+N".
 *   - Popover contains: search input, "Multiple hosts" switch row, chip
 *     strip (lead + secondaries; clicking a secondary promotes it to lead),
 *     and a flat host list. Each row gets a checkbox when multi-host is
 *     enabled.
 *
 * This component is intentionally dumb about WHERE the data comes from. The
 * wrapper (`PlaygroundHostPicker`) calls all hooks (`useHostList`,
 * `usePersistedHost`, `usePreviewedHostId`) and threads the values in. The
 * only promotion primitive the picker uses is `onPromoteLead`, which the
 * wrapper implements as `replaceLeadHostId(projectId, hostId)` per the
 * canonical-write contract from Phase 1 (`selected-host-storage.ts`).
 *
 * Phase 2 scope (this PR): UI + state writes only. Toggling "Multiple hosts"
 * on persists `multiHostEnabled` + `selectedHostIds` to localStorage but
 * does NOT change the playground render path; that lands in Phase 4.
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

type PendingHostSelectionChange =
  | { type: "single"; nextHostId: string }
  | { type: "multi"; enabled: boolean; selectedHostIds: string[] };

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

  const triggerLabel =
    multiHostEnabled && effectiveSelectedHostIds.length > 1
      ? `${compactHostLabel(leadHostName)} +${effectiveSelectedHostIds.length - 1}`
      : compactHostLabel(leadHostName);

  // Toggle is only usable when there are at least 2 hosts to compare;
  // otherwise display a tooltip explaining the requirement. Matches the
  // plan's "single-host project guard" decision (table row 7).
  const canUseMultiHost = hosts.length > 1;
  const selectedLimitReached =
    multiHostEnabled && effectiveSelectedHostIds.length >= maxSelectedHosts;

  const requestSelectionChange = (nextChange: PendingHostSelectionChange) => {
    const isSingleNoOp =
      nextChange.type === "single" &&
      nextChange.nextHostId === (currentHostId ?? "");
    const isMultiNoOp =
      nextChange.type === "multi" &&
      nextChange.enabled === multiHostEnabled &&
      sameHostIdOrder(
        nextChange.selectedHostIds,
        effectiveSelectedHostIds,
      );

    if (isSingleNoOp) {
      setIsOpen(false);
      return;
    }
    if (isMultiNoOp) return;

    if (nextChange.type === "single") {
      onPromoteLead(nextChange.nextHostId);
      setIsOpen(false);
    } else {
      onSelectedHostIdsChange(nextChange.selectedHostIds);
      onMultiHostEnabledChange(nextChange.enabled);
    }
  };

  const handleToggleMultiHost = (enabled: boolean) => {
    if (!canUseMultiHost) return;

    requestPopoverStayOpen();

    if (enabled) {
      // Seed the array with the current lead so multi-host opens with the
      // lead already selected; the user adds others incrementally.
      requestSelectionChange({
        type: "multi",
        enabled: true,
        selectedHostIds:
          effectiveSelectedHostIds.length > 0
            ? effectiveSelectedHostIds
            : leadHostId
              ? [leadHostId]
              : [],
      });
      return;
    }

    requestSelectionChange({
      type: "multi",
      enabled: false,
      selectedHostIds: leadHostId ? [leadHostId] : [],
    });
  };

  const handleMultiHostSelect = (hostId: string) => {
    requestPopoverStayOpen();

    const isSelected = selectedIds.has(hostId);
    const nextSelectedHostIds = isSelected
      ? effectiveSelectedHostIds.filter((id) => id !== hostId)
      : [...effectiveSelectedHostIds, hostId];

    // Mirror model-selector.tsx:338-340: never allow the array to collapse
    // to empty — at least the lead has to stay.
    if (nextSelectedHostIds.length === 0) return;

    requestSelectionChange({
      type: "multi",
      enabled: true,
      selectedHostIds: nextSelectedHostIds,
    });
  };

  const handlePromoteLeadFromChip = (hostId: string) => {
    if (!multiHostEnabled || hostId === leadHostId) return;
    requestPopoverStayOpen();
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
            >
              <Server className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate whitespace-nowrap @max-[820px]/playground-header:sr-only">
                {triggerLabel}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent {...PLAYGROUND_HEADER_TOOLTIP}>
          <p className="font-medium">
            {multiHostEnabled && effectiveSelectedHostIds.length > 1
              ? "Hosts"
              : "Host"}
          </p>
          {multiHostEnabled && effectiveSelectedHostIds.length > 1 ? (
            <p className="text-xs font-light text-muted-foreground">
              {effectiveSelectedHostIds
                .map((id) => hostsById.get(id)?.name ?? id)
                .join(", ")}
            </p>
          ) : null}
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-[280px] p-0" sideOffset={8}>
        <Command shouldFilter={true}>
          <CommandInput placeholder="Search hosts" />

          <div className="flex cursor-default items-center justify-between gap-2 border-b px-2.5 py-2">
            <span className="text-xs text-muted-foreground">
              Multiple hosts
            </span>
            {canUseMultiHost ? (
              <Switch
                checked={multiHostEnabled}
                onCheckedChange={handleToggleMultiHost}
                aria-label="Use multiple hosts"
                disabled={disabled || isLoading}
                data-testid="multi-host-toggle"
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Switch
                      checked={false}
                      onCheckedChange={() => {}}
                      aria-label="Use multiple hosts"
                      disabled
                      data-testid="multi-host-toggle"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Add a second host to compare
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {multiHostEnabled ? (
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
                    <Server className="size-3" />
                    <span className="truncate">{compactHostLabel(name)}</span>
                    {!isLead && effectiveSelectedHostIds.length > 1 ? (
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Remove ${name}`}
                        data-testid={`multi-host-chip-remove-${hostId}`}
                        className="inline-flex size-3.5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMultiHostSelect(hostId);
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

            {hosts.map((host) => {
              const isSelected = selectedIds.has(host.hostId);
              const isLimitedOut =
                multiHostEnabled && !isSelected && selectedLimitReached;
              const isDisabled = isLimitedOut;
              const disabledReason = isLimitedOut
                ? `You can compare up to ${maxSelectedHosts} hosts at once`
                : undefined;

              const row = (
                <CommandItem
                  key={host.hostId}
                  value={`${host.name} ${host.hostId}`}
                  onSelect={() => {
                    if (multiHostEnabled) {
                      handleMultiHostSelect(host.hostId);
                    } else {
                      requestSelectionChange({
                        type: "single",
                        nextHostId: host.hostId,
                      });
                    }
                  }}
                  disabled={isDisabled}
                  className="cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed"
                  data-testid={`multi-host-row-${host.hostId}`}
                >
                  <Server className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {compactHostLabel(host.name)}
                  </span>
                  {multiHostEnabled ? (
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
                  ) : host.hostId === currentHostId ? (
                    <div className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                  ) : null}
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
