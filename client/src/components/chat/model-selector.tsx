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
import { ModelDefinition, ModelProvider } from "@/shared/types.js";
import { ProviderLogo } from "./provider-logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useConvexAuth } from "convex/react";

interface ModelSelectorProps {
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  disabled?: boolean;
  isLoading?: boolean;
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
    case "ollama":
      return "Ollama";
    case "meta":
      return "Meta";
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
}: ModelSelectorProps) {
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const currentModelData = currentModel;
  const { isAuthenticated } = useConvexAuth();

  // Group models by provider
  const groupedModels = groupModelsByProvider(availableModels);

  // Get sorted provider keys for consistent ordering
  const sortedProviders = Array.from(groupedModels.keys()).sort();
  const MCPJAM_PROVIDERS: ModelProvider[] = ["meta"];
  const mcpjamProviders = sortedProviders.filter((p) =>
    MCPJAM_PROVIDERS.includes(p),
  );
  const otherProviders = sortedProviders.filter(
    (p) => !MCPJAM_PROVIDERS.includes(p),
  );

  return (
    <DropdownMenu
      open={isModelSelectorOpen}
      onOpenChange={setIsModelSelectorOpen}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading}
          className="h-8 px-2 rounded-full hover:bg-muted/80 transition-colors text-xs cursor-pointer"
        >
          <>
            <ProviderLogo provider={currentModelData.provider} />
            <span className="text-[10px] font-medium">
              {currentModelData.name}
            </span>
          </>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {/* MCPJam-provided models */}
        {mcpjamProviders.length > 0 && (
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            MCPJam Provided Models
          </div>
        )}
        {mcpjamProviders.map((provider) => {
          const models = groupedModels.get(provider) || [];
          const modelCount = models.length;

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
                {models.map((model) => {
                  const isMeta = model.provider === "meta";
                  const isDisabled =
                    !!model.disabled || (isMeta && !isAuthenticated);
                  const computedReason =
                    isMeta && !isAuthenticated
                      ? "Sign in to use MCPJam provided models"
                      : model.disabledReason;

                  const item = (
                    <DropdownMenuItem
                      key={model.id}
                      onSelect={() => {
                        onModelChange(model);
                        setIsModelSelectorOpen(false);
                      }}
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
        {/* User-configured providers */}
        {otherProviders.length > 0 && (
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Your providers
          </div>
        )}
        {otherProviders.map((provider) => {
          const models = groupedModels.get(provider) || [];
          const modelCount = models.length;

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
                {models.map((model) => {
                  const isDisabled = !!model.disabled;

                  const item = (
                    <DropdownMenuItem
                      key={model.id}
                      onSelect={() => {
                        onModelChange(model);
                        setIsModelSelectorOpen(false);
                      }}
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
  );
}
