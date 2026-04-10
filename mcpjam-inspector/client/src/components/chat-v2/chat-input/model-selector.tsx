import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ProviderLogo } from "./model/provider-logo";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ModelDefinition, isMCPJamProvidedModel } from "@/shared/types.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
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

const getProviderDisplayName = (groupKey: GroupKey): string => {
  if (groupKey.startsWith("custom:")) {
    return groupKey.slice("custom:".length);
  }

  switch (groupKey) {
    case "azure":
      return "Azure OpenAI";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "deepseek":
      return "DeepSeek";
    case "google":
      return "Google AI";
    case "mistral":
      return "Mistral AI";
    case "ollama":
      return "Ollama";
    case "meta":
      return "Meta";
    case "xai":
      return "xAI";
    case "moonshotai":
      return "Moonshot AI";
    case "z-ai":
      return "Zhipu AI";
    case "minimax":
      return "MiniMax";
    case "qwen":
      return "Qwen";
    default:
      return groupKey;
  }
};

const getLogoProvider = (groupKey: GroupKey): string =>
  groupKey.startsWith("custom:") ? "custom" : groupKey;

const getCustomName = (groupKey: GroupKey): string | undefined =>
  groupKey.startsWith("custom:") ? groupKey.slice("custom:".length) : undefined;

function sameModelOrder(
  left: ModelDefinition[],
  right: ModelDefinition[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (model, index) => String(model.id) === String(right[index]?.id),
  );
}

/** Strip redundant tier suffix for a denser list (search value still uses full name). */
function compactModelLabel(name: string): string {
  return name.replace(/\s*\(Free\)\s*$/i, "").trim() || name;
}

export function ModelSelector({
  currentModel,
  availableModels,
  onModelChange,
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
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const selectedModelsData =
    selectedModels && selectedModels.length > 0
      ? selectedModels
      : [currentModel];

  const groupedModels = useMemo(
    () => groupModelsByProvider(availableModels),
    [availableModels],
  );
  const sortedProviders = useMemo(
    () => Array.from(groupedModels.keys()).sort(),
    [groupedModels],
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
        ? allModels.filter((model) => !isMCPJamProvidedModel(String(model.id)))
        : allModels;

      if (filtered.length === 0) {
        continue;
      }

      const provided = filtered.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      );
      const configured = filtered.filter(
        (model) => !isMCPJamProvidedModel(String(model.id)),
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
    [selectedModelsData],
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
      (g) => g.providerType === "configured",
    );
    return { provided, configured };
  }, [modelGroups]);
  const selectedLimitReached =
    multiModelEnabled && selectedModelsData.length >= maxSelectedModels;

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
    const isSelected = selectedIds.has(String(model.id));
    const nextSelectedModels = isSelected
      ? selectedModelsData.filter(
          (selectedModel) => String(selectedModel.id) !== String(model.id),
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

    const nextSelectedModels = [
      model,
      ...selectedModelsData.filter(
        (selectedModel) => String(selectedModel.id) !== String(model.id),
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
          className="cursor-pointer rounded-sm px-2 py-1 data-[disabled=true]:cursor-not-allowed"
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
                  : "border-border/60 bg-transparent hover:border-border",
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
            <div className="rounded-sm transition-colors hover:bg-accent/60">
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
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || isLoading}
                className="h-8 max-w-[180px] rounded-full px-2 text-xs transition-colors hover:bg-muted/80 @max-2xl/toolbar:max-w-none @max-2xl/toolbar:w-8 @max-2xl/toolbar:px-0"
              >
                <ProviderLogo
                  provider={leadModel.provider}
                  customProviderName={leadModel.customProviderName}
                />
                <span className="truncate text-[10px] font-medium @max-2xl/toolbar:hidden">
                  {triggerLabel}
                </span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{triggerLabel}</TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-[280px] p-0" sideOffset={8}>
          <Command shouldFilter={true}>
            <CommandInput placeholder="Search models" />

            {canUseMultiModel ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
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
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs">
                    Compare up to {maxSelectedModels} models in one composer.
                    The first in your selection runs first.
                  </TooltipContent>
                </Tooltip>

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

            <CommandList className="max-h-[min(320px,45vh)]">
              <CommandEmpty>No matching models.</CommandEmpty>

              {modelSections.provided.length > 0 ? (
                <CommandGroup heading="Free models">
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

              {modelSections.provided.length > 0 &&
              modelSections.configured.length > 0 ? (
                <CommandSeparator />
              ) : null}

              {modelSections.configured.length > 0 ? (
                <CommandGroup heading="Your providers">
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
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
