import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultFilter } from "cmdk";
import { ArrowUpRight, Check, X } from "lucide-react";
import { track } from "@/lib/analytics";
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
  pickOwnProviderModel,
} from "@/components/chat-v2/shared/model-helpers";
import {
  applyWorkloadCapabilityLocks,
  NOT_VERIFIED_TAG,
  retiringTag,
  sortModelsNewestFirst,
  type ModelWorkload,
} from "@/components/chat-v2/shared/available-models";
import { modelRowKey } from "@/components/chat-v2/shared/model-selection";
import { loadLastOwnProviderModelId } from "@/lib/selected-model-storage";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";

interface ModelSelectorProps {
  /** Alternate trigger for embedded surfaces such as eval tables. */
  trigger?: ReactNode;
  inModal?: boolean;
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  /** `userInitiated` marks a pick made from this menu, as opposed to the
   * out-of-credits hand-off below deriving one. Only the former should update
   * the remembered own-provider model. */
  onModelChange: (
    model: ModelDefinition,
    options?: { userInitiated?: boolean },
  ) => void;
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
  /**
   * Navigates to the org's model providers page. Rendered as a footer under the
   * "Your providers" list so adding another BYOK key doesn't mean hunting
   * through Settings. Callers pass it only when the viewer may actually open
   * org settings; omitted, the footer is absent rather than disabled.
   */
  onManageOrgProviders?: () => void;
  platformPaidFallback?: boolean;
  /**
   * What this surface runs the model for. Rows whose catalog observed a
   * capability the workload needs as unsupported are disabled, and ones
   * observed as unknown are tagged "Not verified" (disabled for eval and
   * persona runs, warned elsewhere). Omitted, rows render exactly as passed.
   * See `MODEL_WORKLOAD_POLICIES`.
   */
  workload?: ModelWorkload;
  /**
   * Multi-select only: the selection may be emptied. Without it the last
   * selected row cannot be removed (chat always runs at least one model).
   * Surfaces with another way to run (an environment's "Client defaults")
   * pass it, and then an empty `selectedModels` means nothing is selected.
   */
  allowEmptySelection?: boolean;
  /**
   * Non-model choices listed above the models (an environment's "Client
   * defaults"). In multi-select mode they toggle like rows and keep the menu
   * open; in single mode a pick closes it.
   */
  extraOptions?: ModelSelectorExtraOption[];
  /**
   * A surface's own reason a row cannot be added right now (for example a
   * run budget), shown like a lock. Selected rows stay removable.
   */
  rowDisabledReason?: (
    model: ModelDefinition,
    state: { selected: boolean },
  ) => string | undefined;
  /** A surface's own tag for a row ("Not eligible", "Not in catalog"). */
  rowTag?: (model: ModelDefinition) => string | undefined;
}

export interface ModelSelectorExtraOption {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /** Shown under the option while it is disabled. */
  disabledReason?: string;
  onSelect: () => void;
  testId?: string;
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
  models: ModelDefinition[],
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

type ModelGroup = {
  provider: GroupKey;
  title: string;
  providerType: "provided" | "configured";
  models: ModelDefinition[];
};

/**
 * The string cmdk scores a row against. Also used to decide whether a provider
 * heading has any surviving rows, so both must derive from the same value —
 * cmdk trims item values, so this is pre-trimmed to match exactly.
 */
const modelSearchValue = (model: ModelDefinition, groupTitle: string): string =>
  `${model.name} ${groupTitle} ${String(model.id)}`.trim();

/**
 * cmdk's `defaultFilter` accepts any subsequence, so o-p-u-s scattered across
 * "Claude Sonnet 4.5 Anthropic anthropic/claude-sonnet-4.5" scores above zero
 * and renders under a search for "opus". Real matches score ~0.89+ against the
 * hosted catalog while that incidental noise tops out near 0.17, so anything
 * below this is treated as no match.
 */
const MIN_MODEL_SEARCH_SCORE = 0.3;

/**
 * The threshold is applied per word rather than to the whole query, because
 * cmdk scores a multi-word search as one gapped subsequence and the gaps drag
 * even an exact hit under it — "gemini 3 pro" scores 0.168 against Gemini 3.1
 * Pro Preview, while its words score 0.99 each. Single-character words are
 * exempt: they only clear the threshold when they start a word, so gating on
 * them would drop every Qwen3 Coder row from a search for "qwen 3 coder".
 * cmdk's own score is returned untouched so ranking is unchanged.
 */
export const modelFilter = (
  value: string,
  search: string,
  keywords?: string[],
): number => {
  const score = defaultFilter(value, search, keywords);
  if (score <= 0) {
    return 0;
  }

  const words = search.split(/\s+/).filter((word) => word.length > 1);
  const everyWordMatches = words.every(
    (word) => defaultFilter(value, word, keywords) >= MIN_MODEL_SEARCH_SCORE,
  );

  return everyWordMatches ? score : 0;
};

/**
 * Provider headings are plain rows, not `CommandGroup`s, so cmdk's own
 * empty-group hiding never applies to them: without this, a search shows a
 * heading for every provider even when it has no matching model. This must
 * score with the same `modelFilter` the `Command` below is given — the two
 * drifting apart is what left headings stranded over no rows once already.
 */
const groupHasMatch = (group: ModelGroup, search: string): boolean =>
  group.models.some(
    (model) => modelFilter(modelSearchValue(model, group.title), search) > 0,
  );

function SelectionCheck({ checked }: { checked: boolean }) {
  return (
    <div
      className={cn(
        "ml-auto flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.33,1,0.68,1)]",
        checked
          ? "border-primary bg-primary shadow-sm"
          : "border-border/60 bg-transparent hover:border-border",
      )}
      aria-hidden
    >
      {checked ? (
        <Check
          strokeWidth={3}
          className="size-2.5 animate-in zoom-in-95 fade-in duration-200 fill-none text-primary-foreground"
        />
      ) : null}
    </div>
  );
}

// The credential source is part of a selection: equal IDs can belong to
// different providers, and an omitted routing flag has legacy server semantics.
function sameModelSelection(
  left: ModelDefinition,
  right: ModelDefinition,
): boolean {
  return (
    String(left.id) === String(right.id) &&
    left.provider === right.provider &&
    left.customProviderName === right.customProviderName &&
    left.hosted === right.hosted
  );
}

function sameModelOrder(
  left: ModelDefinition[],
  right: ModelDefinition[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (model, index) => sameModelSelection(model, right[index]!),
  );
}

export function ModelSelector({
  trigger,
  inModal = false,
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
  onManageOrgProviders,
  platformPaidFallback = false,
  workload,
  allowEmptySelection = false,
  extraOptions,
  rowDisabledReason,
  rowTag,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [providerTab, setProviderTab] = useState<"provided" | "configured">(
    "provided",
  );
  const [search, setSearch] = useState("");
  const keepPopoverOpenRef = useRef(false);
  const keepPopoverOpenTimeoutRef = useRef<number | null>(null);
  const [hoveredLockedModelId, setHoveredLockedModelId] = useState<
    string | null
  >(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const forceConfiguredTabRef = useRef(false);
  const handledProvidersTabNonceRef = useRef(0);
  const selectedProvidersTabNonceRef = useRef(0);
  const providersTabNonce = useModelPickerIntentStore((state) =>
    respondToProviderTabIntent ? state.openProvidersTabNonce : 0,
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
        isMCPJamProvidedModelMenuItem(currentModel) ? "provided" : "configured",
      );
    } else {
      forceConfiguredTabRef.current = false;
      setSearch("");
    }
  }, [isOpen, currentModel]);

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
      track("chat_model_selector_clicked", { location: analyticsLocation });
    }
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setHoveredLockedModelId(null);
    }
  };

  const handleManageOrgProviders = () => {
    track("chat_model_selector_manage_org_models_clicked", {
      location: analyticsLocation,
    });
    // Navigating away from a chat while the popover is mounted leaves it
    // orphaned over the next screen, so close it before handing off.
    setIsOpen(false);
    onManageOrgProviders?.();
  };

  const selectedModelsData = allowEmptySelection
    ? (selectedModels ?? [])
    : selectedModels && selectedModels.length > 0
      ? selectedModels
      : [currentModel];

  // Rows are identified by `modelRowKey`, not the raw id: one id can be
  // listed by the hosted catalog and again under an org connection.
  const lockedRowHighlightId =
    hoveredLockedModelId ??
    (!multiModelEnabled && currentModel.disabled
      ? modelRowKey(currentModel)
      : null);

  // Rows as displayed: the surface's capability needs applied, newest first
  // within each provider (grouping keeps this order).
  const displayModels = useMemo(
    () =>
      sortModelsNewestFirst(
        applyWorkloadCapabilityLocks(availableModels, workload),
      ),
    [availableModels, workload],
  );
  const groupedModels = useMemo(
    () => groupModelsByProvider(displayModels),
    [displayModels],
  );
  const sortedProviders = useMemo(
    () => Array.from(groupedModels.keys()).sort(),
    [groupedModels],
  );

  const modelGroups = useMemo(() => {
    const groups: ModelGroup[] = [];

    for (const provider of sortedProviders) {
      const allModels = groupedModels.get(provider) || [];
      const filtered = hideProvidedModels
        ? allModels.filter((model) => !isMCPJamProvidedModelMenuItem(model))
        : allModels;

      if (filtered.length === 0) {
        continue;
      }

      const provided = filtered.filter((model) =>
        isMCPJamProvidedModelMenuItem(model),
      );
      const configured = filtered.filter(
        (model) => !isMCPJamProvidedModelMenuItem(model),
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

  const selectedKeys = useMemo(
    () => new Set(selectedModelsData.map((model) => modelRowKey(model))),
    [selectedModelsData],
  );
  const canUseMultiModel =
    enableMultiModel &&
    !!onSelectedModelsChange &&
    !!onMultiModelEnabledChange &&
    availableModels.length > 1;
  const leadModel = selectedModelsData[0] ?? currentModel;
  const isComparingModels = multiModelEnabled && selectedModelsData.length > 1;
  const triggerLabel = isComparingModels
    ? `${compactModelLabel(leadModel.name)} +${selectedModelsData.length - 1}`
    : compactModelLabel(leadModel.name);
  const modelSections = useMemo(() => {
    const provided = modelGroups.filter((g) => g.providerType === "provided");
    const configured = modelGroups.filter(
      (g) => g.providerType === "configured",
    );
    return { provided, configured };
  }, [modelGroups]);
  const configuredModels = useMemo(
    () => modelSections.configured.flatMap((group) => group.models),
    [modelSections],
  );
  // Headings for providers whose rows all get filtered out are dropped here;
  // `search` (not its trimmed form) gates this so the set of headings tracks
  // cmdk's row filtering, which keys off the raw search string.
  const visibleSections = useMemo(() => {
    if (!search) {
      return modelSections;
    }
    return {
      provided: modelSections.provided.filter((group) =>
        groupHasMatch(group, search),
      ),
      configured: modelSections.configured.filter((group) =>
        groupHasMatch(group, search),
      ),
    };
  }, [modelSections, search]);
  const selectedLimitReached =
    multiModelEnabled && selectedModelsData.length >= maxSelectedModels;

  // Counterpart of the nonce subscription below: tell the store a picker is
  // on screen that will actually honour the intent. The out-of-credits
  // dialog reads that count to decide between opening this picker in place
  // and navigating to the org's AI providers page. Read off `getState()` so
  // registering adds no subscription and no re-render.
  useEffect(() => {
    if (!respondToProviderTabIntent) return;
    return useModelPickerIntentStore.getState().registerProvidersTabResponder();
  }, [respondToProviderTabIntent]);

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

    if (providersTabNonce === selectedProvidersTabNonceRef.current) {
      return;
    }

    // Already on an own-provider model: the user's standing choice wins.
    // Re-selecting here overwrote a working BYOK pick every time the
    // out-of-credits dialog reopened, which is what made the selection look
    // like it never persisted across chats (BACK2-628).
    if (!isMCPJamProvidedModelMenuItem(currentModel)) {
      selectedProvidersTabNonceRef.current = providersTabNonce;
      return;
    }

    const nextModel = pickOwnProviderModel(
      configuredModels,
      loadLastOwnProviderModelId(),
    );
    // No own-provider models resolved yet (keys still loading). Leave the
    // nonce unconsumed so this settles once the list arrives.
    if (!nextModel) {
      return;
    }

    selectedProvidersTabNonceRef.current = providersTabNonce;
    // Derived, not picked — deliberately not `userInitiated`, so restoring a
    // remembered model doesn't count as choosing it again.
    onModelChange(nextModel);
  }, [
    configuredModels,
    currentModel,
    onModelChange,
    providersTabNonce,
    respondToProviderTabIntent,
  ]);

  const requestSelectionChange = (nextChange: PendingSelectionChange) => {
    const isSingleNoOp =
      nextChange.type === "single" &&
      sameModelSelection(nextChange.nextModel, currentModel);
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
      onModelChange(nextChange.nextModel, { userInitiated: true });
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

    const key = modelRowKey(model);
    const isSelected = selectedKeys.has(key);
    const nextSelectedModels = isSelected
      ? selectedModelsData.filter(
          (selectedModel) => modelRowKey(selectedModel) !== key,
        )
      : [...selectedModelsData, model];

    if (nextSelectedModels.length === 0 && !allowEmptySelection) {
      return;
    }

    requestSelectionChange({
      type: "multi",
      enabled: true,
      selectedModels: nextSelectedModels,
    });
  };

  const handlePromoteLeadModel = (model: ModelDefinition) => {
    const key = modelRowKey(model);
    if (!multiModelEnabled || key === modelRowKey(leadModel)) {
      return;
    }

    requestPopoverStayOpen();

    const nextSelectedModels = [
      model,
      ...selectedModelsData.filter(
        (selectedModel) => modelRowKey(selectedModel) !== key,
      ),
    ];

    requestSelectionChange({
      type: "multi",
      enabled: true,
      selectedModels: nextSelectedModels,
    });
  };

  const handleExtraOption = (option: ModelSelectorExtraOption) => {
    if (option.disabled) return;
    if (multiModelEnabled) {
      requestPopoverStayOpen();
      option.onSelect();
      return;
    }
    option.onSelect();
    setIsOpen(false);
  };

  const renderGroupModelItems = (group: ModelGroup) =>
    group.models.map((model) => {
      const rowKey = modelRowKey(model);
      const isSelected = selectedKeys.has(rowKey);
      const limitReason =
        multiModelEnabled && !isSelected && selectedLimitReached
          ? `You can compare up to ${maxSelectedModels} models at once`
          : undefined;
      const surfaceReason = rowDisabledReason?.(model, {
        selected: isSelected,
      });
      // A selected row stays removable in multi-select even when it is
      // locked now: locks only block adding it.
      const isDisabled =
        (!!model.disabled || !!limitReason || !!surfaceReason) &&
        !(multiModelEnabled && isSelected);
      const disabledReason =
        model.disabledReason ?? surfaceReason ?? limitReason;
      const isLockedRowHighlight =
        lockedRowHighlightId === rowKey && !!disabledReason;
      const rowTags = [
        rowTag?.(model),
        model.unverifiedCapabilities?.length ? NOT_VERIFIED_TAG : undefined,
        retiringTag(model),
      ].filter((tag): tag is string => !!tag);

      const row = (
        <CommandItem
          key={rowKey}
          value={modelSearchValue(model, group.title)}
          aria-checked={multiModelEnabled ? isSelected : undefined}
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
              "data-[selected=true]:bg-transparent data-[selected=true]:text-inherit",
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
          {rowTags.map((tag) => (
            <span
              key={tag}
              data-testid="model-row-tag"
              className={cn(
                "shrink-0 rounded border px-1 text-[9px] leading-4",
                tag === NOT_VERIFIED_TAG
                  ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
                  : "border-border/60 text-muted-foreground",
              )}
            >
              {tag}
            </span>
          ))}
          {multiModelEnabled ? (
            <SelectionCheck checked={isSelected} />
          ) : sameModelSelection(model, currentModel) ? (
            <div className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
        </CommandItem>
      );

      return disabledReason ? (
        <Tooltip key={rowKey}>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "rounded-sm transition-colors",
                isLockedRowHighlight ? "bg-accent/60" : "hover:bg-accent/60",
              )}
              onMouseEnter={() => setHoveredLockedModelId(rowKey)}
              onMouseLeave={() => setHoveredLockedModelId(null)}
            >
              {row}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">{disabledReason}</TooltipContent>
        </Tooltip>
      ) : model.warningReason ? (
        <Tooltip key={rowKey}>
          <TooltipTrigger asChild>
            <div className="rounded-sm">{row}</div>
          </TooltipTrigger>
          <TooltipContent side="right">{model.warningReason}</TooltipContent>
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
              {trigger ?? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || isLoading}
                  className={cn(
                    "h-8 rounded-full px-2 text-xs transition-colors hover:bg-muted/80 @max-2xl/toolbar:max-w-none @max-2xl/toolbar:w-8 @max-2xl/toolbar:px-0",
                    isComparingModels
                      ? "max-w-[280px] gap-1"
                      : "max-w-[180px] gap-1",
                  )}
                  data-testid="model-selector-trigger"
                >
                  {isComparingModels ? (
                    <span className="flex min-w-0 items-center gap-1 overflow-hidden @max-2xl/toolbar:hidden">
                      {selectedModelsData.map((model, index) => (
                        <span
                          key={modelRowKey(model)}
                          className={cn(
                            "inline-flex h-5 w-[82px] min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium",
                            index === 0
                              ? "border-primary/25 text-foreground"
                              : "border-border/50 text-muted-foreground",
                          )}
                        >
                          <ProviderLogo
                            provider={model.provider}
                            customProviderName={model.customProviderName}
                            className="size-3 shrink-0"
                          />
                          <span className="truncate">
                            {compactModelLabel(model.name)}
                          </span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <>
                      <ProviderLogo
                        provider={leadModel.provider}
                        customProviderName={leadModel.customProviderName}
                      />
                      <span className="truncate text-[10px] font-medium @max-2xl/toolbar:hidden">
                        {triggerLabel}
                      </span>
                    </>
                  )}
                  {isComparingModels ? (
                    <ProviderLogo
                      provider={leadModel.provider}
                      customProviderName={leadModel.customProviderName}
                      className="hidden size-3 shrink-0 @max-2xl/toolbar:block"
                    />
                  ) : null}
                </Button>
              )}
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {multiModelEnabled && selectedModelsData.length > 1
              ? "Models"
              : "Model"}
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          portalled={!inModal}
          align={align}
          className="w-[280px] p-0"
          sideOffset={8}
          collisionPadding={8}
        >
          <Command shouldFilter={true} filter={modelFilter}>
            <CommandInput
              placeholder="Search models"
              value={search}
              onValueChange={setSearch}
            />

            {canUseMultiModel ? (
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
                          key={modelRowKey(model)}
                          type="button"
                          className={cn(
                            "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                            isLead
                              ? "border-primary/25 bg-primary/5 text-foreground"
                              : "border-border/50 bg-muted/30 text-muted-foreground hover:text-foreground",
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

            {(() => {
              const isSearching = search.trim().length > 0;
              // An org admin with no keys yet is exactly who the footer below is
              // for, so the tab stays reachable while their list is empty —
              // gating it on a non-empty list hid the offer to add a key from
              // everyone who had none.
              const offerEmptyConfigured =
                !!onManageOrgProviders && modelSections.configured.length === 0;
              const showTabs =
                !isSearching &&
                modelSections.provided.length > 0 &&
                (modelSections.configured.length > 0 || offerEmptyConfigured);
              const showProvided =
                visibleSections.provided.length > 0 &&
                (isSearching || !showTabs || providerTab === "provided");
              const showConfigured =
                visibleSections.configured.length > 0 &&
                (isSearching || !showTabs || providerTab === "configured");
              const showConfiguredEmpty =
                showTabs &&
                providerTab === "configured" &&
                visibleSections.configured.length === 0;

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
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {tab === "provided"
                            ? (platformPaidFallback ? "MCPJam models" : "Free models")
                            : "Your providers"}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {platformPaidFallback && providerTab === "provided" && (
                    <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
                      Shared free allowance is unavailable. These models use your purchased credits.
                    </p>
                  )}
                  <CommandList className="max-h-[min(320px,45vh)]">
                    {/* cmdk renders Empty whenever no rows are mounted, which
                        the empty providers tab below would otherwise inherit —
                        and "No matching models" reads as a failed search. */}
                    {showConfiguredEmpty ? null : (
                      <CommandEmpty>No matching models.</CommandEmpty>
                    )}

                    {showConfiguredEmpty ? (
                      <p className="px-2.5 py-3 text-[11px] text-muted-foreground">
                        No provider keys yet.
                      </p>
                    ) : null}

                    {extraOptions && extraOptions.length > 0 ? (
                      <CommandGroup>
                        {extraOptions.map((option) => (
                          <div key={option.id}>
                            <CommandItem
                              value={option.label}
                              onSelect={() => handleExtraOption(option)}
                              disabled={option.disabled}
                              aria-checked={
                                multiModelEnabled ? option.checked : undefined
                              }
                              data-testid={option.testId}
                              className="cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">
                                  {option.label}
                                </span>
                                {option.description ? (
                                  <span className="block truncate text-[10px] text-muted-foreground">
                                    {option.description}
                                  </span>
                                ) : null}
                              </span>
                              {multiModelEnabled ? (
                                <SelectionCheck checked={option.checked} />
                              ) : option.checked ? (
                                <div className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                              ) : null}
                            </CommandItem>
                            {option.disabled && option.disabledReason ? (
                              <p className="px-2 pb-1 text-[10px] text-muted-foreground">
                                {option.disabledReason}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </CommandGroup>
                    ) : null}

                    {showProvided ? (
                      <CommandGroup
                        heading={isSearching ? (platformPaidFallback ? "MCPJam models" : "Free models") : undefined}
                      >
                        {visibleSections.provided.map((group) => (
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
                        {visibleSections.configured.map((group) => (
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

                  {/* Only under the user's own providers — while searching the
                      rows are a transient mix of both sections. */}
                  {onManageOrgProviders &&
                  !isSearching &&
                  (showConfigured || showConfiguredEmpty) ? (
                    <div className="border-t px-2 py-1.5">
                      <button
                        type="button"
                        onClick={handleManageOrgProviders}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        Manage organization models
                        <ArrowUpRight className="size-3 shrink-0" />
                      </button>
                    </div>
                  ) : null}
                </>
              );
            })()}
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
