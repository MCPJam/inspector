import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  ModelDefinition,
  ModelProvider,
  isMCPJamProvidedModel,
} from "@/shared/types.js";
import { ProviderLogo } from "./provider-logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useConvexAuth } from "convex/react";
import { ConfirmChatResetDialog } from "./confirm-chat-reset-dialog";

interface ModelSelectorProps {
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  disabled?: boolean;
  isLoading?: boolean;
  hideProvidedModels?: boolean;
  hasMessages?: boolean;
  /** When true, shows icon only for compact layout */
  compact?: boolean;
}

// Helper function to group models by provider
const groupModelsByProvider = (
  models: ModelDefinition[],
): Map<ModelProvider, ModelDefinition[]> => {
  const groupedModels = new Map<ModelProvider, ModelDefinition[]>();

  models.forEach((model) => {
    const existing = groupedModels.get(model.provider) || [];
    groupedModels.set(model.provider, [...existing, model]);
  });

  return groupedModels;
};

// Provider display names
const getProviderDisplayName = (provider: ModelProvider): string => {
  switch (provider) {
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
    case "litellm":
      return "LiteLLM";
    case "moonshotai":
      return "Moonshot AI";
    case "z-ai":
      return "Zhipu AI";
    default:
      return provider;
  }
};

export function ModelSelector({
  currentModel,
  availableModels,
  onModelChange,
  disabled,
  isLoading,
  hideProvidedModels = false,
  hasMessages = false,
  compact = false,
}: ModelSelectorProps) {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<ModelDefinition | null>(
    null,
  );
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const currentModelData = currentModel;
  const { isAuthenticated } = useConvexAuth();
  const groupedModels = groupModelsByProvider(availableModels);
  const sortedProviders = Array.from(groupedModels.keys()).sort();

  const mcpjamProviders = hideProvidedModels
    ? []
    : sortedProviders.filter((p) => {
        const models = groupedModels.get(p) || [];
        return models.some((m) => isMCPJamProvidedModel(m.id));
      });

  const otherProviders = sortedProviders.filter((p) => {
    const models = groupedModels.get(p) || [];
    return models.some((m) => !isMCPJamProvidedModel(m.id));
  });

  const handleModelSelect = (model: ModelDefinition) => {
    // If there are no messages or the model is the same, change immediately
    if (!hasMessages || model.id === currentModel.id) {
      onModelChange(model);
      setIsModelSelectorOpen(false);
      return;
    }

    // Show confirmation dialog
    setPendingModel(model);
    setShowConfirmDialog(true);
    setIsModelSelectorOpen(false);
  };

  const handleConfirmModelChange = () => {
    if (pendingModel) {
      onModelChange(pendingModel);
      setPendingModel(null);
    }
    setShowConfirmDialog(false);
  };

  const handleCancelModelChange = () => {
    setPendingModel(null);
    setShowConfirmDialog(false);
  };

  return (
    <>
      <DropdownMenu
        open={isModelSelectorOpen}
        onOpenChange={setIsModelSelectorOpen}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size={compact ? "icon" : "sm"}
                disabled={disabled || isLoading}
                className={
                  compact
                    ? "h-8 w-8 rounded-full hover:bg-muted/80 transition-colors cursor-pointer"
                    : "h-8 px-2 rounded-full hover:bg-muted/80 transition-colors text-xs cursor-pointer max-w-[160px]"
                }
              >
                <ProviderLogo provider={currentModelData.provider} />
                {!compact && (
                  <span className="text-[10px] font-medium truncate">
                    {currentModelData.name}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {compact && (
            <TooltipContent side="top">{currentModelData.name}</TooltipContent>
          )}
        </Tooltip>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          {mcpjamProviders.length > 0 && (
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              MCPJam Free Models
            </div>
          )}
          {mcpjamProviders.map((provider) => {
            const models = groupedModels.get(provider) || [];
            const mcpjamModels = models.filter((model) =>
              isMCPJamProvidedModel(model.id),
            );
            const modelCount = mcpjamModels.length;

            return (
              <DropdownMenuSub key={provider}>
                <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                  <ProviderLogo provider={provider} />
                  <div className="flex flex-col flex-1">
                    <span className="font-medium">
                      {getProviderDisplayName(provider)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {modelCount} model{modelCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                </DropdownMenuSubTrigger>

                <DropdownMenuSubContent
                  className="min-w-[200px] max-h-[180px] overflow-y-auto"
                  avoidCollisions={true}
                  collisionPadding={8}
                >
                  {mcpjamModels.map((model) => {
                    const isMCPJamProvided = isMCPJamProvidedModel(model.id);
                    const isDisabled =
                      !!model.disabled ||
                      (isMCPJamProvided && !isAuthenticated);
                    const computedReason =
                      isMCPJamProvided && !isAuthenticated
                        ? "Sign in to use MCPJam provided models"
                        : model.disabledReason;

                    const item = (
                      <DropdownMenuItem
                        key={model.id}
                        onSelect={() => handleModelSelect(model)}
                        className="flex items-center gap-3 text-sm cursor-pointer"
                        disabled={isDisabled}
                      >
                        <div className="flex flex-col flex-1">
                          <span className="font-medium">{model.name}</span>
                        </div>
                        {model.id === currentModel.id && (
                          <div className="ml-auto w-2 h-2 bg-primary rounded-full" />
                        )}
                      </DropdownMenuItem>
                    );

                    return isDisabled ? (
                      <Tooltip key={model.id}>
                        <TooltipTrigger asChild>
                          <div className="pointer-events-auto">{item}</div>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {computedReason}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      item
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
          {mcpjamProviders.length > 0 && otherProviders.length > 0 && (
            <div className="my-1 h-px bg-muted/50" />
          )}
          {otherProviders.length > 0 && (
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Your providers
            </div>
          )}
          {otherProviders.map((provider) => {
            const models = groupedModels.get(provider) || [];
            const userModels = models.filter(
              (model) => !isMCPJamProvidedModel(model.id),
            );
            const modelCount = userModels.length;

            return (
              <DropdownMenuSub key={provider}>
                <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                  <ProviderLogo provider={provider} />
                  <div className="flex flex-col flex-1">
                    <span className="font-medium">
                      {getProviderDisplayName(provider)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {modelCount} model{modelCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                </DropdownMenuSubTrigger>

                <DropdownMenuSubContent
                  className="min-w-[200px] max-h-[180px] overflow-y-auto"
                  avoidCollisions={true}
                  collisionPadding={8}
                >
                  {userModels.map((model) => {
                    const isDisabled = !!model.disabled;

                    const item = (
                      <DropdownMenuItem
                        key={model.id}
                        onSelect={() => handleModelSelect(model)}
                        className="flex items-center gap-3 text-sm cursor-pointer"
                        disabled={isDisabled}
                      >
                        <div className="flex flex-col flex-1">
                          <span className="font-medium">{model.name}</span>
                        </div>
                        {model.id === currentModel.id && (
                          <div className="ml-auto w-2 h-2 bg-primary rounded-full" />
                        )}
                      </DropdownMenuItem>
                    );

                    return isDisabled ? (
                      <Tooltip key={model.id}>
                        <TooltipTrigger asChild>
                          <div className="pointer-events-auto">{item}</div>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {model.disabledReason}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      item
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmChatResetDialog
        open={showConfirmDialog}
        onConfirm={handleConfirmModelChange}
        onCancel={handleCancelModelChange}
        message="Changing the model will cause the chat to reset. This action cannot be undone."
      />
    </>
  );
}
