import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MoreHorizontal, Plus, X } from "lucide-react";
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
import { resolveHostLogoByName } from "@/lib/host-logo";
import type { HostThemeMode } from "@/lib/client-styles";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { getCatalogHost, getCatalogHosts } from "@mcpjam/sdk/host-compat";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { clientDisplayName } from "@/lib/client-display-name";
import { HostChipLogo } from "@/components/hosts/host-chip";

// Quick-add priority. These templates surface first in the Add-host strip;
// everything else follows in template order and spills into the overflow (⋯).
const QUICK_ADD_ORDER = [
  "mcpjam",
  "claude",
  "chatgpt",
  "copilot",
  "cursor",
  "vscode",
  "mistral",
  "goose",
] as const;

// How many logos render inline before the rest collapse into the "⋯" overflow
// (sized to fit the 260px dropdown alongside the "Add host" label).
const QUICK_ADD_VISIBLE = 6;

/**
 * Data needed to drive the chat-input client (host) chip. Mirrors the model
 * selector's prop shape so the two chips behave the same way, minus a
 * "Multiple hosts" toggle (PUR-11): ticking a row's checkbox stacks a compare
 * lineup immediately, no switch to find and flip first. The row BODY is a
 * separate gesture (BB-135) that switches the active client and collapses any
 * lineup, so switching costs one click instead of "tick the new one, untick
 * the old one". Host compare and model compare stay mutually exclusive —
 * that's enforced by the parent's `onMultiHostEnabledChange` /
 * `onMultiModelEnabledChange`, not here; this component still calls
 * `onMultiHostEnabledChange` (kept in sync with the selection count) so the
 * parent's mutual-exclusion logic keeps working unchanged.
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
  return name || "Client";
}

export function ClientSelector({
  hosts,
  projectId,
  currentHostId,
  selectedHostIds,
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
  const [createTemplateId, setCreateTemplateId] = useState<string | undefined>(
    undefined
  );
  const catalogState = useHostCatalog();
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

  // Same keep-open trick as model-selector.tsx: clicks on a checklist row /
  // chip strip flip this ref on so the next `onOpenChange(false)` is
  // suppressed.
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

  // Whether the checklist (checkboxes, multi-select) renders at all — with
  // 0-1 clients available, or when the parent has withdrawn compare
  // (shared session, environment mode), there's nothing to multi-select and
  // rows fall back to plain single-select.
  const checklistMode = enableMultiHost && hosts.length > 1;

  // The lineup is the persisted array — but ONLY while checklist mode is
  // actually available. The Playground can withdraw compare (host count
  // drops to 1, shared session, environment mode) without clearing the
  // persisted array, so trusting it unconditionally would show a stale
  // multi-client lineup (Global badge, "N clients" trigger label) while rows
  // fall back to single-select — a comparison-shaped UI with nothing behind
  // it. An empty array (nothing ever persisted) falls back to the single
  // previewed host so switching the client always shows the right lead.
  const effectiveSelectedHostIds = useMemo(() => {
    if (checklistMode && selectedHostIds.length > 0) return selectedHostIds;
    return currentHostId ? [currentHostId] : [];
  }, [checklistMode, selectedHostIds, currentHostId]);

  const selectedIds = useMemo(
    () => new Set(effectiveSelectedHostIds),
    [effectiveSelectedHostIds]
  );

  const leadHostId = effectiveSelectedHostIds[0] ?? currentHostId ?? null;
  const leadHost = leadHostId ? hostsById.get(leadHostId) ?? null : null;
  const leadHostName = leadHost ? clientDisplayName(leadHost) : "Select host";
  const leadHostLogo = leadHost?.name
    ? resolveHostLogoByName(leadHost.name, themeMode)
    : null;

  const isComparing = effectiveSelectedHostIds.length > 1;
  const limitReached = effectiveSelectedHostIds.length >= maxSelectedHosts;
  const triggerLabel = isComparing
    ? effectiveSelectedHostIds
        .map((hostId) => {
          const host = hostsById.get(hostId);
          return compactHostLabel(host ? clientDisplayName(host) : hostId);
        })
        .join(", ")
    : compactHostLabel(leadHostName);
  const clientListMaxHeight = isComparing ? 160 : 220;

  const handleSelectLead = (hostId: string) => {
    // Collapsing the lineup is required, not cosmetic. `usePersistedHost`
    // preserves the column COUNT when only the lead changes, so changing the
    // lead alone would swap a compare column rather than leave comparison.
    if (effectiveSelectedHostIds.length > 1) {
      onSelectedHostIdsChange([hostId]);
      onMultiHostEnabledChange(false);
    }
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
    // No toggle to flip anymore — keep the parent's persisted "comparing"
    // flag in lockstep with the selection count so its mutual-exclusion
    // logic (vs. multi-model) and compare-grid gate still work unchanged.
    onMultiHostEnabledChange(next.length > 1);
  };

  const handlePromoteLeadFromChip = (hostId: string) => {
    if (hostId === leadHostId) return;
    requestPopoverStayOpen();
    onPromoteLead(hostId);
  };

  const orderedCatalogHosts = useMemo(() => {
    if (catalogState.status !== "live") return [];
    const hostsById = new Map(
      getCatalogHosts(catalogState.catalog).map((host) => [host.id, host])
    );
    const priority = QUICK_ADD_ORDER.flatMap((id) => {
      const host = hostsById.get(id);
      if (!host) return [];
      hostsById.delete(id);
      return [host];
    });
    const rest = [...hostsById.values()].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    return [...priority, ...rest];
  }, [catalogState]);

  const openCreateWithTemplate = (templateId?: string) => {
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
                      const name = compactHostLabel(
                        host ? clientDisplayName(host) : hostId
                      );
                      const logo = resolveHostLogoByName(
                        host?.name ?? name,
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
                          <HostChipLogo
                            logoSrc={logo}
                            name={name}
                            size="xs"
                          />
                          <span className="truncate">{name}</span>
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  <>
                    <HostChipLogo
                      logoSrc={leadHostLogo}
                      name={leadHostName}
                      size="md"
                    />
                    <span className="truncate text-[10px] font-medium @max-2xl/toolbar:hidden">
                      {triggerLabel}
                    </span>
                  </>
                )}
                {isComparing ? (
                  <HostChipLogo
                    logoSrc={leadHostLogo}
                    name={leadHostName}
                    size="md"
                    className="hidden @max-2xl/toolbar:block"
                  />
                ) : null}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isComparing ? "Clients" : "Client"}
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
              placeholder="Search clients"
              value={search}
              onValueChange={setSearch}
            />

            {checklistMode && isComparing ? (
              <div
                className="flex flex-wrap gap-1 border-b px-2.5 py-1.5"
                title="First chip is the lead client. Click a chip to promote it."
              >
                {effectiveSelectedHostIds.map((hostId, index) => {
                  const host = hostsById.get(hostId);
                  const isLead = index === 0;
                  const name = host ? clientDisplayName(host) : hostId;
                  const logo = resolveHostLogoByName(
                    host?.name ?? name,
                    modalThemeMode
                  );
                  return (
                    <span
                      key={hostId}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                        isLead
                          ? "border-primary/25 bg-primary/5 text-foreground"
                          : "border-border/50 bg-muted/30 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {/* Promotion and removal are separate sibling buttons,
                          not nested — a control inside a control isn't valid
                          HTML and the inner one can't receive keyboard focus. */}
                      <button
                        type="button"
                        className="inline-flex min-w-0 items-center gap-1"
                        onClick={() => handlePromoteLeadFromChip(hostId)}
                      >
                        <HostChipLogo
                          logoSrc={logo}
                          name={name}
                          size="xs"
                        />
                        <span className="truncate">{name}</span>
                      </button>
                      {!isLead ? (
                        <button
                          type="button"
                          aria-label={`Remove ${name}`}
                          className="inline-flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleMultiSelect(hostId);
                          }}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      ) : null}
                    </span>
                  );
                })}
                {limitReached ? (
                  <span className="w-full text-[10px] text-muted-foreground">
                    Max {maxSelectedHosts}. Remove one to add another.
                  </span>
                ) : null}
              </div>
            ) : null}

            <CommandList
              className="overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
              style={{
                maxHeight: clientListMaxHeight,
                overflowY: "auto",
              }}
            >
              <CommandEmpty>No matching clients.</CommandEmpty>
              {hosts.map((host) => {
                const isSelected = selectedIds.has(host.hostId);
                const isLimitedOut =
                  checklistMode && !isSelected && limitReached;
                const logo = resolveHostLogoByName(
                  host.name,
                  modalThemeMode
                );

                // A real button, not the row's own click target: the row body
                // switches clients, the checkbox builds the comparison. Same
                // stopPropagation pattern the chip strip's remove control uses.
                const compareToggle = (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={
                      isSelected
                        ? `Remove ${host.name} from comparison`
                        : `Compare with ${host.name}`
                    }
                    disabled={isLimitedOut}
                    data-testid={`client-row-compare-${host.hostId}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleMultiSelect(host.hostId);
                    }}
                    // cmdk's root keydown claims Enter for the highlighted row
                    // and preventDefaults it, so Enter on a focused checkbox
                    // would switch clients instead of toggling compare. Stop it
                    // reaching the root and the button's own activation stands.
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.stopPropagation();
                    }}
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.33,1,0.68,1)] disabled:cursor-not-allowed disabled:opacity-50",
                      isSelected
                        ? "border-primary bg-primary shadow-sm"
                        : "border-border/60 bg-transparent hover:border-border"
                    )}
                  >
                    {isSelected ? (
                      <Check
                        strokeWidth={3}
                        className="size-2.5 animate-in zoom-in-95 fade-in duration-200 fill-none text-primary-foreground"
                      />
                    ) : null}
                  </button>
                );

                return (
                  <CommandItem
                    key={host.hostId}
                    value={`${clientDisplayName(host)} ${host.name} ${
                      host.hostId
                    }`}
                    onSelect={() => handleSelectLead(host.hostId)}
                    className="cursor-pointer rounded-sm px-2 py-1"
                    data-testid={`client-row-${host.hostId}`}
                  >
                    <HostChipLogo
                      logoSrc={logo}
                      name={clientDisplayName(host)}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {clientDisplayName(host)}
                    </span>
                    {isComparing && host.hostId === leadHostId ? (
                      <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none text-primary">
                        Global
                      </span>
                    ) : null}
                    {checklistMode ? (
                      <div className="ml-auto flex shrink-0 items-center">
                        {isLimitedOut ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="flex">{compareToggle}</span>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              You can compare up to {maxSelectedHosts} clients
                              at once
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          compareToggle
                        )}
                      </div>
                    ) : host.hostId === leadHostId ? (
                      <div className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </CommandItem>
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
                  <span>Add client</span>
                </button>
                <span className="flex flex-1 items-center justify-between gap-0.5">
                  {orderedCatalogHosts
                    .slice(0, QUICK_ADD_VISIBLE)
                    .map((host) => {
                      const catalogHost =
                        catalogState.status === "live"
                          ? getCatalogHost(catalogState.catalog, host.id)
                          : undefined;
                      if (!catalogHost) return null;
                      return (
                        <button
                          key={host.id}
                          type="button"
                          aria-label={`Add ${catalogHost.label} client`}
                          title={`Add ${catalogHost.label}`}
                          data-testid={`client-quick-add-${host.id}`}
                          onClick={() => openCreateWithTemplate(host.id)}
                          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-accent"
                        >
                          <img
                            src={getHostLogoSrc(host.id, modalThemeMode)}
                            alt=""
                            className="size-4 object-contain"
                          />
                        </button>
                      );
                    })}
                </span>
                {orderedCatalogHosts.length > QUICK_ADD_VISIBLE ? (
                  <button
                    type="button"
                    aria-label="More clients"
                    title="More clients"
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
