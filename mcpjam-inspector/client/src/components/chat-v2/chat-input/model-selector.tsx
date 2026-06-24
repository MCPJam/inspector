import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";
import { ProviderLogo } from "./model/provider-logo";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@mcpjam/design-system/command";
import { ModelDefinition } from "@/shared/types.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import {
  compactModelLabel,
  getLogoProvider,
  getProviderDisplayName,
  isMCPJamProvidedModelMenuItem,
} from "@/components/chat-v2/shared/model-helpers";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";
import type { HostListItem } from "@/hooks/useClients";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";

/**
 * Optional host/client compare wiring (playground only). When provided, the
 * picker becomes a unified "run" control: a `Clients | Models` switch chooses
 * which axis to compare across, the trigger shows the lead client logo next to
 * the lead model logo, and the Clients axis renders the project's hosts with
 * the same multi-select machinery the Models axis uses. Host-compare and
 * model-compare are mutually exclusive — entering one collapses the other
 * (enforced by the parent's `onMultiHostEnabledChange` /
 * `onMultiModelEnabledChange`). Omitting this prop keeps the legacy
 * model-only behaviour for every other surface (ChatTabV2, the host builder).
 */
export interface ModelSelectorHostCompare {
  hosts: HostListItem[];
  /** Lead host id (from `usePreviewedHostId`). */
  currentHostId: string | null;
  /** Persisted compare lineup (from `usePersistedHost`). */
  selectedHostIds: string[];
  multiHostEnabled: boolean;
  onSelectedHostIdsChange: (ids: string[]) => void;
  onMultiHostEnabledChange: (enabled: boolean) => void;
  /** Promote a host to lead — wraps `replaceLeadHostId(projectId, hostId)`. */
  onPromoteLead: (hostId: string) => void;
  maxSelectedHosts?: number;
}

interface ModelSelectorProps {
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  isLoading?: boolean;
  hideProvidedModels?: boolean;
  /** @deprecated Model changes no longer reset the thread; kept for API compatibility. */
  hasMessages?: boolean;
  enableMultiModel?: boolean;
  multiModelEnabled?: boolean;
  selectedModels?: ModelDefinition[];
  onSelectedModelsChange?: (models: ModelDefinition[]) => void;
  onMultiModelEnabledChange?: (enabled: boolean) => void;
  maxSelectedModels?: number;
  /**
   * Popover alignment relative to the trigger. The chat-input default is
   * "start"; embeds near the right screen edge (e.g. the host-config Agent
   * tab) pass "end" so the panel opens inward instead of clipping.
   */
  align?: "start" | "center" | "end";
  /**
   * `location` for the picker's PostHog events. Non-chat embeds (e.g. the
   * client builder's Agent tab) pass their own so chat-input metrics stay
   * clean.
   */
  analyticsLocation?: string;
  /**
   * When true, this picker listens for the global "open Your providers tab"
   * intent (fired by the out-of-credits dialog's BYOK action) and pops open
   * on the configured tab. Only the chat-input instance opts in.
   */
  respondToProviderTabIntent?: boolean;
  /** See {@link ModelSelectorHostCompare}. Playground-only. */
  hostCompare?: ModelSelectorHostCompare;
}

type GroupKey = string;

type PendingSelectionChange =
  | {
      type: "single";
      nextModel: ModelDefinition;
    }
  | {
      type: "multi";
      enabled: boolean;
      selectedModels: ModelDefinition[];
    };

const groupModelsByProvider = (
  models: ModelDefinition[]
): Map<GroupKey, ModelDefinition[]> => {
  const groupedModels = new Map<GroupKey, ModelDefinition[]>();

  models.forEach((model) => {
    const key =
      model.provider === "custom" && model.customProviderName
        ? `custom:${model.customProviderName}`
        : model.provider;
    const existing = groupedModels.get(key) || [];
    groupedModels.set(key, [...existing, model]);
  });

  return groupedModels;
};

const getCustomName = (groupKey: GroupKey): string | undefined =>
  groupKey.startsWith("custom:") ? groupKey.slice("custom:".length) : undefined;

function sameModelOrder(
  left: ModelDefinition[],
  right: ModelDefinition[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (model, index) => String(model.id) === String(right[index]?.id)
  );
}

export function ModelSelector({
  currentModel,
  availableModels,
  onModelChange,
  onOpenChange,
  disabled,
  isLoading,
  hideProvidedModels = false,
  hasMessages: _hasMessages = false,
  enableMultiModel = false,
  multiModelEnabled = false,
  selectedModels,
  onSelectedModelsChange,
  onMultiModelEnabledChange,
  maxSelectedModels = 3,
  align = "start",
  analyticsLocation = "chat_input",
  respondToProviderTabIntent = false,
  hostCompare,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [providerTab, setProviderTab] = useState<"provided" | "configured">(
    "provided"
  );
  // Which axis the unified picker compares across. Only meaningful when
  // `hostCompare` is provided; defaults to the axis that is currently active.
  const [compareAxis, setCompareAxis] = useState<"clients" | "models">(
    hostCompare?.multiHostEnabled ? "clients" : "models"
  );
  const [search, setSearch] = useState("");
  const keepPopoverOpenRef = useRef(false);
  const keepPopoverOpenTimeoutRef = useRef<number | null>(null);
  const [hoveredLockedModelId, setHoveredLockedModelId] = useState<
    string | null
  >(null);
  const posthog = usePostHog();
  const onOpenChangeRef = useRef(onOpenChange);
  const forceConfiguredTabRef = useRef(false);
  const handledProvidersTabNonceRef = useRef(0);
  const selectedProvidersTabNonceRef = useRef(0);
  const providersTabNonce = useModelPickerIntentStore((state) =>
    respondToProviderTabIntent ? state.openProvidersTabNonce : 0
  );

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      if (forceConfiguredTabRef.current) {
        // A caller forced the "Your providers" tab (BYOK from the
        // out-of-credits dialog). Keep it instead of resetting to the current
        // model's tab; consume the flag so the next manual open resolves
        // normally.
        forceConfiguredTabRef.current = false;
        return;
      }
      setProviderTab(
        isMCPJamProvidedModelMenuItem(currentModel) ? "provided" : "configured"
      );
    } else {
      forceConfiguredTabRef.current = false;
      setSearch("");
    }
  }, [isOpen, currentModel]);

  // When the popover opens, snap the axis to whichever compare is currently
  // active so the user lands on the relevant list. We only sync on open (not
  // on every `multiHostEnabled` change) so a mid-session axis flip isn't
  // yanked back while the user is still picking.
  useEffect(() => {
    if (isOpen && hostCompare) {
      setCompareAxis(hostCompare.multiHostEnabled ? "clients" : "models");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const requestPopoverStayOpen = () => {
    keepPopoverOpenRef.current = true;
    setIsOpen(true);

    if (typeof window === "undefined") {
      return;
    }

    if (keepPopoverOpenTimeoutRef.current !== null) {
      window.clearTimeout(keepPopoverOpenTimeoutRef.current);
    }

    keepPopoverOpenTimeoutRef.current = window.setTimeout(() => {
      keepPopoverOpenRef.current = false;
      keepPopoverOpenTimeoutRef.current = null;
    }, 0);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && keepPopoverOpenRef.current) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      keepPopoverOpenTimeoutRef.current !== null
    ) {
      window.clearTimeout(keepPopoverOpenTimeoutRef.current);
      keepPopoverOpenTimeoutRef.current = null;
    }
    keepPopoverOpenRef.current = false;

    if (nextOpen && !isOpen) {
      posthog.capture(
        "chat_model_selector_clicked",
        standardEventProps(analyticsLocation)
      );
    }
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setHoveredLockedModelId(null);
    }
  };

  const selectedModelsData =
    selectedModels && selectedModels.length > 0
      ? selectedModels
      : [currentModel];

  const lockedRowHighlightId =
    hoveredLockedModelId ??
    (!multiModelEnabled && currentModel.disabled
      ? String(currentModel.id)
      : null);

  const groupedModels = useMemo(
    () => groupModelsByProvider(availableModels),
    [availableModels]
  );
  const sortedProviders = useMemo(
    () => Array.from(groupedModels.keys()).sort(),
    [groupedModels]
  );

  const modelGroups = useMemo(() => {
    const groups: {
      provider: GroupKey;
      title: string;
      providerType: "provided" | "configured";
      models: ModelDefinition[];
    }[] = [];

    for (const provider of sortedProviders) {
      const allModels = groupedModels.get(provider) || [];
      const filtered = hideProvidedModels
        ? allModels.filter((model) => !isMCPJamProvidedModelMenuItem(model))
        : allModels;

      if (filtered.length === 0) {
        continue;
      }

      const provided = filtered.filter((model) =>
        isMCPJamProvidedModelMenuItem(model)
      );
      const configured = filtered.filter(
        (model) => !isMCPJamProvidedModelMenuItem(model)
      );
      const title = getProviderDisplayName(provider);

      if (provided.length > 0) {
        groups.push({
          provider,
          title,
          providerType: "provided",
          models: provided,
        });
      }
      if (configured.length > 0) {
        groups.push({
          provider,
          title,
          providerType: "configured",
          models: configured,
        });
      }
    }

    return groups;
  }, [groupedModels, hideProvidedModels, sortedProviders]);

  const selectedIds = useMemo(
    () => new Set(selectedModelsData.map((model) => String(model.id))),
    [selectedModelsData]
  );
  const canUseMultiModel =
    enableMultiModel &&
    !!onSelectedModelsChange &&
    !!onMultiModelEnabledChange &&
    availableModels.length > 1;
  const leadModel = selectedModelsData[0] ?? currentModel;
  const triggerLabel =
    multiModelEnabled && selectedModelsData.length > 1
      ? `${compactModelLabel(leadModel.name)} +${selectedModelsData.length - 1}`
      : compactModelLabel(leadModel.name);
  const modelSections = useMemo(() => {
    const provided = modelGroups.filter((g) => g.providerType === "provided");
    const configured = modelGroups.filter(
      (g) => g.providerType === "configured"
    );
    return { provided, configured };
  }, [modelGroups]);
  const firstEnabledConfiguredModel = useMemo(
    () =>
      modelSections.configured
        .flatMap((group) => group.models)
        .find((model) => !model.disabled),
    [modelSections]
  );
  const selectedLimitReached =
    multiModelEnabled && selectedModelsData.length >= maxSelectedModels;

  // ---- Host/client compare (playground only) ------------------------------
  const hostList = hostCompare?.hosts ?? [];
  const maxSelectedHosts = hostCompare?.maxSelectedHosts ?? 3;
  const hostsById = useMemo(() => {
    const map = new Map<string, HostListItem>();
    for (const host of hostList) map.set(host.hostId, host);
    return map;
  }, [hostList]);
  // Mirror `selectedModelsData`: fall back to the lead host when the persisted
  // compare array is empty so the list always has a selection to anchor on.
  const effectiveSelectedHostIds = useMemo(() => {
    if (!hostCompare) return [];
    if (hostCompare.selectedHostIds.length > 0) return hostCompare.selectedHostIds;
    return hostCompare.currentHostId ? [hostCompare.currentHostId] : [];
  }, [hostCompare]);
  const hostSelectedSet = useMemo(
    () => new Set(effectiveSelectedHostIds),
    [effectiveSelectedHostIds]
  );
  const leadHostId =
    effectiveSelectedHostIds[0] ?? hostCompare?.currentHostId ?? null;
  const leadHost = leadHostId ? hostsById.get(leadHostId) ?? null : null;
  const leadHostName = leadHost?.name ?? "";
  const leadHostLogo = leadHostName
    ? resolveHostLogoByDisplayName(leadHostName)
    : null;
  const hostLimitReached =
    effectiveSelectedHostIds.length >= maxSelectedHosts;
  const isComparingHosts =
    !!hostCompare &&
    hostCompare.multiHostEnabled &&
    effectiveSelectedHostIds.length > 1;

  const handleSelectAxis = (axis: "clients" | "models") => {
    if (!hostCompare || axis === compareAxis) return;
    // Non-destructive: just swap the visible list. Mutual exclusion is enforced
    // the moment the user actually adds a 2nd item on the other axis (the
    // parent's onMulti*EnabledChange clears the opposing compare then).
    requestPopoverStayOpen();
    setCompareAxis(axis);
  };

  const handleHostRowToggle = (hostId: string) => {
    if (!hostCompare) return;
    requestPopoverStayOpen();
    const isSelected = hostSelectedSet.has(hostId);
    const nextSelectedHostIds = isSelected
      ? effectiveSelectedHostIds.filter((id) => id !== hostId)
      : [...effectiveSelectedHostIds, hostId];
    // Never collapse to empty — the lead has to stay.
    if (nextSelectedHostIds.length === 0) return;
    hostCompare.onSelectedHostIdsChange(nextSelectedHostIds);
    hostCompare.onMultiHostEnabledChange(nextSelectedHostIds.length > 1);
  };

  const handlePromoteLeadHost = (hostId: string) => {
    if (!hostCompare || hostId === leadHostId) return;
    requestPopoverStayOpen();
    hostCompare.onPromoteLead(hostId);
  };

  const showCompareSwitch = !!hostCompare;
  const showHostList = !!hostCompare && compareAxis === "clients";
  const showModelBody = !hostCompare || compareAxis === "models";
  // When comparing clients the badge counts hosts; otherwise it's the model
  // label (which already carries its own "+N" when comparing models).
  const runTriggerLabel = isComparingHosts
    ? `${leadHostName} +${effectiveSelectedHostIds.length - 1}`
    : triggerLabel;

  // React to the global "open Your providers tab" intent (out-of-credits
  // BYOK). Only the opted-in instance subscribes to a live nonce; others read
  // a constant 0 so this never fires for them.
  useEffect(() => {
    if (!respondToProviderTabIntent) return;
    if (providersTabNonce === 0) return;

    if (providersTabNonce !== handledProvidersTabNonceRef.current) {
      handledProvidersTabNonceRef.current = providersTabNonce;
      forceConfiguredTabRef.current = true;
      setProviderTab("configured");
      setIsOpen(true);
    }

    if (
      providersTabNonce !== selectedProvidersTabNonceRef.current &&
      firstEnabledConfiguredModel
    ) {
      selectedProvidersTabNonceRef.current = providersTabNonce;
      onModelChange(firstEnabledConfiguredModel);
    }
  }, [
    firstEnabledConfiguredModel,
    onModelChange,
    providersTabNonce,
    respondToProviderTabIntent,
  ]);

  const requestSelectionChange = (nextChange: PendingSelectionChange) => {
    const isSingleNoOp =
      nextChange.type === "single" &&
      String(nextChange.nextModel.id) === String(currentModel.id);
    const isMultiNoOp =
      nextChange.type === "multi" &&
      nextChange.enabled === multiModelEnabled &&
      sameModelOrder(nextChange.selectedModels, selectedModelsData);

    if (isSingleNoOp) {
      setIsOpen(false);
      return;
    }
    if (isMultiNoOp) {
      return;
    }

    if (nextChange.type === "single") {
      onModelChange(nextChange.nextModel);
      setIsOpen(false);
    } else {
      onSelectedModelsChange?.(nextChange.selectedModels);
      onMultiModelEnabledChange?.(nextChange.enabled);
    }
  };

  const handleToggleMultiModel = (enabled: boolean) => {
    if (!canUseMultiModel) {
      return;
    }

    requestPopoverStayOpen();

    if (enabled) {
      requestSelectionChange({
        type: "multi",
        enabled: true,
        selectedModels:
          selectedModelsData.length > 0 ? selectedModelsData : [currentModel],
      });
      return;
    }

    requestSelectionChange({
      type: "multi",
      enabled: false,
      selectedModels: [leadModel],
    });
  };

  const handleMultiModelSelect = (model: ModelDefinition) => {
    requestPopoverStayOpen();

    const isSelected = selectedIds.has(String(model.id));
    const nextSelectedModels = isSelected
      ? selectedModelsData.filter(
          (selectedModel) => String(selectedModel.id) !== String(model.id)
        )
      : [...selectedModelsData, model];

    if (nextSelectedModels.length === 0) {
      return;
    }

    requestSelectionChange({
      type: "multi",
      enabled: true,
      selectedModels: nextSelectedModels,
    });
  };

  const handlePromoteLeadModel = (model: ModelDefinition) => {
    if (!multiModelEnabled || String(model.id) === String(leadModel.id)) {
      return;
    }

    requestPopoverStayOpen();

    const nextSelectedModels = [
      model,
      ...selectedModelsData.filter(
        (selectedModel) => String(selectedModel.id) !== String(model.id)
      ),
    ];

    requestSelectionChange({
      type: "multi",
      enabled: true,
      selectedModels: nextSelectedModels,
    });
  };

  const renderGroupModelItems = (group: (typeof modelGroups)[number]) =>
    group.models.map((model) => {
      const isDisabled =
        !!model.disabled ||
        (multiModelEnabled &&
          !selectedIds.has(String(model.id)) &&
          selectedLimitReached);
      const disabledReason =
        model.disabledReason ??
        (!selectedIds.has(String(model.id)) && selectedLimitReached
          ? `You can compare up to ${maxSelectedModels} models at once`
          : undefined);
      const isLockedRowHighlight =
        lockedRowHighlightId === String(model.id) && !!disabledReason;
      const isSelected = selectedIds.has(String(model.id));

      const row = (
        <CommandItem
          key={String(model.id)}
          value={`${model.name} ${group.title} ${String(model.id)}`}
          onSelect={() => {
            if (multiModelEnabled) {
              handleMultiModelSelect(model);
            } else {
              requestSelectionChange({
                type: "single",
                nextModel: model,
              });
            }
          }}
          disabled={isDisabled}
          className={cn(
            "cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed",
            lockedRowHighlightId &&
              "data-[selected=true]:bg-transparent data-[selected=true]:text-inherit"
          )}
        >
          <ProviderLogo
            provider={getLogoProvider(group.provider)}
            customProviderName={getCustomName(group.provider)}
            className="size-3.5"
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {compactModelLabel(model.name)}
          </span>
          {multiModelEnabled ? (
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
          ) : String(model.id) === String(currentModel.id) ? (
            <div className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
        </CommandItem>
      );

      return disabledReason ? (
        <Tooltip key={String(model.id)}>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "rounded-sm transition-colors",
                isLockedRowHighlight ? "bg-accent/60" : "hover:bg-accent/60"
              )}
              onMouseEnter={() => setHoveredLockedModelId(String(model.id))}
              onMouseLeave={() => setHoveredLockedModelId(null)}
            >
              {row}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">{disabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        row
      );
    });

  return (
    <>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || isLoading}
                className={cn(
                  "h-8 rounded-full px-2 text-xs transition-colors hover:bg-muted/80",
                  hostCompare
                    ? "max-w-[220px] gap-1 @max-2xl/toolbar:max-w-none @max-2xl/toolbar:px-1"
                    : "max-w-[180px] @max-2xl/toolbar:max-w-none @max-2xl/toolbar:w-8 @max-2xl/toolbar:px-0"
                )}
              >
                {hostCompare ? (
                  leadHostLogo ? (
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
                  )
                ) : null}
                <ProviderLogo
                  provider={leadModel.provider}
                  customProviderName={leadModel.customProviderName}
                />
                <span className="truncate text-[10px] font-medium @max-2xl/toolbar:hidden">
                  {runTriggerLabel}
                </span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{runTriggerLabel}</TooltipContent>
        </Tooltip>

        <PopoverContent
          align={align}
          className="w-[280px] p-0"
          sideOffset={8}
          collisionPadding={8}
        >
          <Command shouldFilter={true}>
            <CommandInput
              placeholder={showHostList ? "Search clients" : "Search models"}
              value={search}
              onValueChange={setSearch}
            />

            {showCompareSwitch ? (
              <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  Compare
                </span>
                <div className="flex flex-1 gap-1">
                  {(["models", "clients"] as const).map((axis) => (
                    <button
                      key={axis}
                      type="button"
                      onClick={() => handleSelectAxis(axis)}
                      className={cn(
                        "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        compareAxis === axis
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      data-testid={`compare-axis-${axis}`}
                      data-active={compareAxis === axis ? "true" : "false"}
                    >
                      {axis === "models" ? "Models" : "Clients"}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {showModelBody && canUseMultiModel ? (
              <>
                <div className="flex cursor-default items-center justify-between gap-2 border-b px-2.5 py-2">
                  <span className="text-xs text-muted-foreground">
                    Multiple models
                  </span>
                  <Switch
                    checked={multiModelEnabled}
                    onCheckedChange={handleToggleMultiModel}
                    aria-label="Use multiple models"
                    disabled={disabled || isLoading}
                  />
                </div>

                {multiModelEnabled ? (
                  <div
                    className="flex flex-wrap gap-1 border-b px-2.5 py-1.5"
                    title="First chip is the lead model. Click a chip to promote it."
                  >
                    {selectedModelsData.map((model, index) => {
                      const isLead = index === 0;
                      return (
                        <button
                          key={String(model.id)}
                          type="button"
                          className={cn(
                            "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                            isLead
                              ? "border-primary/25 bg-primary/5 text-foreground"
                              : "border-border/50 bg-muted/30 text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => handlePromoteLeadModel(model)}
                        >
                          <ProviderLogo
                            provider={model.provider}
                            customProviderName={model.customProviderName}
                            className="size-3"
                          />
                          <span className="truncate">
                            {compactModelLabel(model.name)}
                          </span>
                          {selectedModelsData.length > 1 ? (
                            <span
                              role="button"
                              tabIndex={-1}
                              className="inline-flex size-3.5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMultiModelSelect(model);
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
                        Max {maxSelectedModels}. Remove one to add another.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {showModelBody ? (() => {
              const hasBothSections =
                modelSections.provided.length > 0 &&
                modelSections.configured.length > 0;
              const isSearching = search.trim().length > 0;
              const showTabs = hasBothSections && !isSearching;
              const showProvided =
                modelSections.provided.length > 0 &&
                (isSearching || !hasBothSections || providerTab === "provided");
              const showConfigured =
                modelSections.configured.length > 0 &&
                (isSearching ||
                  !hasBothSections ||
                  providerTab === "configured");

              return (
                <>
                  {showTabs ? (
                    <div className="flex gap-1 border-b px-2 py-1.5">
                      {(["provided", "configured"] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setProviderTab(tab)}
                          className={cn(
                            "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                            providerTab === tab
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {tab === "provided"
                            ? "Free models"
                            : "Your providers"}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <CommandList className="max-h-[min(320px,45vh)]">
                    <CommandEmpty>No matching models.</CommandEmpty>

                    {showProvided ? (
                      <CommandGroup
                        heading={isSearching ? "Free models" : undefined}
                      >
                        {modelSections.provided.map((group) => (
                          <div key={`${group.provider}:${group.providerType}`}>
                            <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                              {group.title}
                            </div>
                            {renderGroupModelItems(group)}
                          </div>
                        ))}
                      </CommandGroup>
                    ) : null}

                    {isSearching && showProvided && showConfigured ? (
                      <CommandSeparator />
                    ) : null}

                    {showConfigured ? (
                      <CommandGroup
                        heading={isSearching ? "Your providers" : undefined}
                      >
                        {modelSections.configured.map((group) => (
                          <div key={`${group.provider}:${group.providerType}`}>
                            <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                              {group.title}
                            </div>
                            {renderGroupModelItems(group)}
                          </div>
                        ))}
                      </CommandGroup>
                    ) : null}
                  </CommandList>
                </>
              );
            })() : null}

            {showHostList ? (
              <>
                {effectiveSelectedHostIds.length > 1 ? (
                  <div
                    className="flex flex-wrap gap-1 border-b px-2.5 py-1.5"
                    title="First chip is the lead client. Click a chip to promote it."
                  >
                    {effectiveSelectedHostIds.map((hostId, index) => {
                      const host = hostsById.get(hostId);
                      const isLead = index === 0;
                      const name = host?.name ?? hostId;
                      const logo = resolveHostLogoByDisplayName(name);
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
                          onClick={() => handlePromoteLeadHost(hostId)}
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
                                handleHostRowToggle(hostId);
                              }}
                            >
                              <X className="h-2.5 w-2.5" />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {hostLimitReached ? (
                      <span className="w-full text-[10px] text-muted-foreground">
                        Max {maxSelectedHosts}. Remove one to add another.
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <CommandList className="max-h-[min(320px,45vh)]">
                  <CommandEmpty>No matching clients.</CommandEmpty>
                  {hostList.length <= 1 ? (
                    <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                      Add a second client to start comparing.
                    </div>
                  ) : null}
                  {hostList.map((host) => {
                    const isSelected = hostSelectedSet.has(host.hostId);
                    const isLimitedOut = !isSelected && hostLimitReached;
                    const logo = resolveHostLogoByDisplayName(host.name);

                    const row = (
                      <CommandItem
                        key={host.hostId}
                        value={`${host.name} ${host.hostId}`}
                        onSelect={() => handleHostRowToggle(host.hostId)}
                        disabled={isLimitedOut}
                        className="cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed"
                        data-testid={`compare-host-row-${host.hostId}`}
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
                          You can compare up to {maxSelectedHosts} clients at once
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      row
                    );
                  })}
                </CommandList>
              </>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
