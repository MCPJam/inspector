import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Plus, Check, X } from "lucide-react";
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

interface TestTemplate {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: string[];
  judgeRequirement?: string;
  advancedConfig?: Record<string, unknown>;
}

interface ModelInfo {
  model: string;
  provider: string;
  displayName: string;
}

interface SuiteTestsConfigProps {
  suite: EvalSuite;
  onUpdate: (tests: EvalSuiteConfigTest[]) => void;
  availableModels: ModelDefinition[];
}

export function SuiteTestsConfig({ suite, onUpdate, availableModels }: SuiteTestsConfigProps) {
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);

  // Extract templates and models from expanded tests
  const { templates: initialTemplates, models: initialModels } = useMemo(() => {
    const tests = suite.config?.tests || [];
    if (tests.length === 0) {
      return { templates: [], models: [] };
    }

    // Extract unique models
    const modelSet = new Map<string, ModelInfo>();
    tests.forEach(test => {
      if (!modelSet.has(test.model)) {
        modelSet.set(test.model, {
          model: test.model,
          provider: test.provider,
          displayName: test.model,
        });
      }
    });

    // Extract templates by de-duplicating (remove model suffix from title)
    const templateMap = new Map<string, TestTemplate>();
    tests.forEach(test => {
      // Remove model suffix like " [ModelName]" from title
      const templateTitle = test.title.replace(/\s*\[.*?\]\s*$/, '').trim();
      const key = `${templateTitle}-${test.query}`;

      if (!templateMap.has(key)) {
        templateMap.set(key, {
          title: templateTitle,
          query: test.query,
          runs: test.runs,
          expectedToolCalls: test.expectedToolCalls || [],
          judgeRequirement: test.judgeRequirement,
          advancedConfig: test.advancedConfig,
        });
      }
    });

    return {
      templates: Array.from(templateMap.values()),
      models: Array.from(modelSet.values()),
    };
  }, [suite.config?.tests]);

  const [templates, setTemplates] = useState<TestTemplate[]>(initialTemplates);
  const [models, setModels] = useState<ModelInfo[]>(initialModels);
  const [editingTemplateIndex, setEditingTemplateIndex] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);

  // Re-expand matrix and save
  const saveChanges = (newTemplates: TestTemplate[], newModels: ModelInfo[]) => {
    const expandedTests: EvalSuiteConfigTest[] = newTemplates.flatMap(template =>
      newModels.map(modelInfo => ({
        title: template.title, // Use template title without model name
        query: template.query,
        runs: template.runs,
        model: modelInfo.model,
        provider: modelInfo.provider,
        expectedToolCalls: template.expectedToolCalls,
        judgeRequirement: template.judgeRequirement,
        advancedConfig: template.advancedConfig,
        testTemplateKey: template.templateKey, // Add template key for grouping
      }))
    );
    onUpdate(expandedTests);
  };

  const startEdit = (index: number) => {
    setEditingTemplateIndex(index);
    setEditForm({ ...templates[index] });
  };

  const cancelEdit = () => {
    setEditingTemplateIndex(null);
    setEditForm(null);
  };

  const saveEdit = () => {
    if (editingTemplateIndex === null || !editForm) return;

    const updated = [...templates];
    updated[editingTemplateIndex] = editForm;
    setTemplates(updated);
    saveChanges(updated, models);
    cancelEdit();
  };

  const deleteTemplate = (index: number) => {
    const updated = templates.filter((_, i) => i !== index);
    setTemplates(updated);
    saveChanges(updated, models);
  };

  const addTemplate = () => {
    const newTemplate: TestTemplate = {
      title: "New test",
      query: "",
      runs: 1,
      expectedToolCalls: [],
    };
    const updated = [...templates, newTemplate];
    setTemplates(updated);
    startEdit(updated.length - 1);
  };

  const deleteModel = (modelToDelete: string) => {
    const updated = models.filter(m => m.model !== modelToDelete);
    setModels(updated);
    saveChanges(templates, updated);
  };

  const handleAddModel = (selectedModel: ModelDefinition) => {
    // Check if model already exists
    if (models.some(m => m.model === selectedModel.id)) {
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
    saveChanges(templates, updated);
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
    <div className="space-y-6">
      {/* Models Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Models</h3>
            <p className="text-sm text-muted-foreground">
              Models used in this suite. Each test runs against all models.
            </p>
          </div>
          <DropdownMenu open={isModelDropdownOpen} onOpenChange={setIsModelDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="h-4 w-4 mr-2" />
                Add model
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-[300px]">
              {mcpjamProviders.length > 0 && (
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  MCPJam Free Models
                </div>
              )}
              {mcpjamProviders.map(([provider, providerModels]) => {
                const mcpjamModels = providerModels.filter((m) =>
                  isMCPJamProvidedModel(m.id)
                );
                return (
                  <DropdownMenuSub key={provider}>
                    <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                      <ProviderLogo provider={provider} />
                      <div className="flex flex-col flex-1">
                        <span className="font-medium capitalize">{provider}</span>
                        <span className="text-xs text-muted-foreground">
                          {mcpjamModels.length} model{mcpjamModels.length !== 1 ? "s" : ""}
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
                  (m) => !isMCPJamProvidedModel(m.id)
                );
                return (
                  <DropdownMenuSub key={provider}>
                    <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                      <ProviderLogo provider={provider} />
                      <div className="flex flex-col flex-1">
                        <span className="font-medium capitalize">{provider}</span>
                        <span className="text-xs text-muted-foreground">
                          {userModels.length} model{userModels.length !== 1 ? "s" : ""}
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
            <p className="text-sm text-muted-foreground">No models configured</p>
            <DropdownMenu open={isModelDropdownOpen} onOpenChange={setIsModelDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <Button className="mt-4" variant="outline">
                  <Plus className="h-4 w-4 mr-2" />
                  Add your first model
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" side="bottom" sideOffset={4} className="w-[300px]">
                {mcpjamProviders.length > 0 && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    MCPJam Free Models
                  </div>
                )}
                {mcpjamProviders.map(([provider, providerModels]) => {
                  const mcpjamModels = providerModels.filter((m) =>
                    isMCPJamProvidedModel(m.id)
                  );
                  return (
                    <DropdownMenuSub key={provider}>
                      <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                        <ProviderLogo provider={provider} />
                        <div className="flex flex-col flex-1">
                          <span className="font-medium capitalize">{provider}</span>
                          <span className="text-xs text-muted-foreground">
                            {mcpjamModels.length} model{mcpjamModels.length !== 1 ? "s" : ""}
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
                    (m) => !isMCPJamProvidedModel(m.id)
                  );
                  return (
                    <DropdownMenuSub key={provider}>
                      <DropdownMenuSubTrigger className="flex items-center gap-3 text-sm cursor-pointer">
                        <ProviderLogo provider={provider} />
                        <div className="flex flex-col flex-1">
                          <span className="font-medium capitalize">{provider}</span>
                          <span className="text-xs text-muted-foreground">
                            {userModels.length} model{userModels.length !== 1 ? "s" : ""}
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
              <Badge key={modelInfo.model} variant="secondary" className="px-3 py-1.5">
                <span className="mr-2">{modelInfo.displayName}</span>
                <button
                  onClick={() => deleteModel(modelInfo.model)}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={models.length === 1}
                  title={models.length === 1 ? "Cannot remove last model" : "Remove model"}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Test Templates Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Test Templates</h3>
            <p className="text-sm text-muted-foreground">
              Each template runs against all {models.length} model{models.length === 1 ? '' : 's'} ({models.length * templates.length} total tests)
            </p>
          </div>
          <Button onClick={addTemplate} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Add template
          </Button>
        </div>

        {templates.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No test templates configured</p>
            <Button onClick={addTemplate} className="mt-4" variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              Add your first template
            </Button>
          </Card>
        ) : (
          <div className="space-y-3">
            {templates.map((template, index) => (
              <Card key={index} className="p-4">
                {editingTemplateIndex === index && editForm ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Title</Label>
                      <Input
                        value={editForm.title}
                        onChange={(e) =>
                          setEditForm({ ...editForm, title: e.target.value })
                        }
                        placeholder="e.g., Add two numbers"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Query</Label>
                      <Textarea
                        value={editForm.query}
                        onChange={(e) =>
                          setEditForm({ ...editForm, query: e.target.value })
                        }
                        rows={3}
                        placeholder="e.g., Add 5 and 7 together"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Runs per test</Label>
                      <Input
                        type="number"
                        min={1}
                        value={editForm.runs}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            runs: parseInt(e.target.value) || 1,
                          })
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Expected tool calls (comma-separated)</Label>
                      <Input
                        value={(editForm.expectedToolCalls || []).join(", ")}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            expectedToolCalls: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="e.g., add, calculator"
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button onClick={saveEdit} size="sm">
                        <Check className="h-4 w-4 mr-2" />
                        Save
                      </Button>
                      <Button onClick={cancelEdit} size="sm" variant="outline">
                        <X className="h-4 w-4 mr-2" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h4 className="font-semibold">{template.title}</h4>
                        <p className="text-sm text-muted-foreground mt-1">
                          {template.query}
                        </p>
                        <div className="flex flex-wrap gap-2 mt-3">
                          <Badge variant="outline">{template.runs} runs</Badge>
                          {(template.expectedToolCalls || []).length > 0 && (
                            <Badge variant="outline">
                              Expects: {(template.expectedToolCalls || []).join(", ")}
                            </Badge>
                          )}
                          <Badge variant="secondary">
                            {models.length} model{models.length === 1 ? '' : 's'}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => startEdit(index)}
                          size="sm"
                          variant="ghost"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          onClick={() => deleteTemplate(index)}
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
