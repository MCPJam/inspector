import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Sparkles, X, Check } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useAppState } from "@/hooks/use-app-state";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { cn } from "@/lib/utils";
import { ModelDefinition, isMCPJamProvidedModel } from "@/shared/types";
import { ServerSelectionCard } from "./ServerSelectionCard";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import posthog from "posthog-js";

interface TestTemplate {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
}

interface EvalRunnerProps {
  availableModels: ModelDefinition[];
  inline?: boolean;
  onSuccess?: () => void;
}

const PREFERENCE_STORAGE_KEY = "mcp-inspector-eval-runner-preferences";

const steps = [
  {
    key: "servers",
    title: "Select Servers",
    description: "Choose the MCP servers to evaluate.",
  },
  {
    key: "model",
    title: "Choose Model",
    description: "Pick the model and ensure credentials are ready.",
  },
  {
    key: "tests",
    title: "Define Tests",
    description:
      "Author the scenarios you want to run or generate them with AI.",
  },
  {
    key: "review",
    title: "Review & Run",
    description: "Confirm the configuration before launching the run.",
  },
] as const;

type StepKey = (typeof steps)[number]["key"];

const buildBlankTestTemplate = (): TestTemplate => ({
  title: ``,
  query: "",
  runs: 1,
  expectedToolCalls: [],
});

export function EvalRunner({
  availableModels,
  inline = false,
  onSuccess,
}: EvalRunnerProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [savedPreferences, setSavedPreferences] = useState<{
    servers: string[];
    modelIds: string[];
  } | null>(null);
  const { isAuthenticated } = useConvexAuth();
  const { getAccessToken } = useAuth();
  const { appState } = useAppState();
  const { getToken, hasToken } = useAiProviderKeys();

  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<ModelDefinition[]>([]);
  const [testTemplates, setTestTemplates] = useState<TestTemplate[]>([
    buildBlankTestTemplate(),
  ]);
  const [modelTab, setModelTab] = useState<"mcpjam" | "yours">("mcpjam");
  const [suiteName, setSuiteName] = useState("");
  const [suiteDescription, setSuiteDescription] = useState("");
  const [isEditingSuiteName, setIsEditingSuiteName] = useState(false);
  const [editedSuiteName, setEditedSuiteName] = useState("");
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false);

  const connectedServers = useMemo(
    () =>
      Object.entries(appState.servers).filter(
        ([, server]) => server.connectionStatus === "connected",
      ),
    [appState.servers],
  );

  const connectedServerNames = useMemo(
    () => new Set(connectedServers.map(([name]) => name)),
    [connectedServers],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = localStorage.getItem(PREFERENCE_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        servers?: string[];
        modelIds?: string[];
      };
      setSavedPreferences({
        servers: parsed.servers ?? [],
        modelIds: parsed.modelIds ?? [],
      });
    } catch (error) {
      console.warn("Failed to load eval runner preferences", error);
    }
  }, []);

  useEffect(() => {
    if (!savedPreferences) return;

    if (savedPreferences.servers?.length) {
      const filtered = savedPreferences.servers.filter((server) =>
        connectedServerNames.has(server),
      );
      if (filtered.length) {
        setSelectedServers(filtered);
      }
    }
  }, [savedPreferences, connectedServerNames]);

  useEffect(() => {
    // Only restore preferences once on initial load
    if (hasRestoredPreferences) return;

    if (availableModels.length === 0) {
      return;
    }

    if (savedPreferences?.modelIds && savedPreferences.modelIds.length > 0) {
      const matches = availableModels.filter((model) =>
        savedPreferences.modelIds.includes(model.id),
      );
      if (matches.length > 0) {
        setSelectedModels(matches);
      }
    }

    setHasRestoredPreferences(true);
  }, [availableModels, savedPreferences, hasRestoredPreferences]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload = {
        servers: selectedServers,
        modelIds: selectedModels.map((m) => m.id),
      };
      localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn("Failed to persist eval runner preferences", error);
    }
  }, [selectedServers, selectedModels]);

  useEffect(() => {
    if (!inline && !open) {
      setCurrentStep(0);
      setHasRestoredPreferences(false);
    }
  }, [inline, open]);

  const validTestTemplates = useMemo(
    () => testTemplates.filter((template) => template.query.trim().length > 0),
    [testTemplates],
  );

  const stepCompletion = useMemo(() => {
    // Check that all selected models have credentials
    const allModelsHaveCredentials = selectedModels.every((model) => {
      const isJam = isMCPJamProvidedModel(model.id);
      return isJam || hasToken(model.provider as keyof ProviderTokens);
    });

    return {
      servers: selectedServers.length > 0,
      model: selectedModels.length > 0 && allModelsHaveCredentials,
      tests: validTestTemplates.length > 0,
    };
  }, [selectedServers, selectedModels, validTestTemplates, hasToken]);

  const highestAvailableStep = useMemo(() => {
    if (!stepCompletion.servers) return 0;
    if (!stepCompletion.model) return 1;
    if (!stepCompletion.tests) return 2;
    return 3;
  }, [stepCompletion]);

  const canAdvance = useMemo(() => {
    switch (currentStep) {
      case 0:
        return stepCompletion.servers;
      case 1:
        return stepCompletion.model;
      case 2:
        return stepCompletion.tests;
      case 3:
        return (
          stepCompletion.tests && stepCompletion.servers && stepCompletion.model
        );
      default:
        return false;
    }
  }, [currentStep, stepCompletion]);

  const toggleServer = (name: string) => {
    setSelectedServers((prev) => {
      if (prev.includes(name)) {
        return prev.filter((server) => server !== name);
      }
      return [...prev, name];
    });
  };

  const handleAddTestTemplate = () => {
    setTestTemplates((prev) => [...prev, buildBlankTestTemplate()]);
  };

  const handleRemoveTestTemplate = (index: number) => {
    setTestTemplates((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateTestTemplate = (
    index: number,
    field: keyof TestTemplate,
    value: string | number | string[],
  ) => {
    setTestTemplates((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [field]: value,
      };
      return next;
    });
  };

  const handleGenerateTests = async () => {
    posthog.capture("eval_generate_tests_button_clicked", {
      location: "eval_runner",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      step: currentStep,
    });

    if (!isAuthenticated) {
      toast.error("Please sign in to generate tests");
      return;
    }

    if (selectedServers.length === 0) {
      toast.error("Please select at least one server");
      return;
    }

    setIsGenerating(true);

    try {
      const accessToken = await getAccessToken();

      const response = await fetch("/api/mcp/evals/generate-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverIds: selectedServers,
          convexAuthToken: accessToken,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to generate tests");
      }

      if (result.tests && result.tests.length > 0) {
        const generatedTemplates = result.tests.map((test: any, index: number) => ({
          title: test.title || `Generated test ${index + 1}`,
          query: test.query || "",
          runs: Number(test.runs) > 0 ? Number(test.runs) : 1,
          expectedToolCalls: Array.isArray(test.expectedToolCalls)
            ? test.expectedToolCalls
            : [],
        }));

        setTestTemplates(generatedTemplates);
        setCurrentStep(2);
        toast.success(`Generated ${generatedTemplates.length} test template(s).`);
      }
    } catch (error) {
      console.error("Failed to generate tests:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to generate test cases",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleNext = () => {
    if (currentStep >= steps.length - 1) return;
    if (!canAdvance) return;
    setIsEditingSuiteName(false);
    setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1));
  };

  const handleBack = () => {
    if (currentStep === 0) return;
    setIsEditingSuiteName(false);
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  const handleSuiteNameClick = () => {
    setIsEditingSuiteName(true);
    setEditedSuiteName(suiteName);
  };

  const handleSuiteNameBlur = () => {
    setIsEditingSuiteName(false);
    if (editedSuiteName.trim() && editedSuiteName !== suiteName) {
      setSuiteName(editedSuiteName.trim());
    } else {
      setEditedSuiteName(suiteName);
    }
  };

  const handleSuiteNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSuiteNameBlur();
    } else if (e.key === "Escape") {
      setIsEditingSuiteName(false);
      setEditedSuiteName(suiteName);
    }
  };

  const handleSubmit = async () => {
    if (!isAuthenticated) {
      toast.error("Please sign in to run evals");
      return;
    }

    if (selectedServers.length === 0) {
      toast.error("Please select at least one server");
      setCurrentStep(0);
      return;
    }

    if (selectedModels.length === 0) {
      toast.error("Please select at least one model");
      setCurrentStep(1);
      return;
    }

    // Collect API keys for all selected models
    const modelApiKeys: Record<string, string> = {};
    for (const model of selectedModels) {
      if (!isMCPJamProvidedModel(model.id)) {
        const key = getToken(model.provider as keyof ProviderTokens);
        if (!key) {
          toast.error(
            `Please configure your ${model.provider} API key in Settings`,
          );
          setCurrentStep(1);
          return;
        }
        modelApiKeys[model.provider] = key;
      }
    }

    if (validTestTemplates.length === 0) {
      toast.error("Please add at least one test template with a query");
      setCurrentStep(2);
      return;
    }

    if (!suiteName.trim()) {
      toast.error("Please provide a name for this test suite");
      setCurrentStep(3);
      return;
    }

    // Switch view immediately before starting the API call
    if (!inline) {
      setOpen(false);
      window.location.hash = "evals";
    } else {
      // In inline mode, call the callback to switch view immediately
      onSuccess?.();
    }

    setIsSubmitting(true);

    try {
      const accessToken = await getAccessToken();

      // Expand the matrix: each test template × each model
      const expandedTests = validTestTemplates.flatMap((template) => {
        // Generate a UUID for this test template to group variants
        const testTemplateKey = crypto.randomUUID();

        return selectedModels.map((model) => ({
          title: template.title,
          query: template.query,
          runs: template.runs,
          model: model.id,
          provider: model.provider,
          expectedToolCalls: template.expectedToolCalls,
          testTemplateKey,
        }));
      });

      const response = await fetch("/api/mcp/evals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suiteName: suiteName.trim(),
          suiteDescription: suiteDescription.trim() || undefined,
          tests: expandedTests,
          serverIds: selectedServers,
          modelApiKeys,
          convexAuthToken: accessToken,
        }),
      });

      if (!response.ok) {
        let errorMessage = "Failed to start evals";
        try {
          const result = await response.json();
          errorMessage = result.error || errorMessage;
        } catch (parseError) {
          console.error("Failed to parse error response:", parseError);
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      toast.success(result.message || "Evals started successfully!");
      setTestTemplates([buildBlankTestTemplate()]);
      setSuiteName("");
      setSuiteDescription("");
      setIsEditingSuiteName(false);
      setEditedSuiteName("");
      setCurrentStep(3);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start evals",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderStepContent = () => {
    switch (steps[currentStep].key as StepKey) {
      case "servers":
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg pb-2">Select servers to test</h3>
                <p className="text-sm text-muted-foreground pb-2">
                  Choose at least one connected MCP server. You can evaluate
                  multiple servers in the same run.
                </p>
              </div>
            </div>

            {connectedServers.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {connectedServers.map(([name, server]) => {
                  const isSelected = selectedServers.includes(name);
                  return (
                    <ServerSelectionCard
                      key={name}
                      server={server}
                      selected={isSelected}
                      onToggle={toggleServer}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">
                  No connected servers yet
                </p>
                <p className="mt-2">
                  Launch a server from the Workspaces tab to make it available
                  here. Once connected, it will appear instantly.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => {
                    window.location.hash = "servers";
                  }}
                >
                  Go to Workspaces tab
                </Button>
              </div>
            )}
          </div>
        );
      case "model":
        return (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg pb-2">Choose evaluation models</h3>
              <p className="text-sm text-muted-foreground">
                Select one or more models. Each test will run against all selected models.
              </p>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 rounded-lg border p-1 w-fit">
              <button
                type="button"
                onClick={() => setModelTab("mcpjam")}
                className={cn(
                  "rounded-md px-4 py-2 text-sm font-medium transition-colors",
                  modelTab === "mcpjam"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                MCPJam Free Models
              </button>
              <button
                type="button"
                onClick={() => setModelTab("yours")}
                className={cn(
                  "rounded-md px-4 py-2 text-sm font-medium transition-colors",
                  modelTab === "yours"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Your Providers
              </button>
            </div>

            {/* Multi-select model cards */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {availableModels
                .filter((model) =>
                  modelTab === "mcpjam"
                    ? isMCPJamProvidedModel(model.id)
                    : !isMCPJamProvidedModel(model.id)
                )
                .map((model) => {
                  const isSelected = selectedModels.some((m) => m.id === model.id);
                  const isJam = isMCPJamProvidedModel(model.id);
                  const needsApiKey = !isJam && !hasToken(model.provider as keyof ProviderTokens);

                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        setSelectedModels((prev) =>
                          isSelected
                            ? prev.filter((m) => m.id !== model.id)
                            : [...prev, model]
                        );
                      }}
                      className={cn(
                        "rounded-xl border p-4 text-left transition-colors relative",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "hover:border-primary/40",
                        needsApiKey && "opacity-60"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-sm">{model.name}</h4>
                            {isSelected && (
                              <Check className="h-4 w-4 text-primary shrink-0" />
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            by {model.provider}
                          </p>
                          {needsApiKey && (
                            <p className="text-xs text-destructive mt-2">
                              Missing API key
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
            </div>

            {selectedModels.length > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-sm font-medium">
                  {selectedModels.length} model{selectedModels.length === 1 ? "" : "s"} selected
                </p>
              </div>
            )}
          </div>
        );
      case "tests":
        return (
          <div className="space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg pb-2">Define your test cases</h3>
                <p className="text-sm text-muted-foreground">
                  Create testing scenarios that simulate how real users would
                  use your server.
                </p>
              </div>
              {stepCompletion.servers && stepCompletion.model && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleGenerateTests}
                  disabled={isGenerating}
                >
                  {isGenerating ? "Generating..." : "Generate tests"}
                  <Sparkles className="h-4 w-4 ml-2" />
                </Button>
              )}
            </div>

            {!stepCompletion.servers || !stepCompletion.model ? (
              testTemplates.length > 0 && testTemplates.some(t => t.query.trim().length > 0) ? (
                // If tests already exist (e.g., after generation), show them even if prereqs changed
                <div className="space-y-12">
                  {testTemplates.map((template, index) => (
                    <div
                      key={index}
                      className="space-y-3 rounded-lg border bg-background p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col flex-1 space-y-2">
                          <Label className="text-xs uppercase text-muted-foreground">
                            Title
                          </Label>
                          <Input
                            className="w-full"
                            value={template.title}
                            onChange={(event) =>
                              handleUpdateTestTemplate(
                                index,
                                "title",
                                event.target.value,
                              )
                            }
                            placeholder="(Paypal) List transactions"
                          />
                        </div>
                        {testTemplates.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveTestTemplate(index)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs uppercase text-muted-foreground">
                          Query
                        </Label>
                        <Textarea
                          value={template.query}
                          onChange={(event) =>
                            handleUpdateTestTemplate(
                              index,
                              "query",
                              event.target.value,
                            )
                          }
                          placeholder="Can you find the most recent Paypal transactions, then create an invoice?"
                          rows={3}
                        />
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label className="text-xs uppercase text-muted-foreground">
                            Runs
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            value={template.runs}
                            onChange={(event) =>
                              handleUpdateTestTemplate(
                                index,
                                "runs",
                                Number(event.target.value) > 0
                                  ? Number(event.target.value)
                                  : 1,
                              )
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs uppercase text-muted-foreground">
                            Expected tools (JSON format)
                          </Label>
                          <Textarea
                            defaultValue={
                              template.expectedToolCalls.length === 0
                                ? ""
                                : JSON.stringify(template.expectedToolCalls, null, 2)
                            }
                            onBlur={(event) => {
                              const value = event.target.value.trim();
                              if (value === "") {
                                handleUpdateTestTemplate(
                                  index,
                                  "expectedToolCalls",
                                  [],
                                );
                                return;
                              }

                              try {
                                const parsed = JSON.parse(value);
                                if (Array.isArray(parsed)) {
                                  // Validate structure
                                  const valid = parsed.every(
                                    (item) =>
                                      typeof item === "object" &&
                                      item !== null &&
                                      typeof item.toolName === "string"
                                  );
                                  if (valid) {
                                    // Ensure arguments field exists
                                    const normalized = parsed.map((item) => ({
                                      toolName: item.toolName,
                                      arguments: item.arguments || {},
                                    }));
                                    handleUpdateTestTemplate(
                                      index,
                                      "expectedToolCalls",
                                      normalized,
                                    );
                                  }
                                }
                              } catch {
                                // Invalid JSON, keep existing value
                              }
                            }}
                            placeholder={`[
  { "toolName": "add", "arguments": { "a": 5, "b": 3 } }
]`}
                            rows={6}
                            className="font-mono text-xs"
                          />
                          <p className="text-xs text-muted-foreground">
                            Specify tool names and their expected arguments. Leave arguments empty {} to skip argument checking.
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleAddTestTemplate}
                    aria-label="Add test template"
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add test template
                  </Button>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">
                    Finish previous steps first
                  </p>
                  <p className="mt-2">
                    Select at least one server and choose a model to unlock test
                    authoring. That ensures generated tests know which stack to
                    target.
                  </p>
                </div>
              )
            ) : (
              <>
                {isGenerating && (
                  <div className="flex items-center justify-center rounded-lg border p-6">
                    <div className="text-center text-sm text-muted-foreground">
                      Generating test cases...
                    </div>
                  </div>
                )}

                {!isGenerating && (
                  <div className="space-y-12">
                    {testTemplates.map((template, index) => (
                      <div
                        key={index}
                        className="space-y-3 rounded-lg border bg-background p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex flex-col flex-1 space-y-2">
                            <Label className="text-xs uppercase text-muted-foreground">
                              Title
                            </Label>
                            <Input
                              className="w-full"
                              value={template.title}
                              onChange={(event) =>
                                handleUpdateTestTemplate(
                                  index,
                                  "title",
                                  event.target.value,
                                )
                              }
                              placeholder="(Paypal) List transactions"
                            />
                          </div>
                          {testTemplates.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveTestTemplate(index)}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label className="text-xs uppercase text-muted-foreground">
                            Query
                          </Label>
                          <Textarea
                            value={template.query}
                            onChange={(event) =>
                              handleUpdateTestTemplate(
                                index,
                                "query",
                                event.target.value,
                              )
                            }
                            placeholder="Can you find the most recent Paypal transactions, then create an invoice?"
                            rows={3}
                          />
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label className="text-xs uppercase text-muted-foreground">
                              Runs
                            </Label>
                            <Input
                              type="number"
                              min={1}
                              value={template.runs}
                              onChange={(event) =>
                                handleUpdateTestTemplate(
                                  index,
                                  "runs",
                                  Number(event.target.value) > 0
                                    ? Number(event.target.value)
                                    : 1,
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs uppercase text-muted-foreground">
                              Expected tools (JSON format)
                            </Label>
                            <Textarea
                              defaultValue={
                                template.expectedToolCalls.length === 0
                                  ? ""
                                  : JSON.stringify(template.expectedToolCalls, null, 2)
                              }
                              onBlur={(event) => {
                                const value = event.target.value.trim();
                                if (value === "") {
                                  handleUpdateTestTemplate(
                                    index,
                                    "expectedToolCalls",
                                    [],
                                  );
                                  return;
                                }

                                try {
                                  const parsed = JSON.parse(value);
                                  if (Array.isArray(parsed)) {
                                    // Validate structure
                                    const valid = parsed.every(
                                      (item) =>
                                        typeof item === "object" &&
                                        item !== null &&
                                        typeof item.toolName === "string"
                                    );
                                    if (valid) {
                                      // Ensure arguments field exists
                                      const normalized = parsed.map((item) => ({
                                        toolName: item.toolName,
                                        arguments: item.arguments || {},
                                      }));
                                      handleUpdateTestTemplate(
                                        index,
                                        "expectedToolCalls",
                                        normalized,
                                      );
                                    }
                                  }
                                } catch {
                                  // Invalid JSON, keep existing value
                                }
                              }}
                              placeholder={`[
  { "toolName": "add", "arguments": { "a": 5, "b": 3 } }
]`}
                              rows={6}
                              className="font-mono text-xs"
                            />
                            <p className="text-xs text-muted-foreground">
                              Specify tool names and their expected arguments. Leave arguments empty {} to skip argument checking.
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleAddTestTemplate}
                      aria-label="Add test template"
                      className="w-full"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add test template
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      case "review":
        const totalTestCases = validTestTemplates.length * selectedModels.length;

        return (
          <div className="space-y-6">
            <div className="space-y-4">
              {isEditingSuiteName ? (
                <input
                  type="text"
                  value={editedSuiteName}
                  onChange={(e) => setEditedSuiteName(e.target.value)}
                  onBlur={handleSuiteNameBlur}
                  onKeyDown={handleSuiteNameKeyDown}
                  autoFocus
                  className="w-full px-3 py-2 text-lg font-semibold border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-background"
                  placeholder="New Test Suite"
                />
              ) : (
                <Button
                  variant="ghost"
                  onClick={handleSuiteNameClick}
                  className="w-full justify-start px-3 py-2 h-auto text-lg font-semibold hover:bg-accent border border-transparent hover:border-input rounded-md"
                >
                  {suiteName || (
                    <span className="text-muted-foreground">
                      New Test Suite
                    </span>
                  )}
                </Button>
              )}
              <Textarea
                value={suiteDescription}
                onChange={(event) => setSuiteDescription(event.target.value)}
                rows={3}
                placeholder="What does this suite cover?"
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <h3 className="text-lg">Review your configuration</h3>
              <p className="text-sm text-muted-foreground">
                After confirming the run, you will see your run begin in the
                eval results tab.
              </p>
            </div>

            <div className="space-y-4 rounded-lg border bg-background p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Servers
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedServers.map((server) => (
                      <Badge key={server} variant="outline">
                        {server}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentStep(0)}
                >
                  Edit
                </Button>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Models
                  </p>
                  {selectedModels.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedModels.map((model) => (
                        <Badge key={model.id} variant="outline">
                          {model.name}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No models selected
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentStep(1)}
                >
                  Edit
                </Button>
              </div>
              <Separator />
              <div className="flex items-start justify-between gap-6">
                <div className="flex-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    Test Templates
                  </p>
                  <div className="mt-3 space-y-3">
                    {validTestTemplates.map((template, index) => (
                      <div
                        key={index}
                        className="rounded-md border bg-muted/30 p-3"
                      >
                        <p className="text-sm font-semibold text-foreground">
                          {template.title}
                        </p>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {template.query}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>
                            {template.runs} run{template.runs === 1 ? "" : "s"}
                          </span>
                          {template.expectedToolCalls.length > 0 && (
                            <span>
                              Tools: {template.expectedToolCalls.map(tc => tc.toolName).join(", ")}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentStep(2)}
                >
                  Edit
                </Button>
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const stepper = (
    <ol className="flex flex-col items-center gap-4 text-center md:flex-row md:gap-6">
      {steps.map((step, index) => {
        const isActive = currentStep === index;
        const isCompleted =
          index < currentStep && index <= highestAvailableStep;
        const isSelectable =
          index <= Math.max(highestAvailableStep, currentStep);
        return (
          <li key={step.key} className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => (isSelectable ? setCurrentStep(index) : undefined)}
              disabled={!isSelectable}
              className={cn(
                "flex flex-col items-center gap-2 transition",
                !isSelectable && "cursor-not-allowed opacity-60",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border text-sm font-medium",
                  isCompleted &&
                    "border-primary bg-primary text-primary-foreground",
                  isActive &&
                    !isCompleted &&
                    "border-primary bg-primary/10 text-primary",
                  !isActive &&
                    !isCompleted &&
                    "border-border text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <span
                className={cn(
                  "text-xs leading-tight",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.title}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  const nextDisabled =
    currentStep < steps.length - 1 ? !canAdvance : isSubmitting || !canAdvance;

  const nextVariant = nextDisabled ? "secondary" : "default";

  const wizardLayout = (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-8 pb-10 pt-4",
        inline ? "max-w-none px-4 sm:px-6 md:px-12 lg:px-32" : "max-w-3xl px-4",
      )}
    >
      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="button"
          variant="outline"
          onClick={handleBack}
          disabled={currentStep === 0}
          aria-label="Back"
          className="justify-center gap-2"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <div className="flex flex-1 justify-center">
          <div className="max-w-xl">{stepper}</div>
        </div>
        <Button
          type="button"
          variant={nextVariant}
          onClick={() => {
            if (currentStep < steps.length - 1) {
              posthog.capture("eval_setup_next_step_button_clicked", {
                location: "eval_runner",
                platform: detectPlatform(),
                environment: detectEnvironment(),
                step: currentStep,
              });
              handleNext();
            } else {
              posthog.capture("eval_setup_start_eval_run_button_clicked", {
                location: "eval_runner",
                platform: detectPlatform(),
                environment: detectEnvironment(),
                step: currentStep,
              });
              void handleSubmit();
            }
          }}
          disabled={nextDisabled}
          aria-label={currentStep === steps.length - 1 ? "Start" : "Next"}
          className={cn("justify-center gap-2", !nextDisabled && "shadow-sm")}
        >
          {currentStep === steps.length - 1 ? "Start" : "Next"}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-6">{renderStepContent()}</div>
    </div>
  );

  if (inline) {
    return wizardLayout;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New eval run
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] w-full max-w-4xl overflow-y-auto sm:max-w-4xl">
        <DialogHeader className="mx-auto w-full max-w-3xl gap-1 text-left">
          <DialogTitle>Create eval run</DialogTitle>
          <DialogDescription>
            Follow the guided steps to configure your evaluation and run it with
            confidence.
          </DialogDescription>
        </DialogHeader>
        {wizardLayout}
      </DialogContent>
    </Dialog>
  );
}
