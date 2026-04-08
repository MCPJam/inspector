import { useMemo, useState } from "react";
import { Check, Crown, X } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { ConfirmChatResetDialog } from "./dialogs/confirm-chat-reset-dialog";
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
import {
  ModelDefinition,
  isMCPJamProvidedModel,
} from "@/shared/types.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  disabled?: boolean;
  isLoading?: boolean;
  hideProvidedModels?: boolean;
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
    default:
      return groupKey;
  }
};

const getLogoProvider = (groupKey: GroupKey): string =>
  groupKey.startsWith("custom:") ? "custom" : groupKey;

const getCustomName = (groupKey: GroupKey): string | undefined =>
  groupKey.startsWith("custom:")
    ? groupKey.slice("custom:".length)
    : undefined;

function sameModelOrder(left: ModelDefinition[], right: ModelDefinition[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((model, index) => String(model.id) === String(right[index]?.id));
}

export function ModelSelector({
  currentModel,
  availableModels,
  onModelChange,
  disabled,
  isLoading,
  hideProvidedModels = false,
  hasMessages = false,
  enableMultiModel = false,
  multiModelEnabled = false,
  selectedModels,
  onSelectedModelsChange,
  onMultiModelEnabledChange,
  maxSelectedModels = 3,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pendingChange, setPendingChange] =
    useState<PendingSelectionChange | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const { isAuthenticated } = useConvexAuth();

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

  const modelGroups = useMemo(
    () =>
      sortedProviders
        .map((provider) => {
          const models = (groupedModels.get(provider) || []).filter((model) =>
            hideProvidedModels ? !isMCPJamProvidedModel(String(model.id)) : true,
          );

          if (models.length === 0) {
            return null;
          }

          return {
            provider,
            title: getProviderDisplayName(provider),
            providerType: models.some((model) =>
              isMCPJamProvidedModel(String(model.id)),
            )
              ? "provided"
              : "configured",
            models,
          };
        })
        .filter((group): group is NonNullable<typeof group> => group !== null),
    [groupedModels, hideProvidedModels, sortedProviders],
  );

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
      ? `${leadModel.name} +${selectedModelsData.length - 1}`
      : leadModel.name;
  const selectedModelSummaryText =
    selectedModelsData.length === 1
      ? "1 model selected"
      : `${selectedModelsData.length} models selected`;
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

    if (isSingleNoOp || isMultiNoOp) {
      setIsOpen(false);
      return;
    }

    if (hasMessages) {
      setPendingChange(nextChange);
      setShowConfirmDialog(true);
      setIsOpen(false);
      return;
    }

    if (nextChange.type === "single") {
      onModelChange(nextChange.nextModel);
    } else {
      onSelectedModelsChange?.(nextChange.selectedModels);
      onMultiModelEnabledChange?.(nextChange.enabled);
    }

    setIsOpen(false);
  };

  const handleConfirmSelectionChange = () => {
    if (!pendingChange) {
      return;
    }

    if (pendingChange.type === "single") {
      onModelChange(pendingChange.nextModel);
    } else {
      onSelectedModelsChange?.(pendingChange.selectedModels);
      onMultiModelEnabledChange?.(pendingChange.enabled);
    }

    setPendingChange(null);
    setShowConfirmDialog(false);
  };

  const handleCancelSelectionChange = () => {
    setPendingChange(null);
    setShowConfirmDialog(false);
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

        <PopoverContent align="start" className="w-[340px] p-0" sideOffset={8}>
          <Command shouldFilter={true}>
            <CommandInput placeholder="Search models" />

            {canUseMultiModel ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b px-3 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Use Multiple Models</p>
                    <p className="text-xs text-muted-foreground">
                      Broadcast the shared composer to up to {maxSelectedModels} models.
                    </p>
                  </div>
                  <Switch
                    checked={multiModelEnabled}
                    onCheckedChange={handleToggleMultiModel}
                    aria-label="Use multiple models"
                    disabled={disabled || isLoading}
                  />
                </div>

                {multiModelEnabled ? (
                  <div className="space-y-2 border-b px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        {selectedModelSummaryText}
                      </p>
                      <Badge variant="secondary" className="text-[10px]">
                        Lead model runs first in the list
                      </Badge>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {selectedModelsData.map((model, index) => {
                        const isLead = index === 0;
                        return (
                          <button
                            key={String(model.id)}
                            type="button"
                            className={cn(
                              "group inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors",
                              isLead
                                ? "border-primary/30 bg-primary/5 text-foreground"
                                : "border-border/60 bg-background text-muted-foreground hover:border-primary/20 hover:text-foreground",
                            )}
                            onClick={() => handlePromoteLeadModel(model)}
                            title={
                              isLead
                                ? `${model.name} is the lead model`
                                : `Promote ${model.name} to lead model`
                            }
                          >
                            <ProviderLogo
                              provider={model.provider}
                              customProviderName={model.customProviderName}
                            />
                            <span className="truncate">{model.name}</span>
                            {isLead ? (
                              <Badge
                                variant="secondary"
                                className="h-5 rounded-full px-1.5 text-[10px]"
                              >
                                <Crown className="mr-1 h-2.5 w-2.5" />
                                Lead
                              </Badge>
                            ) : null}
                            {selectedModelsData.length > 1 ? (
                              <span
                                role="button"
                                tabIndex={-1}
                                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleMultiModelSelect(model);
                                }}
                              >
                                <X className="h-3 w-3" />
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>

                    {selectedLimitReached ? (
                      <p className="text-[11px] text-muted-foreground">
                        Remove a model before adding another one.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            <CommandList className="max-h-[360px]">
              <CommandEmpty>No matching models.</CommandEmpty>

              {modelGroups.map((group, groupIndex) => {
                const heading =
                  group.providerType === "provided"
                    ? "MCPJam Free Models"
                    : "Your providers";

                return (
                  <div key={group.provider}>
                    {(groupIndex > 0 || (canUseMultiModel && multiModelEnabled)) && (
                      <CommandSeparator />
                    )}
                    <CommandGroup heading={heading}>
                      <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
                        {group.title}
                      </div>
                      <ScrollArea className="max-h-[220px]">
                        <div className="space-y-1 p-1">
                          {group.models.map((model) => {
                            const isMcpJamProvided = isMCPJamProvidedModel(
                              String(model.id),
                            );
                            const isDisabled =
                              !!model.disabled ||
                              (isMcpJamProvided && !isAuthenticated) ||
                              (multiModelEnabled &&
                                !selectedIds.has(String(model.id)) &&
                                selectedLimitReached);
                            const disabledReason =
                              isMcpJamProvided && !isAuthenticated
                                ? "Sign in to use MCPJam provided models"
                                : !selectedIds.has(String(model.id)) &&
                                    selectedLimitReached
                                  ? `You can compare up to ${maxSelectedModels} models at once`
                                  : model.disabledReason;
                            const isSelected = selectedIds.has(String(model.id));

                            const item = (
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
                                className="cursor-pointer rounded-md px-2 py-2 data-[disabled=true]:cursor-not-allowed"
                              >
                                <ProviderLogo
                                  provider={getLogoProvider(group.provider)}
                                  customProviderName={getCustomName(group.provider)}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium">
                                    {model.name}
                                  </div>
                                  <div className="truncate text-[11px] text-muted-foreground">
                                    {group.title}
                                  </div>
                                </div>
                                {multiModelEnabled ? (
                                  <div className="flex items-center gap-1">
                                    {isSelected && String(model.id) === String(leadModel.id) ? (
                                      <Badge
                                        variant="secondary"
                                        className="rounded-full px-1.5 text-[10px]"
                                      >
                                        Lead
                                      </Badge>
                                    ) : null}
                                    <div
                                      className={cn(
                                        "flex h-5 w-5 items-center justify-center rounded-full border",
                                        isSelected
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "border-border/60 bg-background text-transparent",
                                      )}
                                    >
                                      <Check className="h-3 w-3" />
                                    </div>
                                  </div>
                                ) : String(model.id) === String(currentModel.id) ? (
                                  <div className="ml-auto h-2.5 w-2.5 rounded-full bg-primary" />
                                ) : null}
                              </CommandItem>
                            );

                            return disabledReason ? (
                              <Tooltip key={String(model.id)}>
                                <TooltipTrigger asChild>
                                  <div>{item}</div>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {disabledReason}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              item
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </CommandGroup>
                  </div>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <ConfirmChatResetDialog
        open={showConfirmDialog}
        onConfirm={handleConfirmSelectionChange}
        onCancel={handleCancelSelectionChange}
        message="Changing the selected model set will clear the current chat session. This action cannot be undone."
      />
    </>
  );
}
