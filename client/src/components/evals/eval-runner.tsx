import { useState, useEffect } from "react";
import { Plus, X } from "lucide-react";
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
import { useAppState } from "@/hooks/use-app-state";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { ModelSelector } from "@/components/chat/model-selector";
import { ModelDefinition } from "@/shared/types";

interface TestCase {
  title: string;
  query: string;
  runs: number;
  model: string;
  provider: string;
  expectedToolCalls: string[];
}

interface EvalRunnerProps {
  availableModels: ModelDefinition[];
  inline?: boolean;
}

export function EvalRunner({
  availableModels,
  inline = false,
}: EvalRunnerProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isAuthenticated } = useConvexAuth();
  const { getAccessToken } = useAuth();
  const { appState } = useAppState();
  const { getToken } = useAiProviderKeys();

  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelDefinition | null>(
    availableModels[0] || null,
  );
  const [testCases, setTestCases] = useState<TestCase[]>([
    {
      title: "Test 1",
      query: "",
      runs: 1,
      model: "",
      provider: "",
      expectedToolCalls: [],
    },
  ]);

  const connectedServers = Object.entries(appState.servers).filter(
    ([, server]) => server.connectionStatus === "connected",
  );

  // Sync selectedModel when availableModels loads
  useEffect(() => {
    if (!selectedModel && availableModels.length > 0) {
      setSelectedModel(availableModels[0]);
    }
  }, [availableModels, selectedModel]);

  const handleAddTestCase = () => {
    setTestCases([
      ...testCases,
      {
        title: `Test ${testCases.length + 1}`,
        query: "",
        runs: 1,
        model: selectedModel?.id || "",
        provider: selectedModel?.provider || "",
        expectedToolCalls: [],
      },
    ]);
  };

  const handleRemoveTestCase = (index: number) => {
    setTestCases(testCases.filter((_, i) => i !== index));
  };

  const handleUpdateTestCase = (
    index: number,
    field: keyof TestCase,
    value: any,
  ) => {
    const updated = [...testCases];
    updated[index] = { ...updated[index], [field]: value };
    setTestCases(updated);
  };

  const handleSubmit = async () => {
    if (!isAuthenticated) {
      toast.error("Please sign in to run evals");
      return;
    }

    if (selectedServers.length === 0) {
      toast.error("Please select at least one server");
      return;
    }

    if (!selectedModel) {
      toast.error("Please select a model");
      return;
    }

    const apiKey = getToken(selectedModel.provider);
    if (!apiKey && selectedModel.provider !== "meta") {
      toast.error(
        `Please configure your ${selectedModel.provider} API key in Settings`,
      );
      return;
    }

    const validTestCases = testCases.filter((tc) => tc.query.trim() !== "");
    if (validTestCases.length === 0) {
      toast.error("Please add at least one test case with a query");
      return;
    }

    setIsSubmitting(true);

    try {
      const accessToken = await getAccessToken();

      const testsWithModelInfo = validTestCases.map((tc) => ({
        ...tc,
        model: selectedModel.id,
        provider: selectedModel.provider,
      }));

      const response = await fetch("/api/mcp/evals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tests: testsWithModelInfo,
          serverIds: selectedServers,
          llmConfig: {
            provider: selectedModel.provider,
            apiKey: apiKey || "router",
          },
          convexAuthToken: accessToken,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to start evals");
      }

      toast.success(result.message || "Evals started successfully!");
      setOpen(false);

      setTestCases([
        {
          title: "Test 1",
          query: "",
          runs: 1,
          model: "",
          provider: "",
          expectedToolCalls: [],
        },
      ]);
      setSelectedServers([]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start evals",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const formContent = (
    <div className="space-y-6 py-4">
      <div className="space-y-2">
        <Label>Select Servers</Label>
        <div className="flex flex-wrap gap-2">
          {connectedServers.map(([name, server]) => {
            const isSelected = selectedServers.includes(name);
            return (
              <Button
                key={name}
                type="button"
                variant={isSelected ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  if (isSelected) {
                    setSelectedServers(
                      selectedServers.filter((s) => s !== name),
                    );
                  } else {
                    setSelectedServers([...selectedServers, name]);
                  }
                }}
                className="h-9"
              >
                {name}
              </Button>
            );
          })}
        </div>
        {connectedServers.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No connected servers. Please connect a server first.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Model</Label>
        {selectedModel && (
          <ModelSelector
            currentModel={selectedModel}
            availableModels={availableModels}
            onModelChange={setSelectedModel}
            hideProvidedModels={false}
          />
        )}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label>Test Cases</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddTestCase}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Test
          </Button>
        </div>

        {testCases.map((testCase, index) => (
          <div key={index} className="p-4 border rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <Input
                value={testCase.title}
                onChange={(e) =>
                  handleUpdateTestCase(index, "title", e.target.value)
                }
                placeholder="Test title"
                className="max-w-xs"
              />
              {testCases.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveTestCase(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Query</Label>
              <Textarea
                value={testCase.query}
                onChange={(e) =>
                  handleUpdateTestCase(index, "query", e.target.value)
                }
                placeholder="Enter the test query..."
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs">Runs</Label>
                <Input
                  type="number"
                  min={1}
                  value={testCase.runs}
                  onChange={(e) =>
                    handleUpdateTestCase(
                      index,
                      "runs",
                      parseInt(e.target.value) || 1,
                    )
                  }
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">
                  Expected Tools (comma-separated)
                </Label>
                <Input
                  value={testCase.expectedToolCalls.join(", ")}
                  onChange={(e) =>
                    handleUpdateTestCase(
                      index,
                      "expectedToolCalls",
                      e.target.value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="tool1, tool2"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end space-x-2">
        {!inline && (
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
        <Button onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? "Starting..." : "Run Evals"}
        </Button>
      </div>
    </div>
  );

  if (inline) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Create Eval Run</h2>
          <p className="text-sm text-muted-foreground">
            Configure and run evaluations against your connected MCP servers
          </p>
        </div>
        {formContent}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          New Eval Run
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Eval Run</DialogTitle>
          <DialogDescription>
            Configure and run evaluations against your connected MCP servers
          </DialogDescription>
        </DialogHeader>
        {formContent}
      </DialogContent>
    </Dialog>
  );
}
