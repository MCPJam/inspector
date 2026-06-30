import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MoreHorizontal, Plus, X } from "lucide-react";
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
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import type { HostThemeMode } from "@/lib/client-styles";
import {
  HOST_TEMPLATES,
  getHostTemplateLogoSrc,
  type HostTemplateId,
} from "@/lib/client-templates";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";

// Quick-add priority. These templates surface first in the Add-host strip;
// everything else follows in template order and spills into the overflow (⋯).
const QUICK_ADD_ORDER: HostTemplateId[] = [
  "mcpjam",
  "claude",
  "chatgpt",
  "copilot",
  "cursor",
  "vscode",
  "mistral",
  "goose",
];

// Priority templates first, then any remaining templates in their natural order.
const ORDERED_TEMPLATES = [
  ...QUICK_ADD_ORDER.flatMap((id) => {
    const template = HOST_TEMPLATES.find((t) => t.id === id);
    return template ? [template] : [];
  }),
  ...HOST_TEMPLATES.filter((t) => !QUICK_ADD_ORDER.includes(t.id)),
];

// How many logos render inline before the rest collapse into the "⋯" overflow
// (sized to fit the 260px dropdown alongside the "Add host" label).
const QUICK_ADD_VISIBLE = 6;

/**
 * Data needed to drive the chat-input client (host) chip. Mirrors the model
 * selector's prop shape so the two chips behave the same way: click a row to
 * switch the single lead, or flip "Multiple hosts" to stack a compare
 * lineup. Host compare and model compare stay mutually exclusive — that's
 * enforced by the parent's `onMultiHostEnabledChange` /
 * `onMultiModelEnabledChange`, not here.
 */
export interface ClientSelectorData {
  hosts: HostListItem[];
  /** Project the hosts belong to — required to create new hosts. May be a
   *  client-local project id (UUID) before the project is synced to Convex. */
  projectId: string | null;
  /** The project's CONVEX id (`sharedProjectId`), or null when the project has
   *  no Convex backing yet (e.g. the synthetic "Default" project). Cloud,
   *  Convex-scoped reads (cloud skills) MUST use this, never `projectId` — a
   *  client-local UUID fails the `v.id("projects")` validator with a 500.
   *  Required (not optional) so every caller decides explicitly; pass `null`
   *  when there's no Convex project rather than omitting it. */
  cloudProjectId: string | null;
  /** Lead host id — the single active client / first compare column. */
  currentHostId: string | null;
  /** Persisted compare lineup (from `usePersistedHost`). */
  selectedHostIds: string[];
  multiHostEnabled: boolean;
  /** Switch the single lead host (not comparing). */
  onHostChange: (hostId: string) => void;
  onSelectedHostIdsChange: (ids: string[]) => void;
  onMultiHostEnabledChange: (enabled: boolean) => void;
  /** Promote a host to lead within the compare lineup. */
  onPromoteLead: (hostId: string) => void;
  enableMultiHost?: boolean;
  maxSelectedHosts?: number;
}

interface ClientSelectorProps extends ClientSelectorData {
  disabled?: boolean;
  isLoading?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  /** Resolved chat theme (host theme ?? app theme) so logos pick the right variant. */
  themeMode?: HostThemeMode | null;
  /** App-surface theme for portal-rendered modal content. */
  modalThemeMode?: HostThemeMode | null;
}

function compactHostLabel(name: string): string {
  return name || "Host";
}

export function ClientSelector({
  hosts,
  projectId,
  currentHostId,
  selectedHostIds,
  multiHostEnabled,
  onHostChange,
  onSelectedHostIdsChange,
  onMultiHostEnabledChange,
  onPromoteLead,
  enableMultiHost = false,
  maxSelectedHosts = 3,
  disabled,
  isLoading,
  onOpenChange,
  align = "start",
  themeMode,
  modalThemeMode = themeMode,
}: ClientSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<
    HostTemplateId | undefined
  >(undefined);
  const keepPopoverOpenRef = useRef(false);
  const keepPopoverOpenTimeoutRef = useRef<number | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setSearch("");
  }, [isOpen]);

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

  // Same keep-open trick as model-selector.tsx: clicks on the switch / chip
  // strip flip this ref on so the next `onOpenChange(false)` is suppressed.
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

  const hostsById = useMemo(() => {
    const map = new Map<string, HostListItem>();
    for (const host of hosts) map.set(host.hostId, host);
    return map;
  }, [hosts]);

  // When comparing, the lineup is the persisted array. Otherwise the single
  // lead is `currentHostId` (the previewed host) — ignore any stale compare
  // array so switching the single client always shows the right lead.
  const effectiveSelectedHostIds = useMemo(() => {
    if (multiHostEnabled && selectedHostIds.length > 0) return selectedHostIds;
    return currentHostId ? [currentHostId] : [];
  }, [multiHostEnabled, selectedHostIds, currentHostId]);

  const selectedIds = useMemo(
    () => new Set(effectiveSelectedHostIds),
    [effectiveSelectedHostIds]
  );

  const leadHostId = effectiveSelectedHostIds[0] ?? currentHostId ?? null;
  const leadHost = leadHostId ? hostsById.get(leadHostId) ?? null : null;
  const leadHostName = leadHost?.name ?? "Select host";
  const leadHostLogo = leadHost?.name
    ? resolveHostLogoByDisplayName(leadHost.name, themeMode)
    : null;

  const canUseMultiHost = enableMultiHost && hosts.length > 1;
  const isComparing = multiHostEnabled && effectiveSelectedHostIds.length > 1;
  const limitReached = effectiveSelectedHostIds.length >= maxSelectedHosts;
  const triggerLabel = isComparing
    ? effectiveSelectedHostIds
        .map((hostId) =>
          compactHostLabel(hostsById.get(hostId)?.name ?? hostId)
        )
        .join(", ")
    : compactHostLabel(leadHostName);
  const clientListMaxHeight = isComparing ? 160 : 220;

  const handleToggleMultiHost = (enabled: boolean) => {
    if (!canUseMultiHost) return;
    requestPopoverStayOpen();
    if (enabled) {
      onSelectedHostIdsChange(effectiveSelectedHostIds);
      onMultiHostEnabledChange(true);
      return;
    }
    onSelectedHostIdsChange(leadHostId ? [leadHostId] : []);
    onMultiHostEnabledChange(false);
  };

  const handleSingleSelect = (hostId: string) => {
    if (hostId !== leadHostId) onHostChange(hostId);
    setIsOpen(false);
  };

  const handleMultiSelect = (hostId: string) => {
    requestPopoverStayOpen();
    const isSelected = selectedIds.has(hostId);
    const next = isSelected
      ? effectiveSelectedHostIds.filter((id) => id !== hostId)
      : [...effectiveSelectedHostIds, hostId];
    // Never collapse to empty — at least the lead has to stay.
    if (next.length === 0) return;
    onSelectedHostIdsChange(next);
  };

  const handlePromoteLeadFromChip = (hostId: string) => {
    if (hostId === leadHostId) return;
    requestPopoverStayOpen();
    onPromoteLead(hostId);
  };

  const openCreateWithTemplate = (templateId?: HostTemplateId) => {
    setCreateTemplateId(templateId);
    setShowCreate(true);
    setIsOpen(false);
  };

  return (
    <>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || isLoading}
                className={cn(
                  "h-8 rounded-full px-2 text-xs transition-colors hover:bg-muted/80 @max-2xl/toolbar:max-w-none @max-2xl/toolbar:w-8 @max-2xl/toolbar:px-0",
                  isComparing ? "max-w-[280px] gap-1" : "max-w-[170px] gap-1"
                )}
                data-testid="client-selector-trigger"
              >
                {isComparing ? (
                  <span className="flex min-w-0 items-center gap-1 overflow-hidden @max-2xl/toolbar:hidden">
                    {effectiveSelectedHostIds.map((hostId, index) => {
                      const host = hostsById.get(hostId);
                      const name = compactHostLabel(host?.name ?? hostId);
                      const logo = resolveHostLogoByDisplayName(
                        name,
                        themeMode
                      );
                      return (
                        <span
                          key={hostId}
                          className={cn(
                            "inline-flex h-5 w-[82px] min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium",
                            index === 0
                              ? "border-primary/25 text-foreground"
                              : "border-border/50 text-muted-foreground"
                          )}
                        >
                          {logo ? (
                            <img
                              src={logo}
                              alt=""
                              className="size-3 shrink-0 object-contain"
                            />
                          ) : (
                            <span
                              aria-hidden
                              className="size-3 shrink-0 rounded-full bg-muted"
                            />
                          )}
                          <span className="truncate">{name}</span>
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  <>
                    {leadHostLogo ? (
                      <img
                        src={leadHostLogo}
                        alt=""
                        className="size-4 shrink-0 rounded-[3px] object-contain"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="size-4 shrink-0 rounded-full bg-muted"
                      />
                    )}
                    <span className="truncate text-[10px] font-medium @max-2xl/toolbar:hidden">
                      {triggerLabel}
                    </span>
                  </>
                )}
                {isComparing ? (
                  leadHostLogo ? (
                    <img
                      src={leadHostLogo}
                      alt=""
                      className="hidden size-4 shrink-0 rounded-[3px] object-contain @max-2xl/toolbar:block"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="hidden size-4 shrink-0 rounded-full bg-muted @max-2xl/toolbar:block"
                    />
                  )
                ) : null}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isComparing ? "Hosts" : "Host"}
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align={align}
          className="max-h-[min(520px,calc(100vh-6rem))] w-[260px] overflow-hidden p-0"
          side="top"
          sideOffset={8}
          avoidCollisions={false}
          collisionPadding={8}
        >
          <Command shouldFilter={true}>
            <CommandInput
              placeholder="Search hosts"
              value={search}
              onValueChange={setSearch}
            />

            {canUseMultiHost ? (
              <>
                <div className="flex cursor-default items-center justify-between gap-2 border-b px-2.5 py-2">
                  <span className="text-xs text-muted-foreground">
                    Multiple hosts
                  </span>
                  <Switch
                    checked={multiHostEnabled}
                    onCheckedChange={handleToggleMultiHost}
                    aria-label="Compare multiple hosts"
                    disabled={disabled || isLoading}
                  />
                </div>

                {multiHostEnabled && effectiveSelectedHostIds.length > 1 ? (
                  <div
                    className="flex flex-wrap gap-1 border-b px-2.5 py-1.5"
                    title="First chip is the lead host. Click a chip to promote it."
                  >
                    {effectiveSelectedHostIds.map((hostId, index) => {
                      const host = hostsById.get(hostId);
                      const isLead = index === 0;
                      const name = host?.name ?? hostId;
                      const logo = resolveHostLogoByDisplayName(
                        name,
                        modalThemeMode
                      );
                      return (
                        <button
                          key={hostId}
                          type="button"
                          className={cn(
                            "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                            isLead
                              ? "border-primary/25 bg-primary/5 text-foreground"
                              : "border-border/50 bg-muted/30 text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => handlePromoteLeadFromChip(hostId)}
                        >
                          {logo ? (
                            <img
                              src={logo}
                              alt=""
                              className="size-3 shrink-0 object-contain"
                            />
                          ) : (
                            <span
                              aria-hidden
                              className="size-3 shrink-0 rounded-full bg-muted"
                            />
                          )}
                          <span className="truncate">{name}</span>
                          {!isLead ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              aria-label={`Remove ${name}`}
                              className="inline-flex size-3.5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMultiSelect(hostId);
                              }}
                            >
                              <X className="h-2.5 w-2.5" />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {limitReached ? (
                      <span className="w-full text-[10px] text-muted-foreground">
                        Max {maxSelectedHosts}. Remove one to add another.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            <CommandList
              className="overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
              style={{
                maxHeight: clientListMaxHeight,
                overflowY: "auto",
              }}
            >
              <CommandEmpty>No matching hosts.</CommandEmpty>
              {hosts.map((host) => {
                const isSelected = selectedIds.has(host.hostId);
                const isLimitedOut =
                  multiHostEnabled && !isSelected && limitReached;
                const logo = resolveHostLogoByDisplayName(
                  host.name,
                  modalThemeMode
                );

                const row = (
                  <CommandItem
                    key={host.hostId}
                    value={`${host.name} ${host.hostId}`}
                    onSelect={() =>
                      multiHostEnabled
                        ? handleMultiSelect(host.hostId)
                        : handleSingleSelect(host.hostId)
                    }
                    disabled={isLimitedOut}
                    className="cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed"
                    data-testid={`client-row-${host.hostId}`}
                  >
                    {logo ? (
                      <img
                        src={logo}
                        alt=""
                        className="size-3.5 shrink-0 object-contain"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="size-3.5 shrink-0 rounded-full bg-muted"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {host.name}
                    </span>
                    {isComparing && host.hostId === leadHostId ? (
                      <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none text-primary">
                        Global
                      </span>
                    ) : null}
                    {multiHostEnabled ? (
                      <div
                        className={cn(
                          "ml-auto flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.33,1,0.68,1)]",
                          isSelected
                            ? "border-primary bg-primary shadow-sm"
                            : "border-border/60 bg-transparent hover:border-border"
                        )}
                        aria-hidden
                      >
                        {isSelected ? (
                          <Check
                            strokeWidth={3}
                            className="size-2.5 animate-in zoom-in-95 fade-in duration-200 fill-none text-primary-foreground"
                          />
                        ) : null}
                      </div>
                    ) : host.hostId === leadHostId ? (
                      <div className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </CommandItem>
                );

                return isLimitedOut ? (
                  <Tooltip key={host.hostId}>
                    <TooltipTrigger asChild>
                      <div className="rounded-sm transition-colors hover:bg-accent/60">
                        {row}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      You can compare up to {maxSelectedHosts} hosts at once
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  row
                );
              })}
            </CommandList>

            {projectId ? (
              <div className="flex items-center gap-2 overflow-hidden border-t px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => openCreateWithTemplate(undefined)}
                  className="flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-sm text-foreground transition-colors hover:bg-accent"
                  data-testid="client-add-host"
                >
                  <Plus className="size-3.5" />
                  <span>Add host</span>
                </button>
                <span className="flex flex-1 items-center justify-between gap-0.5">
                  {ORDERED_TEMPLATES.slice(0, QUICK_ADD_VISIBLE).map(
                    (template) => (
                      <button
                        key={template.id}
                        type="button"
                        aria-label={`Add ${template.label} host`}
                        title={`Add ${template.label}`}
                        data-testid={`client-quick-add-${template.id}`}
                        onClick={() => openCreateWithTemplate(template.id)}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-accent"
                      >
                        <img
                          src={getHostTemplateLogoSrc(template, modalThemeMode)}
                          alt=""
                          className="size-4 object-contain"
                        />
                      </button>
                    )
                  )}
                </span>
                {ORDERED_TEMPLATES.length > QUICK_ADD_VISIBLE ? (
                  <button
                    type="button"
                    aria-label="More hosts"
                    title="More hosts"
                    data-testid="client-quick-add-more"
                    onClick={() => openCreateWithTemplate(undefined)}
                    className="inline-flex h-5 shrink-0 items-center justify-center rounded-sm px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>

      {projectId ? (
        <CreateHostDialog
          isOpen={showCreate}
          onClose={() => {
            setShowCreate(false);
            setCreateTemplateId(undefined);
          }}
          projectId={projectId}
          initialTemplateId={createTemplateId}
          onCreated={(hostId) => onHostChange(hostId)}
        />
      ) : null}
    </>
  );
}
