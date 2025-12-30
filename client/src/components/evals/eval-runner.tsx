import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
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
import { useAppState } from "@/hooks/use-app-state";
import {
  useAiProviderKeys,
  type ProviderTokens,
} from "@/hooks/use-ai-provider-keys";
import { cn } from "@/lib/utils";
import { ModelDefinition, isMCPJamProvidedModel } from "@/shared/types";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import posthog from "posthog-js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  WIZARD_STEPS,
  STORAGE_KEYS,
  DEFAULTS,
  API_ENDPOINTS,
} from "./constants";
import { ServersStep } from "./eval-runner/ServersStep";
import { ModelStep } from "./eval-runner/ModelStep";
import { TestsStep } from "./eval-runner/TestsStep";
import { ReviewStep } from "./eval-runner/ReviewStep";
import type {
  AvailableTool,
  TestTemplate,
  ExpectedToolCall,
} from "./eval-runner/types";
import { useSharedAppState } from "@/state/app-state-context";

interface EvalRunnerProps {
  availableModels: ModelDefinition[];
  inline?: boolean;
  onSuccess?: (suiteId?: string) => void;
  preselectedServer?: string;
}

type StepKey = (typeof WIZARD_STEPS)[number]["key"];

const buildBlankTestTemplate = (): TestTemplate => ({
  title: ``,
  query: "",
  runs: DEFAULTS.RUNS_PER_TEST,
  expectedToolCalls: [],
});

const buildBlankNegativeTestTemplate = (): TestTemplate => ({
  title: ``,
  query: "",
  runs: DEFAULTS.RUNS_PER_TEST,
  expectedToolCalls: [],
  isNegativeTest: true,
  scenario: "",
});

const validateExpectedToolCalls = (toolCalls: ExpectedToolCall[]): boolean => {
  // Must have at least one tool call
  if (toolCalls.length === 0) {
    return false;
  }

  // Check each tool call
  for (const toolCall of toolCalls) {
    // Tool name must not be empty
    if (!toolCall.toolName || toolCall.toolName.trim() === "") {
      return false;
    }

    // Check all argument values are not empty strings
    if (toolCall.arguments) {
      for (const value of Object.values(toolCall.arguments)) {
        // Only fail on empty strings, not other falsy values
        if (value === "") {
          return false;
        }
      }
    }
  }

  return true;
};

export function EvalRunner({
  availableModels,
  inline = false,
  onSuccess,
  preselectedServer,
}: EvalRunnerProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingNegativeTests, setIsGeneratingNegativeTests] =
    useState(false);
  // Start at step 1 (model) if server is preselected, otherwise step 0 (servers)
  const hasPreselectedServer =
    preselectedServer && preselectedServer !== "none";
  const [currentStep, setCurrentStep] = useState(hasPreselectedServer ? 1 : 0);
  const [savedPreferences, setSavedPreferences] = useState<{
    servers: string[];
    modelIds: string[];
  } | null>(null);
  const { isAuthenticated } = useConvexAuth();
  const { getAccessToken } = useAuth();
  const appState = useSharedAppState();
  const { getToken, hasToken } = useAiProviderKeys();

  // Initialize with preselected server if provided
  const [selectedServers, setSelectedServers] = useState<string[]>(() => {
    if (hasPreselectedServer) {
      return [preselectedServer];
    }
    return [];
  });
  const [selectedModels, setSelectedModels] = useState<ModelDefinition[]>([]);
  const [testTemplates, setTestTemplates] = useState<TestTemplate[]>([
    buildBlankTestTemplate(),
  ]);
  const [modelTab, setModelTab] = useState<"mcpjam" | "yours">("mcpjam");
  // Auto-name suite after server if preselected
  const [suiteName, setSuiteName] = useState(
    hasPreselectedServer ? preselectedServer : "",
  );
  const [suiteDescription, setSuiteDescription] = useState("");
  const [showNameError, setShowNameError] = useState(false);
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false);
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([]);

  // Pass/fail criteria state
  const [minimumPassRate, setMinimumPassRate] = useState<number>(
    DEFAULTS.MIN_PASS_RATE,
  );

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
      const stored = localStorage.getItem(STORAGE_KEYS.EVAL_RUNNER_PREFERENCES);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        servers?: string[];
        modelIds?: string[];
        passCriteria?: {
          minimumPassRate?: number;
        };
      };
      setSavedPreferences({
        servers: parsed.servers ?? [],
        modelIds: parsed.modelIds ?? [],
      });

      // Restore pass criteria preferences
      if (parsed.passCriteria) {
        if (parsed.passCriteria.minimumPassRate !== undefined) {
          setMinimumPassRate(parsed.passCriteria.minimumPassRate);
        }
      }
    } catch (error) {
      console.warn("Failed to load eval runner preferences", error);
    }
  }, []);

  useEffect(() => {
    if (!savedPreferences) return;
    // Don't restore server preferences if we have a preselected server
    if (hasPreselectedServer) return;

    if (savedPreferences.servers?.length) {
      const filtered = savedPreferences.servers.filter((server) =>
        connectedServerNames.has(server),
      );
      if (filtered.length) {
        setSelectedServers(filtered);
      }
    }
  }, [savedPreferences, connectedServerNames, hasPreselectedServer]);

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
        passCriteria: {
          minimumPassRate,
        },
      };
      localStorage.setItem(
        STORAGE_KEYS.EVAL_RUNNER_PREFERENCES,
        JSON.stringify(payload),
      );
    } catch (error) {
      console.warn("Failed to persist eval runner preferences", error);
    }
  }, [selectedServers, selectedModels, minimumPassRate]);

  // Fetch available tools from selected servers
  useEffect(() => {
    async function fetchTools() {
      if (selectedServers.length === 0) {
        setAvailableTools([]);
        return;
      }

      try {
        const response = await fetch(API_ENDPOINTS.LIST_TOOLS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverIds: selectedServers }),
        });

        if (response.ok) {
          const data = await response.json();
          setAvailableTools(data.tools || []);
        }
      } catch (error) {
        console.error("Failed to fetch tools:", error);
      }
    }

    fetchTools();
  }, [selectedServers]);

  useEffect(() => {
    if (!inline && !open) {
      // Reset to step 1 if preselected, otherwise step 0
      setCurrentStep(hasPreselectedServer ? 1 : 0);
      setHasRestoredPreferences(false);
    }
  }, [inline, open, hasPreselectedServer]);

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

    // Check if all valid test templates are properly configured
    // Positive tests need valid expected tool calls
    // Negative tests need scenario and query
    const allTestsAreValid = validTestTemplates.every((template) => {
      if (template.isNegativeTest) {
        // Negative tests need scenario and query
        return (
          template.query.trim().length > 0 &&
          (template.scenario?.trim().length ?? 0) > 0
        );
      }
      // Positive tests need valid expected tool calls
      return validateExpectedToolCalls(template.expectedToolCalls);
    });

    return {
      servers: selectedServers.length > 0,
      model: selectedModels.length > 0 && allModelsHaveCredentials,
      tests: validTestTemplates.length > 0 && allTestsAreValid,
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

  const handleToggleModel = (model: ModelDefinition) => {
    setSelectedModels((prev) => {
      const isSelected = prev.some((m) => m.id === model.id);
      return isSelected
        ? prev.filter((m) => m.id !== model.id)
        : [...prev, model];
    });
  };

  const handleAddTestTemplate = () => {
    setTestTemplates((prev) => [...prev, buildBlankTestTemplate()]);
  };

  const handleAddNegativeTestTemplate = () => {
    setTestTemplates((prev) => [...prev, buildBlankNegativeTestTemplate()]);
  };

  const handleRemoveTestTemplate = (index: number) => {
    setTestTemplates((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateTestTemplate = <K extends keyof TestTemplate>(
    index: number,
    field: K,
    value: TestTemplate[K],
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

      const response = await fetch(API_ENDPOINTS.EVALS_GENERATE_TESTS, {
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
        const generatedTemplates = result.tests.map(
          (test: any, index: number) => ({
            title: test.title || `Generated test ${index + 1}`,
            query: test.query || "",
            runs: Number(test.runs) > 0 ? Number(test.runs) : 1,
            expectedToolCalls: Array.isArray(test.expectedToolCalls)
              ? test.expectedToolCalls
              : [],
          }),
        );

        setTestTemplates(generatedTemplates);
        setCurrentStep(2);
        toast.success(
          `Generated ${generatedTemplates.length} test template(s).`,
        );
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

  const handleGenerateNegativeTests = async () => {
    posthog.capture("eval_generate_negative_tests_button_clicked", {
      location: "eval_runner",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      step: currentStep,
    });

    if (!isAuthenticated) {
      toast.error("Please sign in to generate negative tests");
      return;
    }

    if (selectedServers.length === 0) {
      toast.error("Please select at least one server");
      return;
    }

    setIsGeneratingNegativeTests(true);

    try {
      const accessToken = await getAccessToken();

      const response = await fetch(
        API_ENDPOINTS.EVALS_GENERATE_NEGATIVE_TESTS,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverIds: selectedServers,
            convexAuthToken: accessToken,
          }),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to generate negative tests");
      }

      if (result.tests && result.tests.length > 0) {
        const generatedNegativeTemplates: TestTemplate[] = result.tests.map(
          (test: {
            title: string;
            scenario: string;
            query: string;
            runs: number;
          }) => ({
            title: test.title || "Untitled Negative Test",
            query: test.query || "",
            runs: Number(test.runs) > 0 ? Number(test.runs) : 1,
            expectedToolCalls: [],
            isNegativeTest: true,
            scenario: test.scenario || "",
          }),
        );

        // Append to existing templates instead of replacing
        setTestTemplates((prev) => [...prev, ...generatedNegativeTemplates]);
        setCurrentStep(2);
        toast.success(
          `Generated ${generatedNegativeTemplates.length} negative test template(s).`,
        );
      }
    } catch (error) {
      console.error("Failed to generate negative tests:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to generate negative test cases",
      );
    } finally {
      setIsGeneratingNegativeTests(false);
    }
  };

  const handleNext = () => {
    if (currentStep >= WIZARD_STEPS.length - 1) return;
    if (!canAdvance) return;
    setCurrentStep((prev) => Math.min(prev + 1, WIZARD_STEPS.length - 1));
  };

  const handleBack = () => {
    if (currentStep === 0) return;
    setCurrentStep((prev) => Math.max(prev - 1, 0));
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
      setShowNameError(true);
      // Stay on current step (step 3 - review)
      return;
    }

    // Clear error state if we got this far
    setShowNameError(false);

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
          isNegativeTest: template.isNegativeTest,
          scenario: template.scenario,
          testTemplateKey,
        }));
      });

      // Build pass criteria description for notes
      const criteriaNote = `Pass Criteria: Min ${minimumPassRate}% Accuracy`;

      const response = await fetch(API_ENDPOINTS.EVALS_RUN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suiteName: suiteName.trim(),
          suiteDescription: suiteDescription.trim() || undefined,
          tests: expandedTests,
          serverIds: selectedServers,
          modelApiKeys,
          convexAuthToken: accessToken,
          passCriteria: {
            minimumPassRate: minimumPassRate,
          },
          notes: criteriaNote,
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

      // Track suite created
      posthog.capture("eval_suite_created", {
        location: "eval_runner",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        suite_id: result.suiteId,
        num_test_cases: validTestTemplates.length,
        num_models: selectedModels.length,
        num_servers: selectedServers.length,
      });

      setTestTemplates([buildBlankTestTemplate()]);
      setSuiteName("");
      setSuiteDescription("");
      setShowNameError(false);
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
    const stepKey = WIZARD_STEPS[currentStep].key as StepKey;

    switch (stepKey) {
      case "servers":
        return (
          <ServersStep
            connectedServers={connectedServers}
            selectedServers={selectedServers}
            onToggleServer={toggleServer}
          />
        );
      case "model":
        return (
          <ModelStep
            availableModels={availableModels}
            selectedModels={selectedModels}
            modelTab={modelTab}
            onModelTabChange={setModelTab}
            onToggleModel={handleToggleModel}
            hasProviderToken={hasToken}
          />
        );
      case "tests":
        return (
          <TestsStep
            testTemplates={testTemplates}
            availableTools={availableTools}
            canGenerateTests={stepCompletion.servers && stepCompletion.model}
            hasServerAndModelSelection={
              stepCompletion.servers && stepCompletion.model
            }
            isGenerating={isGenerating}
            isGeneratingNegativeTests={isGeneratingNegativeTests}
            onGenerateTests={handleGenerateTests}
            onGenerateNegativeTests={handleGenerateNegativeTests}
            onAddTestTemplate={handleAddTestTemplate}
            onAddNegativeTestTemplate={handleAddNegativeTestTemplate}
            onRemoveTestTemplate={handleRemoveTestTemplate}
            onUpdateTestTemplate={handleUpdateTestTemplate}
          />
        );
      case "review":
        return (
          <ReviewStep
            suiteName={suiteName}
            suiteDescription={suiteDescription}
            minimumPassRate={minimumPassRate}
            selectedServers={selectedServers}
            selectedModels={selectedModels}
            validTestTemplates={validTestTemplates}
            onSuiteNameChange={setSuiteName}
            onSuiteDescriptionChange={setSuiteDescription}
            onMinimumPassRateChange={setMinimumPassRate}
            onEditStep={setCurrentStep}
            showNameError={showNameError}
          />
        );
      default:
        return null;
    }
  };

  const stepper = (
    <ol className="flex flex-col items-center gap-4 text-center md:flex-row md:gap-6">
      {WIZARD_STEPS.map((step, index) => {
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
    currentStep < WIZARD_STEPS.length - 1
      ? !canAdvance
      : isSubmitting || !canAdvance;

  const nextVariant = nextDisabled ? "secondary" : "default";

  // Determine tooltip message for Next button
  const getNextButtonTooltip = (): string => {
    if (!nextDisabled) {
      return currentStep === WIZARD_STEPS.length - 1
        ? "Start the eval run"
        : "Continue to next step";
    }

    // Check if we're on the tests step and test configurations are invalid
    if (currentStep === 2) {
      // Step 2 is the tests step
      const hasInvalidPositiveTests = validTestTemplates.some(
        (template) =>
          !template.isNegativeTest &&
          !validateExpectedToolCalls(template.expectedToolCalls),
      );
      const hasInvalidNegativeTests = validTestTemplates.some(
        (template) =>
          template.isNegativeTest &&
          (!template.scenario?.trim() || !template.query.trim()),
      );

      if (hasInvalidPositiveTests) {
        return "All tool names must be specified and argument values cannot be empty";
      }
      if (hasInvalidNegativeTests) {
        return "Negative tests require both a scenario description and user prompt";
      }
    }

    // Generic messages for other disabled states
    if (currentStep === 0) {
      return "Select at least one server to continue";
    }
    if (currentStep === 1) {
      return "Select at least one model and ensure all models have API keys configured";
    }
    if (currentStep === 2) {
      return "Add at least one test case with a query to continue";
    }
    if (currentStep === 3) {
      return "Complete all required fields to start the eval run";
    }

    return "Complete the current step to continue";
  };

  const handleClose = () => {
    if (inline) {
      onSuccess?.();
    } else {
      setOpen(false);
    }
  };

  const wizardLayout = (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-8 pb-10 pt-4",
        inline ? "max-w-none px-4 sm:px-6 md:px-12 lg:px-32" : "max-w-3xl px-4",
      )}
    >
      <div className="flex flex-wrap items-center gap-4">
        {inline && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            aria-label="Close"
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
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
        {nextDisabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant={nextVariant}
                  onClick={() => {
                    if (currentStep < WIZARD_STEPS.length - 1) {
                      posthog.capture("eval_setup_next_step_button_clicked", {
                        location: "eval_runner",
                        platform: detectPlatform(),
                        environment: detectEnvironment(),
                        step: currentStep,
                      });
                      handleNext();
                    } else {
                      posthog.capture(
                        "eval_setup_start_eval_run_button_clicked",
                        {
                          location: "eval_runner",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                          step: currentStep,
                        },
                      );
                      void handleSubmit();
                    }
                  }}
                  disabled={nextDisabled}
                  aria-label={
                    currentStep === WIZARD_STEPS.length - 1 ? "Start" : "Next"
                  }
                  className={cn(
                    "justify-center gap-2",
                    !nextDisabled && "shadow-sm",
                  )}
                >
                  {currentStep === WIZARD_STEPS.length - 1 ? "Start" : "Next"}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{getNextButtonTooltip()}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            type="button"
            variant={nextVariant}
            onClick={() => {
              if (currentStep < WIZARD_STEPS.length - 1) {
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
            aria-label={
              currentStep === WIZARD_STEPS.length - 1 ? "Start" : "Next"
            }
            className={cn("justify-center gap-2", !nextDisabled && "shadow-sm")}
          >
            {currentStep === WIZARD_STEPS.length - 1 ? "Start" : "Next"}
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
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
