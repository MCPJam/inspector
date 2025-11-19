import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { EvalSuite, EvalSuiteConfigTest } from "./types";
import type { ModelDefinition } from "@/shared/types";
import { isMCPJamProvidedModel } from "@/shared/types";
import { ProviderLogo } from "@/components/chat-v2/provider-logo";

export interface ModelInfo {
  model: string;
  provider: string;
  displayName: string;
}

interface SuiteTestsConfigProps {
  suite: EvalSuite;
  testCases: any[]; // Array of test cases from the new data model
  onUpdate: (models: ModelInfo[]) => Promise<void>;
  availableModels: ModelDefinition[];
}

export function SuiteTestsConfig({
  suite,
  testCases,
  onUpdate,
  availableModels,
}: SuiteTestsConfigProps) {
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);

  // Extract models from test cases
  const initialModels = useMemo(() => {
    if (!testCases || testCases.length === 0) {
      return [];
    }

    // Extract unique models from all test cases
    const modelSet = new Map<string, ModelInfo>();
    testCases.forEach((testCase) => {
      if (testCase.models && Array.isArray(testCase.models)) {
        testCase.models.forEach((modelConfig: any) => {
          const key = `${modelConfig.provider}:${modelConfig.model}`;
          if (!modelSet.has(key)) {
            modelSet.set(key, {
              model: modelConfig.model,
              provider: modelConfig.provider,
              displayName: modelConfig.model,
            });
          }
        });
      }
    });

    return Array.from(modelSet.values());
  }, [testCases]);

  const [models, setModels] = useState<ModelInfo[]>(initialModels);

  // Update models state when testCases change
  useEffect(() => {
    setModels(initialModels);
  }, [initialModels]);

  // Save changes - update all test cases with new models
  const saveChanges = async (newModels: ModelInfo[]) => {
    await onUpdate(newModels);
  };

  const deleteModel = async (modelToDelete: string) => {
    const updated = models.filter((m) => m.model !== modelToDelete);
    setModels(updated);
    await saveChanges(updated);
  };

  const handleAddModel = async (selectedModel: ModelDefinition) => {
    // Check if model already exists
    if (models.some((m) => m.model === selectedModel.id)) {
      setIsModelDropdownOpen(false);
      return;
    }

    const newModel: ModelInfo = {
      model: selectedModel.id,
      provider: selectedModel.provider,
      displayName: selectedModel.name,
    };

    const updated = [...models, newModel];
    setModels(updated);
    await saveChanges(updated);
    setIsModelDropdownOpen(false);
  };

  // Group available models by provider
  const groupedAvailableModels = useMemo(() => {
    const grouped = new Map<string, ModelDefinition[]>();
    availableModels.forEach((model) => {
      const provider = model.provider;
      if (!grouped.has(provider)) {
        grouped.set(provider, []);
      }
      grouped.get(provider)!.push(model);
    });
    return grouped;
  }, [availableModels]);

  const mcpjamProviders = useMemo(() => {
    return Array.from(groupedAvailableModels.entries())
      .filter(([_, models]) => models.some((m) => isMCPJamProvidedModel(m.id)))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [groupedAvailableModels]);

  const userProviders = useMemo(() => {
    return Array.from(groupedAvailableModels.entries())
      .filter(([_, models]) => models.some((m) => !isMCPJamProvidedModel(m.id)))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [groupedAvailableModels]);

  return (
    <div className="space-y-3">
      {/* Models Section */}
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">Models</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Select at least one model to run the evaluation.
            </p>
          </div>
          <DropdownMenu
            open={isModelDropdownOpen}
            onOpenChange={setIsModelDropdownOpen}
          >
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="shrink-0">
                <Plus className="h-4 w-4 mr-2" />
                Add model
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={4}
              className="w-[300px]"
            >
              {mcpjamProviders.length > 0 && (
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  MCPJam Free Models
                </div>
              )}
              {mcpjamProviders.map(([provider, providerModels]) => {
                const mcpjamModels = providerModels.filter((m) =>
                  isMCPJamProvidedModel(m.id),
                );
                return (
                  <DropdownMenuSub key={provider}>
                    <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                      <ProviderLogo provider={provider} />
                      <div className="flex flex-col flex-1">
                        <span className="font-medium capitalize">
                          {provider}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {mcpjamModels.length} model
                          {mcpjamModels.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className="min-w-[200px] max-h-[180px] overflow-y-auto"
                      avoidCollisions={true}
                      collisionPadding={8}
                    >
                      {mcpjamModels.map((model) => (
                        <DropdownMenuItem
                          key={model.id}
                          onSelect={() => handleAddModel(model)}
                          className="flex items-center gap-3 text-sm cursor-pointer"
                          disabled={models.some((m) => m.model === model.id)}
                        >
                          <div className="flex flex-col flex-1">
                            <span className="font-medium">{model.name}</span>
                          </div>
                          {models.some((m) => m.model === model.id) && (
                            <Badge variant="secondary" className="text-xs">
                              Added
                            </Badge>
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}

              {mcpjamProviders.length > 0 && userProviders.length > 0 && (
                <div className="my-1 h-px bg-muted/50" />
              )}

              {userProviders.length > 0 && (
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Your Providers
                </div>
              )}
              {userProviders.map(([provider, providerModels]) => {
                const userModels = providerModels.filter(
                  (m) => !isMCPJamProvidedModel(m.id),
                );
                return (
                  <DropdownMenuSub key={provider}>
                    <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                      <ProviderLogo provider={provider} />
                      <div className="flex flex-col flex-1">
                        <span className="font-medium capitalize">
                          {provider}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {userModels.length} model
                          {userModels.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className="min-w-[200px] max-h-[180px] overflow-y-auto"
                      avoidCollisions={true}
                      collisionPadding={8}
                    >
                      {userModels.map((model) => (
                        <DropdownMenuItem
                          key={model.id}
                          onSelect={() => handleAddModel(model)}
                          className="flex items-center gap-3 text-sm cursor-pointer"
                          disabled={models.some((m) => m.model === model.id)}
                        >
                          <div className="flex flex-col flex-1">
                            <span className="font-medium">{model.name}</span>
                          </div>
                          {models.some((m) => m.model === model.id) && (
                            <Badge variant="secondary" className="text-xs">
                              Added
                            </Badge>
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {models.length === 0 ? (
          <Card className="p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No models configured
            </p>
            <DropdownMenu
              open={isModelDropdownOpen}
              onOpenChange={setIsModelDropdownOpen}
            >
              <DropdownMenuTrigger asChild>
                <Button className="mt-4" variant="outline">
                  <Plus className="h-4 w-4 mr-2" />
                  Add your first model
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="center"
                side="bottom"
                sideOffset={4}
                className="w-[300px]"
              >
                {mcpjamProviders.length > 0 && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    MCPJam Free Models
                  </div>
                )}
                {mcpjamProviders.map(([provider, providerModels]) => {
                  const mcpjamModels = providerModels.filter((m) =>
                    isMCPJamProvidedModel(m.id),
                  );
                  return (
                    <DropdownMenuSub key={provider}>
                      <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                        <ProviderLogo provider={provider} />
                        <div className="flex flex-col flex-1">
                          <span className="font-medium capitalize">
                            {provider}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {mcpjamModels.length} model
                            {mcpjamModels.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className="min-w-[200px] max-h-[180px] overflow-y-auto"
                        avoidCollisions={true}
                        collisionPadding={8}
                      >
                        {mcpjamModels.map((model) => (
                          <DropdownMenuItem
                            key={model.id}
                            onSelect={() => handleAddModel(model)}
                            className="flex items-center gap-3 text-sm cursor-pointer"
                            disabled={models.some((m) => m.model === model.id)}
                          >
                            <div className="flex flex-col flex-1">
                              <span className="font-medium">{model.name}</span>
                            </div>
                            {models.some((m) => m.model === model.id) && (
                              <Badge variant="secondary" className="text-xs">
                                Added
                              </Badge>
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                })}

                {mcpjamProviders.length > 0 && userProviders.length > 0 && (
                  <div className="my-1 h-px bg-muted/50" />
                )}

                {userProviders.length > 0 && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Your Providers
                  </div>
                )}
                {userProviders.map(([provider, providerModels]) => {
                  const userModels = providerModels.filter(
                    (m) => !isMCPJamProvidedModel(m.id),
                  );
                  return (
                    <DropdownMenuSub key={provider}>
                      <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                        <ProviderLogo provider={provider} />
                        <div className="flex flex-col flex-1">
                          <span className="font-medium capitalize">
                            {provider}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {userModels.length} model
                            {userModels.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className="min-w-[200px] max-h-[180px] overflow-y-auto"
                        avoidCollisions={true}
                        collisionPadding={8}
                      >
                        {userModels.map((model) => (
                          <DropdownMenuItem
                            key={model.id}
                            onSelect={() => handleAddModel(model)}
                            className="flex items-center gap-3 text-sm cursor-pointer"
                            disabled={models.some((m) => m.model === model.id)}
                          >
                            <div className="flex flex-col flex-1">
                              <span className="font-medium">{model.name}</span>
                            </div>
                            {models.some((m) => m.model === model.id) && (
                              <Badge variant="secondary" className="text-xs">
                                Added
                              </Badge>
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </Card>
        ) : (
          <div className="flex flex-wrap gap-2">
            {models.map((modelInfo) => (
              <Badge
                key={modelInfo.model}
                variant="secondary"
                className="px-3 py-1.5"
              >
                <span className="mr-2">{modelInfo.displayName}</span>
                <button
                  onClick={() => deleteModel(modelInfo.model)}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={models.length === 1}
                  title={
                    models.length === 1
                      ? "Cannot remove last model"
                      : "Remove model"
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
